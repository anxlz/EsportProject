/**
 * Google Calendar (Calendar API v3), per member: their meetings in their own calendar.
 * Request and response shapes follow Google's reference (read 20 Oct 2026):
 * https://developers.google.com/workspace/calendar/api/v3/reference/events,
 * …/guides/sync (sync tokens, 410), …/guides/push (watch channels), …/guides/quota.
 *
 * Mapping (two-way by default):
 * - title, start/end/time zone, recurrence (RRULE + EXDATE), cancelled single occurrences and
 *   moved single occurrences sync both ways; deleting the event from the calendar declines it
 *   (or cancels the meeting, if the owner organizes it and may change it).
 * - The description is written by the platform (purpose, notes, participants) and is not read
 *   back: it's free text that can't be split back into separate fields reliably.
 * - The copy in a member's calendar has no guests (so Google never sends invitations or makes
 *   copies of its own); the member's own response shows as tentative (not answered) or
 *   confirmed (accepted); declined meetings are removed from their calendar.
 *
 * Duplicates: the event id is derived from (connection, meeting), so creating it twice returns
 * 409 and the existing event is reused; every event carries the meeting id in a private
 * extended property, so our own events are recognized when they come back.
 *
 * New events created in the calendar become meetings only when a dedicated calendar (not
 * "primary") is synced — a personal calendar is full of events that aren't team meetings.
 *
 * Rate limits: Google allows 600 requests/minute per user per project; we stay under 300 per
 * connection and back off on 403/429 usageLimits with the documented exponential backoff.
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  formatLocal,
  fromRRule,
  localToUtc,
  parseLocal,
  toRRule,
  utcToLocal,
} from '@esports/shared';
import { eq } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { NOW, type Now } from '../../common/now.js';
import { RateLimitService } from '../../common/rate-limit.js';
import { sha256 } from '../../common/crypto.js';
import { type Env, ENV } from '../../config/env.js';
import { DB, type Database } from '../../db/client.js';
import { integrationConnections } from '../../db/schema-meetings.js';
import { type ConnectionRow, ConnectionsService } from '../connections.service.js';
import { IntegrationError } from '../errors.js';
import { httpJson, reserve } from './http.js';
import type { SnapshotKey } from '../sync-engine.js';
import type { LinkRow, MeetingView, RemoteChanges, RemoteProvider, RemoteRecord } from './types.js';

const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const PER_MINUTE = 300;
/** Watch channels: ask for 7 days, renew a day before they end. */
const CHANNEL_TTL_MS = 7 * 86_400_000;
export const CHANNEL_RENEW_BEFORE_MS = 86_400_000;
/** First sync looks back this far (later syncs use the sync token). */
const FULL_SYNC_LOOKBACK_MS = 30 * 86_400_000;

type GoogleSecrets = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

export interface GoogleEvent {
  id: string;
  etag?: string;
  status?: string;
  htmlLink?: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: { dateTime?: string; date?: string; timeZone?: string };
  extendedProperties?: { private?: Record<string, string> };
}

/** Deterministic event id (base32hex alphabet: hex is a subset; 32 characters). */
export function googleEventId(connectionId: string, meetingId: string) {
  return createHash('sha256').update(`${connectionId}:${meetingId}`).digest('hex').slice(0, 32);
}

/** "2026-10-21T18:00" in Asia/Riyadh → EXDATE value "20261021T180000". */
const basic = (local: string) => `${local.replace(/[-:]/g, '')}00`;

const HAS_OFFSET = /(?:[zZ]|[+-]\d{2}:\d{2})$/;

/** A Google date-time read as wall-clock time in `tz` (Google sends an offset; be lenient). */
function toLocal(dateTime: string, tz: string): string | null {
  if (!HAS_OFFSET.test(dateTime))
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(dateTime) ? dateTime.slice(0, 16) : null;
  const ms = Date.parse(dateTime);
  if (!Number.isFinite(ms)) return null;
  return formatLocal(utcToLocal(ms, tz));
}

