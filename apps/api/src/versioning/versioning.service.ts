/**
 * Versioning / history service (spec §3.3): an append-only record of every saved state of an
 * entity. Contracts are the first user; anything else that needs history can use it as is.
 *
 * - Versions are numbered 1, 2, 3… per entity; numbering is serialized with a transaction-level
 *   advisory lock so concurrent saves can't collide.
 * - Each snapshot is fingerprinted with SHA-256 over canonical JSON (keys sorted), which the
 *   approved contract document prints, so any later tampering is detectable.
 * - The table refuses UPDATE and DELETE (trigger in migration 0005).
 */
import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { DB, type Database, type DbOrTx } from '../db/client';
import { users } from '../db/schema';
import { entityVersions } from '../db/schema-contracts';

/** JSON with object keys sorted recursively, so equal content always hashes equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export const sha256Hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

export interface VersionRecord<T> {
  id: string;
  version: number;
  snapshot: T;
  sha256: string;
  note: string | null;
  createdBy: { id: string; displayName: string } | null;
  createdAt: Date;
}

@Injectable()
export class VersioningService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Saves a new version inside the caller's transaction and returns it. */
  async record<T>(
    tx: DbOrTx,
    input: { organizationId: string; entityType: string; entityId: string; snapshot: T; userId: string | null; note?: string | null },
  ): Promise<{ id: string; version: number; sha256: string }> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${input.entityType}:${input.entityId}`}))`);
    const [last] = await tx
      .select({ version: entityVersions.version })
      .from(entityVersions)
      .where(and(eq(entityVersions.entityType, input.entityType), eq(entityVersions.entityId, input.entityId)))
      .orderBy(desc(entityVersions.version))
      .limit(1);
    const version = (last?.version ?? 0) + 1;
    const sha256 = sha256Hex(canonicalJson(input.snapshot));
    const [row] = await tx
      .insert(entityVersions)
      .values({
        organizationId: input.organizationId,
        entityType: input.entityType,
        entityId: input.entityId,
        version,
        snapshot: input.snapshot as object,
        sha256,
        note: input.note ?? null,
        createdByUserId: input.userId,
      })
      .returning({ id: entityVersions.id });
    return { id: row!.id, version, sha256 };
  }

  private select(db: DbOrTx) {
    return db
      .select({ v: entityVersions, createdByName: users.displayName })
      .from(entityVersions)
      .leftJoin(users, eq(users.id, entityVersions.createdByUserId));
  }

  private toRecord<T>(r: { v: typeof entityVersions.$inferSelect; createdByName: string | null }): VersionRecord<T> {
    return {
      id: r.v.id,
      version: r.v.version,
      snapshot: r.v.snapshot as T,
      sha256: r.v.sha256,
      note: r.v.note,
      createdBy: r.v.createdByUserId ? { id: r.v.createdByUserId, displayName: r.createdByName ?? '' } : null,
      createdAt: r.v.createdAt,
    };
  }

  async list<T>(organizationId: string, entityType: string, entityId: string, db: DbOrTx = this.db): Promise<VersionRecord<T>[]> {
    const rows = await this.select(db)
      .where(
        and(
          eq(entityVersions.organizationId, organizationId),
          eq(entityVersions.entityType, entityType),
          eq(entityVersions.entityId, entityId),
        ),
      )
      .orderBy(asc(entityVersions.version));
    return rows.map((r) => this.toRecord<T>(r));
  }

  async get<T>(organizationId: string, entityType: string, entityId: string, version?: number, db: DbOrTx = this.db): Promise<VersionRecord<T> | null> {
    const [row] = await this.select(db)
      .where(
        and(
          eq(entityVersions.organizationId, organizationId),
          eq(entityVersions.entityType, entityType),
          eq(entityVersions.entityId, entityId),
          version ? eq(entityVersions.version, version) : undefined,
        ),
      )
      .orderBy(desc(entityVersions.version))
      .limit(1);
    return row ? this.toRecord<T>(row) : null;
  }

  /** Recomputes a stored version's fingerprint; false means the content no longer matches. */
  verify(record: VersionRecord<unknown>): boolean {
    return sha256Hex(canonicalJson(record.snapshot)) === record.sha256;
  }
}
