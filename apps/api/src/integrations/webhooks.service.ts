/**
 * Generic webhooks, both directions, signed per the Standard Webhooks specification
 * (https://github.com/standard-webhooks/standard-webhooks, read 20 Oct 2026):
 * headers `webhook-id`, `webhook-timestamp` (Unix seconds) and `webhook-signature`
 * ("v1,<base64 HMAC-SHA256 of id.timestamp.body>", several separated by spaces); secrets are
 * "whsec_" + base64 of 32 random bytes.
 *
 * OUTGOING: meeting events are delivered to the endpoints that subscribed, retried on the
 * Standard Webhooks schedule (jobs.service.ts); 410 Gone disables the endpoint; redirects are
 * not followed. URLs must be https and resolve to public addresses (SSRF protection), checked
 * when created and again before every delivery. Payloads carry no meeting notes and no email
 * addresses (data minimization).
 *
 * INCOMING: every request must be signed with the endpoint's secret, within 5 minutes of now,
 * with a message id not seen before (replay protection). Anything else is refused with 401 —
 * the same answer for an unknown endpoint, a missing header and a wrong signature, so nothing
 * can be learned by probing. Accepted requests act as the endpoint's owner, with their current
 * permissions, through the meetings service (audited, notified).
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  type IncomingWebhookCreateInput,
  incomingWebhookPayloadSchema,
  type MeetingCreateInput,
  type OutgoingWebhookCreateInput,
  toRRule,
  type WebhookEventType,
} from '@esports/shared';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { TenantContext } from '../authz/context';
import { AuditService } from '../audit/audit.service';
import { AppError, Errors } from '../common/errors';
import { NOW, type Now } from '../common/now';
import { RateLimitService } from '../common/rate-limit';
import { type Env, ENV } from '../config/env';
import { DB, type Database } from '../db/client';
import { organizationMembers, users } from '../db/schema';
import { integrationConnections, meetings, webhookReceipts } from '../db/schema-meetings';
import { endLocalOf, type LoadedMeeting, MeetingsService } from '../meetings/meetings.service';
import type { MeetingChange } from '../meetings/meeting-events';
import { type ConnectionRow, ConnectionsService } from './connections.service';
import { IntegrationError, parseRetryAfter } from './errors';
import type { JobRow } from './jobs.service';

export const TIMESTAMP_TOLERANCE_S = 5 * 60;

export function newWebhookSecret() {
  return `whsec_${randomBytes(32).toString('base64')}`;
}

/** v1 signature of a message (Standard Webhooks, symmetric). */
export function signWebhook(secret: string, id: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

export function verifyWebhookSignature(secret: string, id: string, timestamp: number, body: string, header: string): boolean {
  const expected = Buffer.from(signWebhook(secret, id, timestamp, body).slice(3), 'base64');
  for (const part of header.split(' ')) {
    const [version, sig] = part.split(',');
    if (version !== 'v1' || !sig) continue;
    const got = Buffer.from(sig, 'base64');
    if (got.length === expected.length && timingSafeEqual(got, expected)) return true;
  }
  return false;
}

// ---------------------------------------------------------------- SSRF protection

function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) || // link-local, cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224 // multicast, reserved, broadcast
    );
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff');
}

/** Refuses URLs that could reach the platform's own network. */
export async function assertPublicUrl(raw: string, allowPrivate: boolean): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError('url_not_allowed', 400, 'Not a valid URL');
  }
  if (url.username || url.password) throw new AppError('url_not_allowed', 400, 'Credentials in URLs are not allowed');
  if (allowPrivate) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new AppError('url_not_allowed', 400, 'Only http(s) URLs');
    return url;
  }
  if (url.protocol !== 'https:') throw new AppError('url_not_allowed', 400, 'Webhook URLs must use https');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal'))
    throw new AppError('url_not_allowed', 400, 'Private addresses are not allowed');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addresses.length) throw new AppError('url_not_allowed', 400, 'The host name does not resolve');
  if (addresses.some(isPrivateAddress)) throw new AppError('url_not_allowed', 400, 'Private addresses are not allowed');
  return url;
}

