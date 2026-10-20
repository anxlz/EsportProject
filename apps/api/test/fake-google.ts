/**
 * A stand-in for the parts of Google's OAuth and Calendar API v3 the integration uses, built
 * from Google's reference (events insert/get/update/patch/delete/list with sync tokens and
 * 410 Gone, instances, watch, channels.stop, token endpoint). It runs as a local HTTP server so
 * the real adapter's requests, headers, etags and error handling are exercised. It is NOT
 * Google: behaviour the documentation leaves open is filled in the simplest plausible way.
 */
import {
  formatLocal,
  fromRRule,
  isoWithOffset,
  localToUtc,
  parseLocal,
  seriesOccurrences,
  utcToLocal,
} from '@esports/shared';

/** Google always answers date-times with an offset; store them that way. */
function withOffset(t?: { dateTime?: string; timeZone?: string }) {
  if (!t?.dateTime || /(?:[zZ]|[+-]\d{2}:\d{2})$/.test(t.dateTime)) return t;
  const tz = t.timeZone ?? 'UTC';
  return {
    ...t,
    dateTime: isoWithOffset(localToUtc(parseLocal(t.dateTime.slice(0, 16))!, tz), tz),
  };
}
function normalize(ev: FakeEvent) {
  ev.start = withOffset(ev.start);
  ev.end = withOffset(ev.end);
  ev.originalStartTime = withOffset(ev.originalStartTime) as FakeEvent['originalStartTime'];
  if (!ev.originalStartTime) delete ev.originalStartTime;
  if (!ev.start) delete ev.start;
  if (!ev.end) delete ev.end;
  return ev;
}

export interface FakeEvent {
  id: string;
  etag: string;
  status: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; timeZone?: string; date?: string };
  end?: { dateTime?: string; timeZone?: string; date?: string };
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: { dateTime?: string; timeZone?: string };
  extendedProperties?: { private?: Record<string, string> };
  htmlLink?: string;
  seq: number;
  /** Whose calendar it's in (each OAuth grant is a different person). */
  owner?: string;
}

export class FakeGoogle {
  server!: ReturnType<typeof Bun.serve>;
  url = '';
  events = new Map<string, FakeEvent>();
  /** Instance exceptions, keyed by instance id. */
  requests: { method: string; path: string; headers: Record<string, string>; body: unknown }[] = [];
  watches: { id: string; address: string; token: string; resourceId: string }[] = [];
  stopped: { id: string; resourceId: string }[] = [];
  private seq = 0;
  private who = '';
  private etagN = 0;
  /** access token → whose calendar; refresh token → whose calendar. */
  private validTokens = new Map<string, string>();
  private refreshOwners = new Map<string, string>();
  revokedRefresh = new Set<string>();
  private invalidatedBefore = 0;
  private failures: {
    status: number;
    headers?: Record<string, string>;
    times: number;
    match?: RegExp;
  }[] = [];