/** A Google date-time as a UTC instant (a time without offset is read in `tz`). */
function instant(dateTime: string, tz: string): number {
  if (HAS_OFFSET.test(dateTime)) return Date.parse(dateTime);
  const l = parseLocal(dateTime.slice(0, 16));
  return l ? localToUtc(l, tz) : Number.NaN;
}

export function eventToRecord(ev: GoogleEvent, fallbackTz: string): RemoteRecord {
  const platformMeetingId = ev.extendedProperties?.private?.platformMeetingId ?? null;
  const base: RemoteRecord = {
    id: ev.id,
    version: ev.etag ?? '',
    url: ev.htmlLink ?? null,
    deleted: ev.status === 'cancelled',
    platformMeetingId,
    snapshot: null,
  };
  if (ev.recurringEventId) {
    const tz = ev.originalStartTime?.timeZone ?? ev.start?.timeZone ?? fallbackTz;
    const orig = ev.originalStartTime?.dateTime;
    if (!orig) return { ...base, deleted: false, unsupported: 'all_day' };
    return {
      ...base,
      deleted: false,
      instanceOf: {
        remoteId: ev.recurringEventId,
        originalStart: new Date(instant(orig, tz)).toISOString(),
        cancelled: ev.status === 'cancelled',
        startLocal: ev.start?.dateTime ? (toLocal(ev.start.dateTime, tz) ?? undefined) : undefined,
        endLocal: ev.end?.dateTime ? (toLocal(ev.end.dateTime, tz) ?? undefined) : undefined,
      },
    };
  }
  if (base.deleted) return base;
  if (!ev.start?.dateTime || !ev.end?.dateTime) return { ...base, unsupported: 'all_day' };
  const tz = ev.start.timeZone ?? fallbackTz;
  const startLocal = toLocal(ev.start.dateTime, tz);
  const endLocal = toLocal(ev.end.dateTime, ev.end.timeZone ?? tz);
  if (!startLocal || !endLocal) return { ...base, unsupported: 'invalid_time' };
  let recurrence = null;
  let exdates: string[] = [];
  if (ev.recurrence?.length) {
    const r = fromRRule(ev.recurrence, startLocal, tz);
    if (r.ok === false) return { ...base, unsupported: `recurrence:${r.reason}` };
    recurrence = r.rule;
    exdates = [...r.exdates].sort();
  }
  return {
    ...base,
    snapshot: {
      title: ev.summary ?? '',
      time: { startLocal, endLocal, timeZone: tz },
      recurrence,
      exdates,
      status: 'scheduled',
    },
  };
}

