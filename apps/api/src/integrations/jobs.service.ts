/**
 * Durable integration job queue in Postgres (no extra infrastructure).
 *
 * - `enqueue` coalesces: while a job with the same (connection, dedupe key) is still pending, a
 *   second one isn't added (ten quick edits to a meeting become one push).
 * - `claim` takes due jobs with FOR UPDATE SKIP LOCKED, so several API instances share the
 *   queue without running a job twice; a job whose worker died is reclaimed after its lock ends.
 * - Retries use truncated exponential backoff with jitter. Sync jobs: 30 s, 2 min, 10 min,
 *   30 min, 2 h, 6 h, then the job is dead (7 attempts). Webhook deliveries follow the Standard
 *   Webhooks schedule: 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 14 h, 20 h, 24 h (10 attempts).
 *   A provider's Retry-After is honoured, and a rate-limit deferral doesn't use up an attempt.
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { NOW, type Now } from '../common/now';
import { DB, type Database, type DbOrTx } from '../db/client';
import { integrationJobs } from '../db/schema-meetings';

export type JobKind = 'push_meeting' | 'pull' | 'full_sync' | 'deliver_webhook' | 'renew_channel';
export type JobRow = typeof integrationJobs.$inferSelect;

const SYNC_BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 7_200_000, 21_600_000];
const WEBHOOK_BACKOFF_MS = [
  5_000, 300_000, 1_800_000, 7_200_000, 18_000_000, 36_000_000, 50_400_000, 72_000_000, 86_400_000,
];
const LOCK_MS = 5 * 60_000;

export function backoffFor(kind: string, attempt: number): number | null {
  const table = kind === 'deliver_webhook' ? WEBHOOK_BACKOFF_MS : SYNC_BACKOFF_MS;
  const base = table[attempt - 1];
  if (base === undefined) return null; // no attempts left
  const jitter = 1 + (Math.random() * 0.2 - 0.1); // ±10%
  return Math.round(base * jitter);
}

export const maxAttempts = (kind: string) =>
  (kind === 'deliver_webhook' ? WEBHOOK_BACKOFF_MS : SYNC_BACKOFF_MS).length + 1;

@Injectable()
export class JobsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(NOW) private readonly now: Now,
  ) {}

  async enqueue(
    job: {
      organizationId: string;
      connectionId: string;
      kind: JobKind;
      meetingId?: string | null;
      payload?: Record<string, unknown>;
      dedupeKey?: string | null;
      delayMs?: number;
    },
    tx: DbOrTx = this.db,
  ): Promise<string | null> {
    const rows = await tx
      .insert(integrationJobs)
      .values({
        organizationId: job.organizationId,
        connectionId: job.connectionId,
        kind: job.kind,
        meetingId: job.meetingId ?? null,
        payload: job.payload ?? {},
        dedupeKey: job.dedupeKey ?? null,
        nextAttemptAt: new Date(this.now() + (job.delayMs ?? 0)),
      })
      .onConflictDoNothing({
        target: [integrationJobs.connectionId, integrationJobs.dedupeKey],
        where: sql`${integrationJobs.status} = 'pending' and ${integrationJobs.dedupeKey} is not null`,
      })
      .returning({ id: integrationJobs.id });
    return rows[0]?.id ?? null;
  }

  /** Locks and returns up to `limit` due jobs (status running, attempts + 1). */
  async claim(limit = 20, at = this.now()): Promise<JobRow[]> {
    const now = new Date(at).toISOString();
    const lockUntil = new Date(at + LOCK_MS).toISOString();
    const result = await this.db.execute(sql`
      update app.integration_jobs j
         set status = 'running', attempts = j.attempts + 1,
             locked_until = ${lockUntil}::timestamptz, updated_at = ${now}::timestamptz
       where j.id in (
         select id from app.integration_jobs
          where (status = 'pending' and next_attempt_at <= ${now}::timestamptz)
             or (status = 'running' and locked_until < ${now}::timestamptz)
          order by next_attempt_at
          limit ${limit}
          for update skip locked)
      returning j.id`);
    const ids = (result as unknown as { id: string }[]).map((r) => r.id);
    if (!ids.length) return [];
    return this.db.select().from(integrationJobs).where(inArray(integrationJobs.id, ids));
  }

  async complete(id: string) {
    await this.db
      .update(integrationJobs)
      .set({
        status: 'done',
        finishedAt: new Date(this.now()),
        lockedUntil: null,
        updatedAt: new Date(this.now()),
      })
      .where(eq(integrationJobs.id, id));
  }

  /** Schedules another attempt, or marks the job dead. Returns the delay, or null if dead. */
  async retry(job: JobRow, error: string, retryAfterMs?: number): Promise<number | null> {
    const delay = backoffFor(job.kind, job.attempts);
    if (delay === null) {
      await this.dead(job.id, error);
      return null;
    }
    const wait = Math.max(delay, retryAfterMs ?? 0);
    await this.reschedule(job.id, wait, error);
    return wait;
  }

  /** Waits without using up an attempt (rate limits). */
  async defer(job: JobRow, waitMs: number, reason: string) {
    await this.db
      .update(integrationJobs)
      .set({
        status: 'pending',
        attempts: sql`greatest(${integrationJobs.attempts} - 1, 0)`,
        nextAttemptAt: new Date(this.now() + waitMs),
        lockedUntil: null,
        lastError: reason.slice(0, 500),
        updatedAt: new Date(this.now()),
      })
      .where(eq(integrationJobs.id, job.id));
  }

  async dead(id: string, error: string) {
    await this.db
      .update(integrationJobs)
      .set({
        status: 'dead',
        lastError: error.slice(0, 500),
        finishedAt: new Date(this.now()),
        lockedUntil: null,
        updatedAt: new Date(this.now()),
      })
      .where(eq(integrationJobs.id, id));
  }

  private async reschedule(id: string, waitMs: number, error: string) {
    await this.db
      .update(integrationJobs)
      .set({
        status: 'pending',
        nextAttemptAt: new Date(this.now() + waitMs),
        lockedUntil: null,
        lastError: error.slice(0, 500),
        updatedAt: new Date(this.now()),
      })
      .where(eq(integrationJobs.id, id));
  }

  /** Drops queued work for a connection (disconnect, pause). */
  async cancelPending(connectionId: string) {
    await this.db
      .update(integrationJobs)
      .set({ status: 'dead', lastError: 'connection_stopped', finishedAt: new Date(this.now()) })
      .where(
        and(eq(integrationJobs.connectionId, connectionId), eq(integrationJobs.status, 'pending')),
      );
  }

  async pendingCount(connectionId: string): Promise<number> {
    const [r] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(integrationJobs)
      .where(
        and(
          eq(integrationJobs.connectionId, connectionId),
          inArray(integrationJobs.status, ['pending', 'running']),
        ),
      );
    return r?.n ?? 0;
  }
}