  start() {
    this.server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (req) => this.handle(req) });
    this.url = `http://127.0.0.1:${this.server.port}`;
    return this;
  }
  stop() {
    this.server.stop(true);
  }
  reset() {
    this.events.clear();
    this.requests = [];
    this.watches = [];
    this.stopped = [];
    this.failures = [];
    this.validTokens.clear();
    this.refreshOwners.clear();
    this.revokedRefresh.clear();
    this.invalidatedBefore = 0;
  }

  /** The next `times` matching API requests fail with `status`. */
  failNext(status: number, times = 1, headers?: Record<string, string>, match?: RegExp) {
    this.failures.push({ status, times, headers, match });
  }

  private etag() {
    return `"e${++this.etagN}"`;
  }

  calls(method: string, re: RegExp) {
    return this.requests.filter((r) => r.method === method && re.test(r.path));
  }

  // ---------- what a person does in Google Calendar ----------

  userEdit(id: string, patch: Partial<FakeEvent>) {
    const ev = this.events.get(id)!;
    Object.assign(ev, patch, { etag: this.etag(), seq: ++this.seq });
    normalize(ev);
  }
  userDelete(id: string) {
    this.userEdit(id, { status: 'cancelled' });
  }
  userCreate(ev: Omit<FakeEvent, 'etag' | 'seq' | 'status'> & { status?: string; owner: string }) {
    this.events.set(
      ev.id,
      normalize({
        status: 'confirmed',
        ...ev,
        etag: this.etag(),
        seq: ++this.seq,
        htmlLink: `https://calendar.example/${ev.id}`,
      }),
    );
  }
  /** Cancel (or move) one occurrence: Google stores an exception instance. */
  userChangeInstance(
    seriesId: string,
    originalStartIso: string,
    change: { cancelled?: boolean; start?: string; end?: string; timeZone?: string },
  ) {
    const series = this.events.get(seriesId)!;
    const id = `${seriesId}_${originalStartIso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
    const tz = change.timeZone ?? series.start?.timeZone ?? 'UTC';
    this.events.set(id, {
      id,
      owner: series.owner,
      etag: this.etag(),
      seq: ++this.seq,
      status: change.cancelled ? 'cancelled' : 'confirmed',
      recurringEventId: seriesId,
      originalStartTime: { dateTime: originalStartIso, timeZone: tz },
      summary: series.summary,
      ...(change.start
        ? {
            start: { dateTime: change.start, timeZone: tz },
            end: { dateTime: change.end, timeZone: tz },
          }
        : {}),
    });
    normalize(this.events.get(id)!);
  }
  invalidateSyncTokens() {
    this.invalidatedBefore = this.seq + 1;
  }

  // ---------- HTTP ----------

  private json(status: number, body: unknown, headers: Record<string, string> = {}) {
    return new Response(body === null ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  }

  private async handle(req: Request): Promise<Response> {
    const u = new URL(req.url);
    const text = await req.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = Object.fromEntries(new URLSearchParams(text));
      }
    }
    const headers = Object.fromEntries(req.headers.entries());
    this.requests.push({ method: req.method, path: u.pathname + u.search, headers, body });

    if (u.pathname === '/token') return this.token(body as Record<string, string>);
    if (u.pathname === '/revoke') return this.json(200, {});

    const f = this.failures.find((x) => x.times > 0 && (!x.match || x.match.test(u.pathname)));
    if (f) {
      f.times -= 1;
      return this.json(
        f.status,
        {
          error: {
            code: f.status,
            message: 'fake failure',
            errors: [{ reason: f.status === 403 ? 'rateLimitExceeded' : 'backendError' }],
          },
        },
        f.headers,
      );
    }
    const auth = headers.authorization?.replace(/^Bearer /, '');
    const who = auth ? this.validTokens.get(auth) : undefined;
    if (!who) return this.json(401, { error: { code: 401, message: 'Invalid Credentials' } });
    this.who = who;

    if (u.pathname === '/calendar/v3/channels/stop') {
      this.stopped.push(body as { id: string; resourceId: string });
      return new Response(null, { status: 204 });
    }
    const m = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?(?:\/(instances))?$/.exec(
      u.pathname,
    );
    if (!m) return this.json(404, { error: { message: 'not found' } });
    const [, , rawId, sub] = m;
    const id = rawId ? decodeURIComponent(rawId) : undefined;

    if (id === 'watch' && req.method === 'POST') {
      const b = body as { id: string; address: string; token: string; expiration: string };
      const resourceId = `res-${this.watches.length + 1}`;
      this.watches.push({ id: b.id, address: b.address, token: b.token, resourceId });
      return this.json(200, {
        kind: 'api#channel',
        id: b.id,
        resourceId,
        expiration: b.expiration,
      });
    }
    if (!id) {
      if (req.method === 'POST') return this.insert(body as FakeEvent);
      if (req.method === 'GET') return this.list(u.searchParams);
    }
    if (id && sub === 'instances') return this.instances(id, u.searchParams);
    if (id && req.method === 'PATCH' && !this.events.has(id)) {
      const mm = /^(.+)_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(id);
      const series = mm ? this.events.get(mm[1]!) : undefined;
      if (mm && series) {
        const orig = `${mm[2]}-${mm[3]}-${mm[4]}T${mm[5]}:${mm[6]}:${mm[7]}.000Z`;
        this.events.set(
          id,
          normalize({
            id,
            owner: series.owner,
            etag: this.etag(),
            seq: this.seq,
            status: 'confirmed',
            recurringEventId: series.id,
            originalStartTime: { dateTime: orig, timeZone: series.start?.timeZone },
            summary: series.summary,
          }),
        );
      }
    }
    if (id) {
      const found = this.events.get(id);
      const ev = found && (found.owner ?? 'default') === who ? found : undefined;
      if (req.method === 'GET')
        return ev
          ? this.json(200, this.out(ev))
          : this.json(404, { error: { message: 'Not Found' } });
      if (!ev) return this.json(404, { error: { message: 'Not Found' } });
      if (req.method === 'DELETE') {
        if (ev.status === 'cancelled')
          return this.json(410, { error: { message: 'Resource has been deleted' } });
        Object.assign(ev, { status: 'cancelled', etag: this.etag(), seq: ++this.seq });
        return new Response(null, { status: 204 });
      }
      if (req.method === 'PUT' || req.method === 'PATCH') {
        const ifMatch = headers['if-match'];
        if (ifMatch && ifMatch !== ev.etag)
          return this.json(412, { error: { message: 'Precondition Failed' } });
        const b = body as Partial<FakeEvent>;
        if (req.method === 'PUT') {
          const keep = {
            id: ev.id,
            owner: ev.owner,
            htmlLink: ev.htmlLink,
            recurringEventId: ev.recurringEventId,
            originalStartTime: ev.originalStartTime,
          };
          for (const k of Object.keys(ev)) delete (ev as unknown as Record<string, unknown>)[k];
          Object.assign(ev, keep, b, { status: b.status ?? 'confirmed' });
        } else Object.assign(ev, b);
        Object.assign(ev, { etag: this.etag(), seq: ++this.seq });
        normalize(ev);
        return this.json(200, this.out(ev));
      }
    }
    return this.json(405, { error: { message: 'unsupported' } });
  }

  private out(ev: FakeEvent) {
    const { seq: _s, owner: _o, ...rest } = ev;
    void _s;
    void _o;
    return rest;
  }

  private token(b: Record<string, string>) {
    if (b.grant_type === 'authorization_code') {
      // "good-code:<person>" — a successful consent by that person.
      const m = /^good-code(?::(.+))?$/.exec(b.code ?? '');
      if (!m) return this.json(400, { error: 'invalid_grant' });
      const who = m[1] ?? 'default';
      const access = `at-${crypto.randomUUID()}`;
      const refresh = `rt-${crypto.randomUUID()}`;
      this.validTokens.set(access, who);
      this.refreshOwners.set(refresh, who);
      return this.json(200, {
        access_token: access,
        refresh_token: refresh,
        expires_in: 3600,
        token_type: 'Bearer',
      });
    }
    if (b.grant_type === 'refresh_token') {
      const who = this.refreshOwners.get(b.refresh_token!);
      if (!who || this.revokedRefresh.has(who) || this.revokedRefresh.has('*'))
        return this.json(400, { error: 'invalid_grant' });
      const access = `at-${crypto.randomUUID()}`;
      this.validTokens.set(access, who);
      return this.json(200, { access_token: access, expires_in: 3600 });
    }
    return this.json(400, { error: 'unsupported_grant_type' });
  }

  /** Expire every access token (forces a refresh). */
  expireAccessTokens() {
    this.validTokens.clear();
  }

  /** Events in one person's calendar. */
  calendarOf(who: string) {
    return [...this.events.values()].filter((e) => (e.owner ?? 'default') === who);
  }

  private insert(b: FakeEvent) {
    if (b.id && this.events.has(b.id))
      return this.json(409, {
        error: { code: 409, message: 'The requested identifier already exists.' },
      });
    const id = b.id ?? crypto.randomUUID().replace(/-/g, '');
    const ev: FakeEvent = normalize({
      ...b,
      id,
      owner: this.who,
      status: b.status ?? 'confirmed',
      etag: this.etag(),
      seq: ++this.seq,
      htmlLink: `https://calendar.example/${id}`,
    });
    this.events.set(id, ev);
    return this.json(200, this.out(ev));
  }

  private list(q: URLSearchParams) {
    const token = q.get('syncToken');
    let items: FakeEvent[];
    if (token) {
      const since = Number(token.replace('st-', ''));
      if (since < this.invalidatedBefore)
        return this.json(410, {
          error: { code: 410, message: 'Sync token is no longer valid, a full sync is required.' },
        });
      items = [...this.events.values()].filter((e) => e.seq > since);
    } else {
      items = [...this.events.values()].filter(
        (e) => e.status !== 'cancelled' || !!e.recurringEventId,
      );
    }
    items = items.filter((e) => (e.owner ?? 'default') === this.who);
    items.sort((a, b) => a.seq - b.seq);
    const max = Number(q.get('maxResults') ?? 250);
    const offset = Number(q.get('pageToken') ?? 0);
    const page = items.slice(offset, offset + max);
    const more = offset + max < items.length;
    return this.json(200, {
      items: page.map((e) => this.out(e)),
      ...(more ? { nextPageToken: String(offset + max) } : { nextSyncToken: `st-${this.seq}` }),
    });
  }

  private instances(id: string, q: URLSearchParams) {
    const ev = this.events.get(id);
    if (!ev?.recurrence || !ev.start?.dateTime || !ev.end?.dateTime)
      return this.json(200, { items: [] });
    const tz = ev.start.timeZone ?? 'UTC';
    const startLocal = ev.start.dateTime.slice(0, 16);
    const parsed = fromRRule(ev.recurrence, startLocal, tz);
    if (!parsed.ok) return this.json(200, { items: [] });
    const dur =
      (Date.parse(`${ev.end.dateTime.slice(0, 19)}Z`) -
        Date.parse(`${ev.start.dateTime.slice(0, 19)}Z`)) /
      60000;
    const min = Date.parse(q.get('timeMin')!);
    const max = Date.parse(q.get('timeMax')!);
    const items = seriesOccurrences(startLocal, dur, tz, parsed.rule)
      .filter((o) => o.startUtc >= min && o.startUtc < max)
      .map((o) => {
        const iid = `${id}_${o.key.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
        const exc = this.events.get(iid);
        if (exc) return this.out(exc);
        return {
          id: iid,
          etag: ev.etag,
          status: 'confirmed',
          recurringEventId: id,
          originalStartTime: { dateTime: o.key, timeZone: tz },
          start: { dateTime: `${formatLocal(utcToLocal(o.startUtc, tz))}:00`, timeZone: tz },
          end: { dateTime: `${formatLocal(utcToLocal(o.endUtc, tz))}:00`, timeZone: tz },
        };
      });
    // Patching an instance creates the exception.
    return this.json(200, { items });
  }
}
