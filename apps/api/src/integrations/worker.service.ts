/**
 * Runs integration work:
 * - listens to meeting changes and queues pushes (calendars, Notion) and webhook deliveries;
 * - processes due jobs on every scheduler tick, classifying failures (integrations/errors.ts):
 *   transient → retried with backoff; rate limited → deferred; credentials rejected → the
 *   connection is marked "error"; permanent / out of attempts → dead. Failures are logged and
 *   the owner is notified (once per failure streak);
 * - maintenance: periodic pulls (push notifications aren't guaranteed, and Notion polling is the
 *   fallback for webhooks), Google watch-channel renewal, pruning webhook receipts.
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { NOW, type Now } from '../common/now.js';
import { DB, type Database } from '../db/client.js';
import {
  integrationConnections,
  integrationLinks,
  meetingParticipants,
} from '../db/schema-meetings.js';
import { type MeetingEvent, MeetingEvents } from '../meetings/meeting-events.js';
import { MeetingsService } from '../meetings/meetings.service.js';
import { SchedulerService } from '../scheduler/scheduler.service.js';
import { type ConnectionRow, ConnectionsService } from './connections.service.js';
import { IntegrationError } from './errors.js';
import { type JobRow, JobsService } from './jobs.service.js';
import { CHANNEL_RENEW_BEFORE_MS, GoogleCalendarProvider } from './providers/google-calendar.js';
import { RemoteSyncService } from './remote-sync.service.js';
import { eventTypeFor, WebhooksService } from './webhooks.service.js';

/** How often two-way connections are pulled even without a push notification. */
export const POLL_INTERVAL_MS = {
  google_calendar: 15 * 60_000,
  google_without_channel: 5 * 60_000,
  notion: 5 * 60_000,
};