@Injectable()
export class GoogleCalendarProvider implements RemoteProvider {
  readonly name = 'google_calendar' as const;
  readonly inboundKeys: SnapshotKey[] = ['title', 'time', 'recurrence', 'exdates', 'status'];

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(DB) private readonly db: Database,
    @Inject(NOW) private readonly now: Now,
    private readonly connections: ConnectionsService,
    private readonly limiter: RateLimitService,
  ) {}

  get configured() {
    return this.env.googleEnabled;
  }

  importsNew(c: ConnectionRow) {
    return this.calendarId(c) !== 'primary';
  }

  private calendarId(c: ConnectionRow) {
    return String((c.config as { calendarId?: string }).calendarId ?? 'primary');
  }

  // ---------------------------------------------------------------- OAuth

  authUrl(state: string): string {
    const u = new URL(this.env.GOOGLE_AUTH_URL);
    u.searchParams.set('client_id', this.env.GOOGLE_CLIENT_ID!);
    u.searchParams.set('redirect_uri', this.env.GOOGLE_REDIRECT_URI!);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', SCOPE);
    u.searchParams.set('access_type', 'offline');
    u.searchParams.set('prompt', 'consent');
    u.searchParams.set('include_granted_scopes', 'true');
    u.searchParams.set('state', state);
    return u.toString();
  }

  async exchangeCode(code: string): Promise<GoogleSecrets> {
    const r = await httpJson<{
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
    }>('Google', this.env.GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.env.GOOGLE_CLIENT_ID!,
        client_secret: this.env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: this.env.GOOGLE_REDIRECT_URI!,
        grant_type: 'authorization_code',
      }).toString(),
      timeoutMs: this.env.INTEGRATIONS_TIMEOUT_MS,
    });
    if (r.status !== 200 || !r.body.access_token || !r.body.refresh_token)
      throw new IntegrationError(
        'auth',
        'oauth_failed',
        `Google token exchange failed (${r.status})`,
      );
    return {
      accessToken: r.body.access_token,
      refreshToken: r.body.refresh_token,
      expiresAt: this.now() + (r.body.expires_in ?? 3600) * 1000,
    };
  }

  private async accessToken(c: ConnectionRow): Promise<string> {
    const s = this.connections.secrets<GoogleSecrets>(c);
    if (!s.refreshToken)
      throw new IntegrationError('auth', 'not_connected', 'Google Calendar is not connected');
    if (s.accessToken && s.expiresAt > this.now() + 60_000) return s.accessToken;
    const r = await httpJson<{ access_token?: string; expires_in?: number; error?: string }>(
      'Google',
      this.env.GOOGLE_TOKEN_URL,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.env.GOOGLE_CLIENT_ID!,
          client_secret: this.env.GOOGLE_CLIENT_SECRET!,
          refresh_token: s.refreshToken,
          grant_type: 'refresh_token',
        }).toString(),
        timeoutMs: this.env.INTEGRATIONS_TIMEOUT_MS,
      },
    );
    if (r.status === 400 || r.status === 401)
      throw new IntegrationError(
        'auth',
        'auth_failed',
        `Google refused the stored authorization (${r.body.error ?? r.status})`,
      );
    if (r.status !== 200 || !r.body.access_token)
      throw IntegrationError.fromStatus('Google', r.status, null);
    const next = {
      ...s,
      accessToken: r.body.access_token,
      expiresAt: this.now() + (r.body.expires_in ?? 3600) * 1000,
    };
    await this.connections.setSecrets(c, next);
    c.secrets = this.connections.seal(c, next);
    return next.accessToken;
  }

  /** Best effort: tell Google to forget the authorization on disconnect. */
  async revoke(c: ConnectionRow) {
    const s = this.connections.secrets<GoogleSecrets>(c);
    if (!s.refreshToken) return;
    await httpJson('Google', this.env.GOOGLE_TOKEN_URL.replace(/\/token$/, '/revoke'), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: s.refreshToken }).toString(),
      timeoutMs: this.env.INTEGRATIONS_TIMEOUT_MS,
    }).catch(() => undefined);
  }

  // ---------------------------------------------------------------- API calls

  private async api<T>(
    c: ConnectionRow,
    method: string,
    path: string,
    opts: {
      query?: Record<string, string | undefined>;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ) {
    await reserve(this.limiter, `google:${c.id}`, PER_MINUTE);
    const token = await this.accessToken(c);
    const u = new URL(`/calendar/v3${path}`, this.env.GOOGLE_API_URL);
    for (const [k, v] of Object.entries(opts.query ?? {}))
      if (v !== undefined) u.searchParams.set(k, v);
    const r = await httpJson<T & { error?: { errors?: { reason?: string }[]; message?: string } }>(
      'Google',
      u.toString(),
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...opts.headers,
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        timeoutMs: this.env.INTEGRATIONS_TIMEOUT_MS,
      },
    );
    // Quota errors come back as 403 (usageLimits / rateLimitExceeded) or 429.
    if (r.status === 403) {
      const reason = r.body?.error?.errors?.[0]?.reason ?? '';
      if (/rateLimit|usageLimit|quota/i.test(reason))
        throw new IntegrationError(
          'rate_limited',
          'rate_limited',
          `Google quota (${reason})`,
          60_000,
          403,
        );
    }
    return r;
  }

  private fail(status: number, headers: Headers, what: string): never {
    throw IntegrationError.fromStatus('Google', status, headers.get('retry-after'), what);
  }

  private eventBody(c: ConnectionRow, view: MeetingView): GoogleEvent {
    const s = view.snapshot;
    const tz = s.time.timeZone;
    const recurrence = s.recurrence
      ? [
          toRRule(s.recurrence, s.time.startLocal, tz),
          ...s.exdates.map(
            (x) => `EXDATE;TZID=${tz}:${basic(formatLocal(utcToLocal(Date.parse(x), tz)))}`,
          ),
        ]
      : undefined;
    return {
      id: googleEventId(c.id, view.loaded.row.id),
      summary: s.title,
      description: describe(view),
      start: { dateTime: `${s.time.startLocal}:00`, timeZone: tz },
      end: { dateTime: `${s.time.endLocal}:00`, timeZone: tz },
      ...(recurrence ? { recurrence } : {}),
      status: view.ownerResponse === 'accepted' ? 'confirmed' : 'tentative',
      extendedProperties: {
        private: { platformMeetingId: view.loaded.row.id, platformConnectionId: c.id },
      },
    };
  }

  async create(c: ConnectionRow, view: MeetingView): Promise<RemoteRecord> {
    const body = this.eventBody(c, view);
    const r = await this.api<GoogleEvent>(
      c,
      'POST',
      `/calendars/${encodeURIComponent(this.calendarId(c))}/events`,
      {
        body,
        query: { sendUpdates: 'none' },
      },
    );
    if (r.status === 409) {
      // The id is taken: an earlier attempt created it (response lost), or it was deleted and
      // Google keeps deleted ids. Either way, a full update makes it this meeting again.
      return this.write(c, body.id, view, null);
    }
    if (r.status !== 200) this.fail(r.status, r.headers, 'create event');
    const rec = eventToRecord(r.body, view.snapshot.time.timeZone);
    await this.syncMovedOccurrences(c, body.id, view);
    return rec;
  }

  async update(c: ConnectionRow, link: LinkRow, view: MeetingView): Promise<RemoteRecord> {
    return this.write(c, link.remoteId!, view, link.remoteVersion);
  }

  /** Full replacement (events.update), conditional on the etag we last saw. */
  private async write(
    c: ConnectionRow,
    eventId: string,
    view: MeetingView,
    etag: string | null,
  ): Promise<RemoteRecord> {
    const r = await this.api<GoogleEvent>(
      c,
      'PUT',
      `/calendars/${encodeURIComponent(this.calendarId(c))}/events/${encodeURIComponent(eventId)}`,
      {
        body: { ...this.eventBody(c, view), id: eventId },
        query: { sendUpdates: 'none' },
        headers: etag ? { 'if-match': etag } : {},
      },
    );
    if (r.status === 412)
      throw new IntegrationError(
        'retryable',
        'precondition_failed',
        'The event changed in Google Calendar meanwhile',
      );
    if (r.status === 404 || r.status === 410)
      throw new IntegrationError(
        'permanent',
        'remote_gone',
        'The event no longer exists in Google Calendar',
        undefined,
        r.status,
      );
    if (r.status !== 200) this.fail(r.status, r.headers, 'update event');
    await this.syncMovedOccurrences(c, eventId, view);
    // The etag changes when exception instances change; read the series back for the latest.
    if (view.loaded.overrides.some((o) => o.status === 'moved')) {
      const fresh = await this.get(c, eventId);
      if (fresh) return fresh;
    }
    return eventToRecord(r.body, view.snapshot.time.timeZone);
  }

  /** Moved single occurrences: patch the matching instance (events.instances). */
  private async syncMovedOccurrences(c: ConnectionRow, eventId: string, view: MeetingView) {
    const moved = view.loaded.overrides.filter((o) => o.status === 'moved' && o.startAt && o.endAt);
    if (!moved.length || !view.snapshot.recurrence) return;
    const tz = view.snapshot.time.timeZone;
    for (const o of moved) {
      const orig = o.originalStart.getTime();
      const r = await this.api<{ items?: GoogleEvent[] }>(
        c,
        'GET',
        `/calendars/${encodeURIComponent(this.calendarId(c))}/events/${encodeURIComponent(eventId)}/instances`,
        {
          query: {
            timeMin: new Date(orig - 60_000).toISOString(),
            timeMax: new Date(orig + 60_000).toISOString(),
            showDeleted: 'true',
          },
        },
      );
      if (r.status !== 200) this.fail(r.status, r.headers, 'list instances');
      const inst = (r.body.items ?? []).find(
        (i) => i.originalStartTime?.dateTime && instant(i.originalStartTime.dateTime, tz) === orig,
      );
      if (!inst) continue;
      const start = formatLocal(utcToLocal(o.startAt!.getTime(), tz));
      const end = formatLocal(utcToLocal(o.endAt!.getTime(), tz));
      if (
        inst.start?.dateTime &&
        instant(inst.start.dateTime, tz) === o.startAt!.getTime() &&
        inst.end?.dateTime &&
        instant(inst.end.dateTime, tz) === o.endAt!.getTime()
      )
        continue;
      const p = await this.api<GoogleEvent>(
        c,
        'PATCH',
        `/calendars/${encodeURIComponent(this.calendarId(c))}/events/${encodeURIComponent(inst.id)}`,
        {
          body: {
            start: { dateTime: `${start}:00`, timeZone: tz },
            end: { dateTime: `${end}:00`, timeZone: tz },
          },
          query: { sendUpdates: 'none' },
        },
      );
      if (p.status !== 200) this.fail(p.status, p.headers, 'move occurrence');
    }
  }

  async remove(c: ConnectionRow, link: LinkRow): Promise<void> {
    if (!link.remoteId) return;
    const r = await this.api(
      c,
      'DELETE',
      `/calendars/${encodeURIComponent(this.calendarId(c))}/events/${encodeURIComponent(link.remoteId)}`,
      { query: { sendUpdates: 'none' } },
    );
    if (r.status === 204 || r.status === 200 || r.status === 404 || r.status === 410) return;
    this.fail(r.status, r.headers, 'delete event');
  }

  async get(c: ConnectionRow, remoteId: string): Promise<RemoteRecord | null> {
    const r = await this.api<GoogleEvent>(
      c,
      'GET',
      `/calendars/${encodeURIComponent(this.calendarId(c))}/events/${encodeURIComponent(remoteId)}`,
    );
    if (r.status === 404 || r.status === 410) return null;
    if (r.status !== 200) this.fail(r.status, r.headers, 'get event');
    return eventToRecord(r.body, 'UTC');
  }

  async find(c: ConnectionRow, meetingId: string): Promise<RemoteRecord | null> {
    const rec = await this.get(c, googleEventId(c.id, meetingId));
    return rec && !rec.deleted ? rec : null;
  }

  async changes(c: ConnectionRow, opts: { full: boolean }): Promise<RemoteChanges> {
    const cursor = c.cursor as { syncToken?: string };
    let full = opts.full || !cursor.syncToken;
    const list = async (syncToken: string | undefined) => {
      const records: RemoteRecord[] = [];
      let pageToken: string | undefined;
      let nextSyncToken: string | undefined;
      do {
        const r = await this.api<{
          items?: GoogleEvent[];
          nextPageToken?: string;
          nextSyncToken?: string;
        }>(c, 'GET', `/calendars/${encodeURIComponent(this.calendarId(c))}/events`, {
          query: {
            maxResults: '250',
            pageToken,
            ...(syncToken
              ? { syncToken }
              : { timeMin: new Date(this.now() - FULL_SYNC_LOOKBACK_MS).toISOString() }),
          },
        });
        if (r.status === 410) return null; // sync token invalidated
        if (r.status !== 200) this.fail(r.status, r.headers, 'list events');
        for (const ev of r.body.items ?? []) records.push(eventToRecord(ev, 'UTC'));
        pageToken = r.body.nextPageToken;
        nextSyncToken = r.body.nextSyncToken ?? nextSyncToken;
      } while (pageToken);
      return { records, nextSyncToken };
    };
    let gone = false;
    let result = await list(full ? undefined : cursor.syncToken);
    if (!result) {
      // 410 Gone: start over with a full listing (links prevent duplicates).
      gone = true;
      full = true;
      result = await list(undefined);
      if (!result)
        throw new IntegrationError('retryable', 'sync_token', 'Google refused a fresh listing');
    }
    const { records, nextSyncToken } = result;
    return {
      records,
      fullResync: gone,
      commit: async () => {
        if (!nextSyncToken) return;
        await this.db
          .update(integrationConnections)
          .set({ cursor: { ...c.cursor, syncToken: nextSyncToken } })
          .where(eq(integrationConnections.id, c.id));
        c.cursor = { ...c.cursor, syncToken: nextSyncToken };
      },
    };
  }

  // ---------------------------------------------------------------- push notifications

  /** Starts (or renews) a watch channel. Needs a public https address; otherwise polling only. */
  async watch(c: ConnectionRow): Promise<'started' | 'skipped'> {
    const address = `${this.env.publicApiUrl}/integrations/hooks/google/${c.id}`;
    if (!address.startsWith('https://')) return 'skipped';
    const token = randomBytes(32).toString('base64url');
    const id = crypto.randomUUID();
    const r = await this.api<{ id?: string; resourceId?: string; expiration?: string }>(
      c,
      'POST',
      `/calendars/${encodeURIComponent(this.calendarId(c))}/events/watch`,
      {
        body: {
          id,
          type: 'web_hook',
          address,
          token,
          expiration: String(this.now() + CHANNEL_TTL_MS),
        },
      },
    );
    if (r.status !== 200 || !r.body.resourceId) this.fail(r.status, r.headers, 'watch');
    const previous = c.channel as { id?: string; resourceId?: string } | null;
    const channel = {
      id,
      resourceId: r.body.resourceId,
      tokenHash: sha256(token),
      expiration: Number(r.body.expiration ?? this.now() + CHANNEL_TTL_MS),
      // Keep the old channel valid until it's stopped (overlap during renewal).
      previous: previous?.id
        ? {
            id: previous.id,
            resourceId: previous.resourceId,
            tokenHash: (previous as { tokenHash?: string }).tokenHash,
          }
        : null,
    };
    await this.db
      .update(integrationConnections)
      .set({ channel })
      .where(eq(integrationConnections.id, c.id));
    c.channel = channel;
    if (previous?.id && previous.resourceId)
      await this.stopChannel(c, previous.id, previous.resourceId);
    return 'started';
  }

  async stopChannel(c: ConnectionRow, id: string, resourceId: string) {
    await this.api(c, 'POST', '/channels/stop', { body: { id, resourceId } }).catch(
      () => undefined,
    );
  }
}

/** The event description: the platform's text, in the owner's language (not read back). */
function describe(view: MeetingView): string {
  const l = view.loaded;
  const ar = view.locale === 'ar';
  const parts: string[] = [];
  if (l.row.description) parts.push(l.row.description);
  if (l.row.notes) parts.push(`${ar ? 'ملاحظات' : 'Notes'}:\n${l.row.notes}`);
  const who = l.participants
    .map(
      (p) =>
        `${p.displayName}${p.userId === l.row.organizerUserId ? (ar ? ' (المنظم)' : ' (organizer)') : ''}`,
    )
    .join(', ');
  if (who) parts.push(`${ar ? 'المشاركون' : 'Participants'}: ${who}`);
  parts.push(
    ar
      ? 'أُضيف من منصة النادي. التعديل على العنوان والوقت والتكرار هنا يُزامَن مع المنصة؛ هذا الوصف تكتبه المنصة.'
      : 'Added by the club platform. Changes to the title, time and repeat settings here sync back; this description is written by the platform.',
  );
  return parts.join('\n\n');
}