export function eventTypeFor(change: MeetingChange): WebhookEventType {
  switch (change.type) {
    case 'created':
      return 'meeting.created';
    case 'cancelled':
      return 'meeting.cancelled';
    case 'response':
      return 'meeting.response';
    default:
      return 'meeting.updated';
  }
}

@Injectable()
export class WebhooksService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(NOW) private readonly now: Now,
    @Inject(ENV) private readonly env: Env,
    private readonly connections: ConnectionsService,
    private readonly meetings: MeetingsService,
    private readonly audit: AuditService,
    private readonly limiter: RateLimitService,
  ) {}

  // ---------------------------------------------------------------- setup

  async createOutgoing(ctx: TenantContext, input: OutgoingWebhookCreateInput) {
    await assertPublicUrl(input.url, this.env.WEBHOOK_ALLOW_PRIVATE_URLS);
    const secret = newWebhookSecret();
    const c = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(integrationConnections)
        .values({
          organizationId: ctx.organizationId,
          provider: 'webhook_outgoing',
          name: input.name,
          ownerUserId: ctx.user.id,
          personal: false,
          teamId: input.teamId ?? null,
          config: { url: input.url, events: input.events },
        })
        .returning();
      await this.connections.setSecrets(row!, { signingSecret: secret }, tx);
      await this.audit.fromCtx(ctx, 'integration.connected', { type: 'integration', id: row!.id }, { provider: 'webhook_outgoing', events: input.events, host: new URL(input.url).host }, tx);
      return row!;
    });
    await this.connections.log(c, 'info', 'connected', `Outgoing webhook to ${new URL(input.url).host} created.`);
    return { connection: (await this.connections.byId(c.id))!, secret };
  }

  async createIncoming(ctx: TenantContext, input: IncomingWebhookCreateInput) {
    const secret = newWebhookSecret();
    const c = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(integrationConnections)
        .values({
          organizationId: ctx.organizationId,
          provider: 'webhook_incoming',
          name: input.name,
          ownerUserId: ctx.user.id,
          personal: false,
          teamId: input.teamId ?? null,
          config: { actions: input.actions },
        })
        .returning();
      await this.connections.setSecrets(row!, { signingSecret: secret }, tx);
      await this.audit.fromCtx(ctx, 'integration.connected', { type: 'integration', id: row!.id }, { provider: 'webhook_incoming', actions: input.actions }, tx);
      return row!;
    });
    await this.connections.log(c, 'info', 'connected', 'Incoming webhook endpoint created.');
    return { connection: (await this.connections.byId(c.id))!, secret };
  }

  async rotate(c: ConnectionRow) {
    const secret = newWebhookSecret();
    await this.connections.setSecrets(c, { ...this.connections.secrets(c), signingSecret: secret });
    return secret;
  }

  // ---------------------------------------------------------------- outgoing

  /** The message body for an event (built when the event happens, not when it's delivered). */
  payload(l: LoadedMeeting, change: MeetingChange) {
    const m = l.row;
    return {
      type: eventTypeFor(change),
      timestamp: new Date(this.now()).toISOString(),
      data: {
        meeting: {
          id: m.id,
          kind: m.kind,
          title: m.title,
          description: m.description,
          start: m.startLocal,
          end: endLocalOf(m),
          timeZone: m.timeZone,
          recurrence: m.recurrence,
          rrule: m.recurrence ? toRRule(m.recurrence, m.startLocal, m.timeZone) : null,
          status: m.status,
          cancelReason: m.cancelReason,
          team: l.team ? { id: l.team.id, name: l.team.name } : null,
          department: m.departmentId ? { id: m.departmentId, name: l.departmentName } : null,
          organizerUserId: m.organizerUserId,
          participants: l.participants.map((p) => ({ userId: p.userId, displayName: p.displayName, response: p.response })),
          occurrenceChanges: l.overrides.map((o) => ({
            originalStart: o.originalStart.toISOString(),
            status: o.status,
            start: o.startAt?.toISOString() ?? null,
            end: o.endAt?.toISOString() ?? null,
          })),
          version: m.version,
          url: `${this.env.WEB_APP_URL.replace(/\/$/, '')}/dashboard/meetings/${m.id}`,
        },
        change,
      },
    };
  }

  async deliver(c: ConnectionRow, job: JobRow): Promise<void> {
    const cfg = c.config as { url?: string };
    const url = await assertPublicUrl(String(cfg.url ?? ''), this.env.WEBHOOK_ALLOW_PRIVATE_URLS).catch((e: AppError) => {
      throw new IntegrationError('permanent', 'url_not_allowed', e.message);
    });
    const { signingSecret } = this.connections.secrets<{ signingSecret?: string }>(c);
    if (!signingSecret) throw new IntegrationError('auth', 'no_secret', 'The endpoint has no signing secret');
    const body = JSON.stringify(job.payload);
    const id = `msg_${job.id}`;
    const ts = Math.floor(this.now() / 1000);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'EsportsPlatform-Webhooks/1.0',
          'webhook-id': id,
          'webhook-timestamp': String(ts),
          'webhook-signature': signWebhook(signingSecret, id, ts, body),
        },
        body,
        signal: AbortSignal.timeout(Math.min(this.env.INTEGRATIONS_TIMEOUT_MS, 15_000)),
      });
      await res.arrayBuffer().catch(() => null);
    } catch (e) {
      throw new IntegrationError('retryable', 'network', `The endpoint could not be reached (${(e as Error).name})`);
    }
    if (res.status >= 200 && res.status < 300) {
      await this.connections.log(c, 'info', 'delivered', `Delivered ${(job.payload as { type?: string }).type ?? 'event'} (${res.status}).`, {
        meetingId: job.meetingId,
        detail: { messageId: id, status: res.status, attempt: job.attempts },
      });
      return;
    }
    if (res.status === 410) {
      await this.db.update(integrationConnections).set({ status: 'error' }).where(eq(integrationConnections.id, c.id));
      await this.connections.log(c, 'error', 'endpoint_disabled', 'The endpoint answered 410 Gone; it was disabled.', { meetingId: job.meetingId });
      throw new IntegrationError('auth', 'endpoint_gone', 'The endpoint answered 410 Gone');
    }
    // Everything else is retried (Standard Webhooks: only 2xx is success).
    const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
    await this.connections.log(c, 'warn', 'delivery_failed', `Delivery attempt ${job.attempts} got ${res.status}.`, {
      meetingId: job.meetingId,
      detail: { messageId: id, status: res.status },
    });
    throw new IntegrationError(res.status === 429 ? 'rate_limited' : 'retryable', 'delivery_failed', `Endpoint answered ${res.status}`, retryAfter ?? undefined, res.status);
  }

  // ---------------------------------------------------------------- incoming

  private refuse(): never {
    throw new AppError('invalid_signature', 401, 'Missing or invalid webhook signature');
  }

  async handleIncoming(connectionId: string, headers: Record<string, string | string[] | undefined>, raw: Buffer | undefined) {
    const h = (k: string) => {
      const v = headers[k];
      return Array.isArray(v) ? v[0] : v;
    };
    const id = h('webhook-id');
    const tsRaw = h('webhook-timestamp');
    const sig = h('webhook-signature');
    if (!/^[0-9a-f-]{36}$/i.test(connectionId) || !id || !tsRaw || !sig || !raw) this.refuse();
    const c = await this.connections.byId(connectionId);
    if (!c || c.provider !== 'webhook_incoming' || c.status !== 'active' || c.paused) this.refuse();
    const ts = Number(tsRaw);
    const body = raw.toString('utf8');
    const { signingSecret } = this.connections.secrets<{ signingSecret?: string }>(c);
    const fresh = Number.isInteger(ts) && Math.abs(this.now() / 1000 - ts) <= TIMESTAMP_TOLERANCE_S;
    if (!signingSecret || !fresh || id.length > 200 || !verifyWebhookSignature(signingSecret, id, ts, body, sig)) {
      // Logged at most once a minute per endpoint, so a flood can't fill the log.
      if ((await this.limiter.consume(`hooklog:${c.id}`, 1, 60)) === null)
        await this.connections.log(c, 'warn', 'signature_rejected', fresh ? 'Refused a request with a missing or wrong signature.' : 'Refused a request with a stale or missing timestamp.');
      this.refuse();
    }
    const wait = await this.limiter.consume(`hook:${c.id}`, 120, 60);
    if (wait !== null) throw new AppError('rate_limited', 429, 'Too many requests', { retryAfterSeconds: wait });
    // Replay protection: each message id is processed once.
    const [fresh2] = await this.db.insert(webhookReceipts).values({ connectionId: c.id, messageId: id }).onConflictDoNothing().returning();
    if (!fresh2) return { duplicate: true };

    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw Errors.validation([{ path: '', message: 'invalid_json', code: 'custom' }]);
    }
    const parsed = incomingWebhookPayloadSchema.safeParse(json);
    if (!parsed.success)
      throw Errors.validation(parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code })));
    const p = parsed.data;
    const allowed = ((c.config as { actions?: string[] }).actions ?? []) as string[];
    if (!allowed.includes(p.type)) throw Errors.forbidden('This endpoint does not accept that action');
    const owner = await this.connections.ownerCtx(c);
    if (!owner) throw Errors.forbidden('The endpoint owner no longer has access');
    const via = { via: { provider: 'webhook', connectionId: c.id } };
    await this.connections.log(c, 'info', 'webhook_received', `Received ${p.type}.`, { detail: { messageId: id } });

    if (p.type === 'meeting.create') {
      const [existing] = await this.db
        .select({ id: meetings.id })
        .from(meetings)
        .where(and(eq(meetings.sourceConnectionId, c.id), eq(meetings.externalId, p.data.externalId)));
      if (existing) return { meetingId: existing.id, result: 'exists' };
      const emails = [...new Set(p.data.participantEmails.map((e) => e.toLowerCase()))];
      const members = emails.length
        ? await this.db
            .select({ userId: users.id, email: users.email })
            .from(users)
            .innerJoin(organizationMembers, eq(organizationMembers.userId, users.id))
            .where(
              and(
                eq(organizationMembers.organizationId, c.organizationId),
                eq(organizationMembers.status, 'active'),
                inArray(sql`lower(${users.email})`, emails),
              ),
            )
        : [];
      const input: MeetingCreateInput = {
        kind: 'standard',
        title: p.data.title,
        description: p.data.description ?? null,
        notes: p.data.notes ?? null,
        teamId: p.data.teamId !== undefined ? p.data.teamId : c.teamId,
        departmentId: null,
        start: p.data.start,
        end: p.data.end,
        timeZone: p.data.timeZone,
        recurrence: p.data.recurrence ?? null,
        participantUserIds: members.map((m) => m.userId),
        reminderMinutes: p.data.reminderMinutes ?? [15],
      };
      const dto = await this.meetings.create(owner, input, {
        ...via,
        source: 'webhook',
        sourceConnectionId: c.id,
        externalId: p.data.externalId,
      });
      const matched = new Set(members.map((m) => m.email.toLowerCase()));
      return { meetingId: dto.id, result: 'created', unmatchedParticipants: emails.filter((e) => !matched.has(e)) };
    }

    // update / cancel: by our id, or by the sender's external id (scoped to this endpoint).
    let meetingId = p.data.meetingId;
    if (!meetingId && p.data.externalId) {
      const [m] = await this.db
        .select({ id: meetings.id })
        .from(meetings)
        .where(and(eq(meetings.sourceConnectionId, c.id), eq(meetings.externalId, p.data.externalId)));
      meetingId = m?.id;
    }
    if (!meetingId) throw Errors.notFound('Meeting');
    if (p.type === 'meeting.cancel') {
      const dto = await this.meetings.cancel(owner, meetingId, p.data.reason, via);
      return { meetingId: dto.id, result: 'cancelled' };
    }
    const { meetingId: _a, externalId: _b, ...changes } = p.data;
    void _a;
    void _b;
    const dto = await this.meetings.update(owner, meetingId, changes, via);
    return { meetingId: dto.id, result: 'updated', version: dto.version };
  }

  /** Receipts only need to outlive the timestamp tolerance; a day is plenty. */
  async pruneReceipts() {
    await this.db.delete(webhookReceipts).where(lt(webhookReceipts.receivedAt, new Date(this.now() - 86_400_000)));
  }
}