@Injectable()
export class IntegrationsWorker implements OnModuleInit {
  private readonly logger = new Logger('Integrations');

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(NOW) private readonly now: Now,
    private readonly events: MeetingEvents,
    private readonly scheduler: SchedulerService,
    private readonly connections: ConnectionsService,
    private readonly jobs: JobsService,
    private readonly sync: RemoteSyncService,
    private readonly webhooks: WebhooksService,
    private readonly google: GoogleCalendarProvider,
    private readonly meetings: MeetingsService,
  ) {}

  onModuleInit() {
    this.events.on((e) => this.onMeetingEvent(e));
    this.scheduler.register('integration-maintenance', () => this.maintenance());
    this.scheduler.register('integration-jobs', () => this.runDue());
  }

  // ---------------------------------------------------------------- meeting changes → jobs

  async onMeetingEvent(e: MeetingEvent): Promise<void> {
    const conns = await this.connections.activeInOrg(e.organizationId);
    if (!conns.length) return;
    const participants = await this.db
      .select({ userId: meetingParticipants.userId })
      .from(meetingParticipants)
      .where(eq(meetingParticipants.meetingId, e.meetingId));
    const invited = new Set(participants.map((p) => p.userId));
    const linked = new Set(
      (
        await this.db
          .select({ connectionId: integrationLinks.connectionId })
          .from(integrationLinks)
          .where(
            and(eq(integrationLinks.meetingId, e.meetingId), eq(integrationLinks.state, 'active')),
          )
      ).map((l) => l.connectionId),
    );
    for (const c of conns) {
      if (c.provider === 'obsidian' || c.provider === 'webhook_incoming') continue; // pulled by the vault script / inbound only
      if (c.provider === 'webhook_outgoing') {
        await this.queueDelivery(c, e);
        continue;
      }
      if (c.id === e.originConnectionId) continue; // the change came from there
      if (e.change.type === 'response') {
        // Responses only change what a member's own calendar shows.
        if (c.provider !== 'google_calendar' || c.ownerUserId !== e.change.userId) continue;
      }
      if (c.personal && !invited.has(c.ownerUserId) && !linked.has(c.id)) continue;
      await this.jobs.enqueue({
        organizationId: c.organizationId,
        connectionId: c.id,
        kind: 'push_meeting',
        meetingId: e.meetingId,
        dedupeKey: `push:${e.meetingId}`,
      });
    }
  }

  private async queueDelivery(c: ConnectionRow, e: MeetingEvent) {
    const type = eventTypeFor(e.change);
    const events = ((c.config as { events?: string[] }).events ?? []) as string[];
    if (!events.includes(type)) return;
    const owner = await this.connections.ownerCtx(c);
    const l = await this.meetings.load(e.organizationId, e.meetingId);
    if (!owner || !l || !this.connections.carries(c, l, owner, this.meetings)) return;
    await this.jobs.enqueue({
      organizationId: c.organizationId,
      connectionId: c.id,
      kind: 'deliver_webhook',
      meetingId: e.meetingId,
      payload: this.webhooks.payload(l, e.change),
    });
  }

  // ---------------------------------------------------------------- jobs

  /** Processes due jobs until none are left or ~20 s have passed. */
  async runDue(at?: number): Promise<number> {
    const started = Date.now();
    let done = 0;
    for (;;) {
      const batch = await this.jobs.claim(20, at ?? this.now());
      if (!batch.length) break;
      for (const job of batch) {
        await this.process(job);
        done += 1;
      }
      if (Date.now() - started > 20_000) break;
    }
    return done;
  }

  async process(job: JobRow): Promise<void> {
    const c = await this.connections.byId(job.connectionId);
    if (!c || c.status === 'disconnected' || c.status === 'error' || c.paused) {
      // Stopped connections drop their queue; resuming runs a full sync.
      await this.jobs.dead(job.id, 'connection_stopped');
      return;
    }
    try {
      switch (job.kind) {
        case 'push_meeting':
          await this.sync.pushMeeting(c, job.meetingId!);
          break;
        case 'pull':
          await this.sync.pull(c, { pageIds: (job.payload as { pageIds?: string[] }).pageIds });
          await this.db
            .update(integrationConnections)
            .set({
              cursor: sql`${integrationConnections.cursor} || ${JSON.stringify({ lastPullAt: this.now() })}::jsonb`,
            })
            .where(eq(integrationConnections.id, c.id));
          break;
        case 'full_sync':
          await this.sync.fullSync(c);
          break;
        case 'deliver_webhook':
          await this.webhooks.deliver(c, job);
          break;
        case 'renew_channel':
          if ((await this.google.watch(c)) === 'started')
            await this.connections.log(c, 'info', 'channel_renewed', 'Push notifications renewed.');
          break;
      }
      await this.jobs.complete(job.id);
      await this.connections.recordSuccess(c, job.kind !== 'deliver_webhook');
    } catch (e) {
      await this.failed(c, job, e);
    }
  }

  private async failed(c: ConnectionRow, job: JobRow, e: unknown) {
    const err =
      e instanceof IntegrationError
        ? e
        : new IntegrationError(
            'retryable',
            'internal_error',
            e instanceof Error ? e.message : String(e),
          );
    if (!(e instanceof IntegrationError))
      this.logger.error(`Job ${job.kind} ${job.id} failed: ${err.message}`);
    if (err.kind === 'rate_limited') {
      const wait = err.retryAfterMs ?? 60_000;
      await this.jobs.defer(job, wait, err.message);
      await this.connections.log(
        c,
        'info',
        'rate_limited',
        `Rate limited; waiting ${Math.ceil(wait / 1000)} s before continuing.`,
        {
          meetingId: job.meetingId,
          detail: { kind: job.kind },
        },
      );
      return;
    }
    if (err.kind === 'auth') {
      await this.jobs.dead(job.id, err.message);
      await this.jobs.cancelPending(c.id);
      await this.connections.recordFailure(c, err.code, err.message, {
        markError: true,
        meetingId: job.meetingId,
        eventCode: 'auth_failed',
      });
      return;
    }
    if (err.kind === 'retryable') {
      const wait = await this.jobs.retry(job, err.message, err.retryAfterMs);
      if (wait !== null) {
        await this.connections.log(
          c,
          'warn',
          'retry_scheduled',
          `${err.message}. Retrying in ${Math.ceil(wait / 1000)} s (attempt ${job.attempts}).`,
          {
            meetingId: job.meetingId,
            detail: { kind: job.kind, code: err.code, attempt: job.attempts },
          },
        );
        return;
      }
      await this.connections.recordFailure(
        c,
        err.code,
        `${err.message} (gave up after ${job.attempts} attempts)`,
        { meetingId: job.meetingId },
      );
      return;
    }
    await this.jobs.dead(job.id, err.message);
    await this.connections.recordFailure(c, err.code, err.message, { meetingId: job.meetingId });
  }

  // ---------------------------------------------------------------- maintenance

  async maintenance(): Promise<void> {
    const now = this.now();
    const conns = await this.db
      .select()
      .from(integrationConnections)
      .where(
        and(
          inArray(integrationConnections.provider, ['google_calendar', 'notion']),
          eq(integrationConnections.status, 'active'),
          eq(integrationConnections.paused, false),
        ),
      );
    for (const c of conns) {
      const channel = c.channel as { expiration?: number } | null;
      if (
        c.provider === 'google_calendar' &&
        channel?.expiration &&
        channel.expiration - now < CHANNEL_RENEW_BEFORE_MS
      )
        await this.jobs.enqueue({
          organizationId: c.organizationId,
          connectionId: c.id,
          kind: 'renew_channel',
          dedupeKey: 'renew',
        });
      if (c.direction !== 'two_way') continue;
      const last = Number((c.cursor as { lastPullAt?: number }).lastPullAt ?? 0);
      const every =
        c.provider === 'notion'
          ? POLL_INTERVAL_MS.notion
          : channel?.expiration
            ? POLL_INTERVAL_MS.google_calendar
            : POLL_INTERVAL_MS.google_without_channel;
      if (now - last >= every)
        await this.jobs.enqueue({
          organizationId: c.organizationId,
          connectionId: c.id,
          kind: 'pull',
          dedupeKey: 'pull',
        });
    }
    await this.webhooks.pruneReceipts();
  }
}
