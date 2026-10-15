/**
 * Shared audit log. One table, used by every module for permission-sensitive actions (role
 * changes, membership changes, approvals, contract status changes, budget overrides, security
 * events). Rows are append-only — the database rejects UPDATE/DELETE (migration 0001).
 *
 * Pass the transaction (`tx`) when logging alongside a mutation so the log entry commits or rolls
 * back with the change it describes.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { AuditLogDto } from '@esports/shared';
import { and, desc, eq, lt, type SQL } from 'drizzle-orm';
import type { AuthContext, ClientMeta } from '../authz/context';
import { DB, type Database, type DbOrTx } from '../db/client';
import { auditLogs, users } from '../db/schema';

export interface AuditEntry {
  organizationId: string | null;
  actorUserId: string | null;
  actorType: 'user' | 'platform_admin' | 'system' | 'anonymous';
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async log(entry: AuditEntry, tx: DbOrTx = this.db): Promise<void> {
    await tx.insert(auditLogs).values({
      organizationId: entry.organizationId,
      actorUserId: entry.actorUserId,
      actorType: entry.actorType,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      metadata: entry.metadata ?? {},
      ip: entry.ip ?? null,
      userAgent: entry.userAgent ?? null,
    });
  }

  /** Convenience for the common case: an authenticated user acting in their active org. */
  fromCtx(
    ctx: AuthContext,
    action: string,
    target: { type: string; id: string } | null,
    metadata: Record<string, unknown> = {},
    tx?: DbOrTx,
  ): Promise<void> {
    return this.log(
      {
        organizationId: ctx.organizationId,
        actorUserId: ctx.user.id,
        actorType: 'user',
        action,
        targetType: target?.type ?? null,
        targetId: target?.id ?? null,
        metadata,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      },
      tx,
    );
  }

  /** Security event before/without authentication (failed logins, reset requests…). */
  security(
    action: string,
    meta: ClientMeta,
    fields: { userId?: string | null; organizationId?: string | null; metadata?: Record<string, unknown> } = {},
  ): Promise<void> {
    return this.log({
      organizationId: fields.organizationId ?? null,
      actorUserId: fields.userId ?? null,
      actorType: fields.userId ? 'user' : 'anonymous',
      action,
      targetType: fields.userId ? 'user' : null,
      targetId: fields.userId ?? null,
      metadata: fields.metadata ?? {},
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  async list(
    organizationId: string | null,
    q: { action?: string; actorUserId?: string; targetType?: string; before?: string; limit: number },
  ): Promise<AuditLogDto[]> {
    const conds: SQL[] = [];
    if (organizationId) conds.push(eq(auditLogs.organizationId, organizationId));
    if (q.action) conds.push(eq(auditLogs.action, q.action));
    if (q.actorUserId) conds.push(eq(auditLogs.actorUserId, q.actorUserId));
    if (q.targetType) conds.push(eq(auditLogs.targetType, q.targetType));
    if (q.before) conds.push(lt(auditLogs.createdAt, new Date(q.before)));

    const rows = await this.db
      .select({ log: auditLogs, actorName: users.displayName })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.actorUserId))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(q.limit);

    return rows.map(({ log, actorName }) => ({
      id: String(log.id),
      action: log.action,
      actor: log.actorUserId ? { id: log.actorUserId, displayName: actorName ?? '' } : null,
      actorType: log.actorType,
      targetType: log.targetType,
      targetId: log.targetId,
      metadata: log.metadata,
      ip: log.ip,
      createdAt: log.createdAt.toISOString(),
    }));
  }
}
