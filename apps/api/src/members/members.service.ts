import { Inject, Injectable } from '@nestjs/common';
import type { AssignmentDto, MemberDto, RoleAssignmentInput } from '@esports/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { AccessService } from '../authz/access.service.js';
import type { TenantContext } from '../authz/context.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionService } from '../auth/session.service.js';
import { Errors } from '../common/errors.js';
import { DB, type Database, type DbOrTx } from '../db/client.js';
import {
  departments,
  organizationMembers,
  roles,
  teams,
  userRoleAssignments,
  users,
} from '../db/schema.js';
import { NotificationService } from '../notifications/notification.service.js';
import { normalizeAssignments } from './assignments.js';

@Injectable()
export class MembersService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    private readonly notifications: NotificationService,
  ) {}

  async list(organizationId: string): Promise<MemberDto[]> {
    const members = await this.db
      .select({ m: organizationMembers, u: { email: users.email, displayName: users.displayName } })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(eq(organizationMembers.organizationId, organizationId))
      .orderBy(asc(users.displayName));
    const assignments = await this.assignmentsFor(this.db, organizationId);
    return members.map(({ m, u }) => {
      const mine = assignments.filter((a) => a.userId === m.userId);
      return {
        userId: m.userId,
        email: u.email,
        displayName: u.displayName,
        status: m.status,
        suspendedAt: m.suspendedAt?.toISOString() ?? null,
        suspendedReason: m.suspendedReason,
        joinedAt: m.joinedAt.toISOString(),
        isOwner: mine.some((a) => a.grantsAll),
        assignments: mine
          .filter((a) => !a.grantsAll)
          .map(({ userId: _u, grantsAll: _g, ...dto }) => dto),
      };
    });
  }

  async get(organizationId: string, userId: string): Promise<MemberDto> {
    const member = (await this.list(organizationId)).find((m) => m.userId === userId);
    if (!member) throw Errors.notFound('Member');
    return member;
  }

  private async assignmentsFor(
    db: DbOrTx,
    organizationId: string,
    userId?: string,
  ): Promise<(AssignmentDto & { userId: string; grantsAll: boolean })[]> {
    const rows = await db
      .select({
        a: userRoleAssignments,
        role: { nameEn: roles.nameEn, nameAr: roles.nameAr, grantsAll: roles.grantsAll },
        deptName: departments.name,
        teamName: teams.name,
      })
      .from(userRoleAssignments)
      .innerJoin(roles, eq(roles.id, userRoleAssignments.roleId))
      .leftJoin(departments, eq(departments.id, userRoleAssignments.departmentId))
      .leftJoin(teams, eq(teams.id, userRoleAssignments.teamId))
      .where(
        and(
          eq(userRoleAssignments.organizationId, organizationId),
          userId ? eq(userRoleAssignments.userId, userId) : undefined,
        ),
      )
      .orderBy(asc(userRoleAssignments.createdAt));
    return rows.map(({ a, role, deptName, teamName }) => ({
      id: a.id,
      userId: a.userId,
      grantsAll: role.grantsAll,
      roleId: a.roleId,
      roleNameEn: role.nameEn,
      roleNameAr: role.nameAr,
      scopeType: a.scopeType,
      scopeId: a.departmentId ?? a.teamId,
      scopeName: deptName ?? teamName ?? null,
    }));
  }

  /** Locks the org's Owner role row so concurrent ownership changes serialize. */
  private async lockOwnerRole(tx: DbOrTx, organizationId: string): Promise<string> {
    const [row] = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.organizationId, organizationId), eq(roles.isSystem, true)))
      .for('update');
    if (!row) throw new Error(`Organization ${organizationId} has no Owner role`);
    return row.id;
  }

  private async activeOwnerIds(
    tx: DbOrTx,
    organizationId: string,
    ownerRoleId: string,
  ): Promise<string[]> {
    const rows = await tx
      .select({ userId: userRoleAssignments.userId })
      .from(userRoleAssignments)
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.organizationId, userRoleAssignments.organizationId),
          eq(organizationMembers.userId, userRoleAssignments.userId),
        ),
      )
      .where(
        and(
          eq(userRoleAssignments.organizationId, organizationId),
          eq(userRoleAssignments.roleId, ownerRoleId),
          eq(organizationMembers.status, 'active'),
        ),
      );
    return rows.map((r) => r.userId);
  }

  private async requireMember(tx: DbOrTx, organizationId: string, userId: string) {
    const [m] = await tx
      .select()
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, organizationId),
          eq(organizationMembers.userId, userId),
        ),
      );
    if (!m) throw Errors.notFound('Member');
    return m;
  }

  /** Replaces the member's (non-Owner) role assignments. Ownership is managed separately. */
  async setAssignments(
    ctx: TenantContext,
    userId: string,
    inputs: RoleAssignmentInput[],
  ): Promise<MemberDto> {
    const before = await this.get(ctx.organizationId, userId);
    await this.db.transaction(async (tx) => {
      await this.requireMember(tx, ctx.organizationId, userId);
      const { valid } = await normalizeAssignments(tx, ctx.organizationId, inputs);
      const nonSystemRoleIds = (
        await tx
          .select({ id: roles.id })
          .from(roles)
          .where(and(eq(roles.organizationId, ctx.organizationId), eq(roles.isSystem, false)))
      ).map((r) => r.id);
      if (nonSystemRoleIds.length) {
        await tx
          .delete(userRoleAssignments)
          .where(
            and(
              eq(userRoleAssignments.organizationId, ctx.organizationId),
              eq(userRoleAssignments.userId, userId),
              inArray(userRoleAssignments.roleId, nonSystemRoleIds),
            ),
          );
      }
      if (valid.length) {
        await tx.insert(userRoleAssignments).values(
          valid.map((a) => ({
            ...a,
            organizationId: ctx.organizationId,
            userId,
            createdByUserId: ctx.user.id,
          })),
        );
      }
      await this.audit.fromCtx(
        ctx,
        'member.assignments_changed',
        { type: 'user', id: userId },
        {
          before: before.assignments.map(({ roleId, scopeType, scopeId }) => ({
            roleId,
            scopeType,
            scopeId,
          })),
          after: valid.map((a) => ({
            roleId: a.roleId,
            scopeType: a.scopeType,
            scopeId: a.departmentId ?? a.teamId,
          })),
        },
        tx,
      );
      if (userId !== ctx.user.id) {
        await this.notifications.notify(
          {
            organizationId: ctx.organizationId,
            recipientUserIds: [userId],
            type: 'member.roles_changed',
            data: { byName: ctx.user.displayName },
          },
          tx,
        );
      }
    });
    await this.access.invalidate(ctx.organizationId);
    return this.get(ctx.organizationId, userId);
  }

  async suspend(
    ctx: TenantContext,
    userId: string,
    reason: string | undefined,
  ): Promise<MemberDto> {
    if (userId === ctx.user.id)
      throw Errors.badRequest('cannot_target_self', 'You cannot suspend yourself');
    await this.db.transaction(async (tx) => {
      const ownerRoleId = await this.lockOwnerRole(tx, ctx.organizationId);
      const member = await this.requireMember(tx, ctx.organizationId, userId);
      if (member.status === 'suspended') return;
      const owners = await this.activeOwnerIds(tx, ctx.organizationId, ownerRoleId);
      if (owners.includes(userId) && owners.length <= 1) {
        throw Errors.conflict('last_owner', 'The organization must keep at least one active Owner');
      }
      await tx
        .update(organizationMembers)
        .set({
          status: 'suspended',
          suspendedAt: new Date(),
          suspendedByUserId: ctx.user.id,
          suspendedReason: reason ?? null,
        })
        .where(
          and(
            eq(organizationMembers.organizationId, ctx.organizationId),
            eq(organizationMembers.userId, userId),
          ),
        );
      await this.audit.fromCtx(
        ctx,
        'member.suspended',
        { type: 'user', id: userId },
        { reason: reason ?? null },
        tx,
      );
    });
    // After commit: invalidate cached permissions, then kill live sessions in this org.
    await this.access.invalidate(ctx.organizationId);
    const revoked = await this.sessions.destroyAllForUser(userId, {
      organizationId: ctx.organizationId,
    });
    if (revoked) {
      await this.audit.fromCtx(
        ctx,
        'member.sessions_revoked',
        { type: 'user', id: userId },
        { revoked },
      );
    }
    return this.get(ctx.organizationId, userId);
  }

  async reactivate(ctx: TenantContext, userId: string): Promise<MemberDto> {
    await this.db.transaction(async (tx) => {
      const member = await this.requireMember(tx, ctx.organizationId, userId);
      if (member.status === 'active') return;
      await tx
        .update(organizationMembers)
        .set({
          status: 'active',
          suspendedAt: null,
          suspendedByUserId: null,
          suspendedReason: null,
        })
        .where(
          and(
            eq(organizationMembers.organizationId, ctx.organizationId),
            eq(organizationMembers.userId, userId),
          ),
        );
      await this.audit.fromCtx(ctx, 'member.reactivated', { type: 'user', id: userId }, {}, tx);
      await this.notifications.notify(
        {
          organizationId: ctx.organizationId,
          recipientUserIds: [userId],
          type: 'member.reactivated',
          data: { byName: ctx.user.displayName },
        },
        tx,
      );
    });
    await this.access.invalidate(ctx.organizationId);
    return this.get(ctx.organizationId, userId);
  }

  async grantOwnership(ctx: TenantContext, userId: string): Promise<MemberDto> {
    await this.db.transaction(async (tx) => {
      const ownerRoleId = await this.lockOwnerRole(tx, ctx.organizationId);
      const member = await this.requireMember(tx, ctx.organizationId, userId);
      if (member.status !== 'active')
        throw Errors.badRequest('validation_failed', 'Reactivate the member first');
      const owners = await this.activeOwnerIds(tx, ctx.organizationId, ownerRoleId);
      if (owners.includes(userId)) return;
      await tx.insert(userRoleAssignments).values({
        organizationId: ctx.organizationId,
        userId,
        roleId: ownerRoleId,
        scopeType: 'organization',
        createdByUserId: ctx.user.id,
      });
      await this.audit.fromCtx(
        ctx,
        'member.ownership_granted',
        { type: 'user', id: userId },
        {},
        tx,
      );
      await this.notifications.notify(
        {
          organizationId: ctx.organizationId,
          recipientUserIds: [userId],
          type: 'member.ownership_granted',
          data: { byName: ctx.user.displayName },
        },
        tx,
      );
    });
    await this.access.invalidate(ctx.organizationId);
    return this.get(ctx.organizationId, userId);
  }

  async revokeOwnership(ctx: TenantContext, userId: string): Promise<MemberDto> {
    await this.db.transaction(async (tx) => {
      const ownerRoleId = await this.lockOwnerRole(tx, ctx.organizationId);
      await this.requireMember(tx, ctx.organizationId, userId);
      const owners = await this.activeOwnerIds(tx, ctx.organizationId, ownerRoleId);
      const [held] = await tx
        .select({ id: userRoleAssignments.id })
        .from(userRoleAssignments)
        .where(
          and(
            eq(userRoleAssignments.organizationId, ctx.organizationId),
            eq(userRoleAssignments.userId, userId),
            eq(userRoleAssignments.roleId, ownerRoleId),
          ),
        );
      if (!held) return;
      if (owners.includes(userId) && owners.length <= 1) {
        throw Errors.conflict('last_owner', 'The organization must keep at least one active Owner');
      }
      await tx.delete(userRoleAssignments).where(eq(userRoleAssignments.id, held.id));
      await this.audit.fromCtx(
        ctx,
        'member.ownership_revoked',
        { type: 'user', id: userId },
        {},
        tx,
      );
      if (userId !== ctx.user.id) {
        await this.notifications.notify(
          {
            organizationId: ctx.organizationId,
            recipientUserIds: [userId],
            type: 'member.ownership_revoked',
            data: { byName: ctx.user.displayName },
          },
          tx,
        );
      }
    });
    await this.access.invalidate(ctx.organizationId);
    return this.get(ctx.organizationId, userId);
  }
}
