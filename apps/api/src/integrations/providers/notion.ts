/**
 * Notion (organization-level): meetings as pages in a Notion database, through an internal
 * integration token. Shapes follow Notion's API reference, version 2026-03-11 (read 20 Oct
 * 2026): databases contain data sources; pages are created with a `data_source_id` parent and
 * queried with POST /v1/data_sources/{id}/query; `in_trash` replaces `archived`.
 *
 * Properties (added to the data source if missing): the database's title property, "When"
 * (date with start, end and time zone), "Status" (Scheduled / Cancelled), "Purpose", "Notes",
 * and, written by the platform only, "Platform ID", "Team", "Repeats", "Participants".
 * Two-way: title, When, Status, Purpose and Notes. Recurrence can't be expressed in Notion, so
 * "Repeats" is informative and edits to it are ignored.
 *
 * Change detection: Notion's last_edited_time is rounded to the minute, so a record's version is
 * a hash of the synced properties instead; changes are found by querying pages edited since the
 * last position (minus two minutes of overlap) and, faster, from signed webhook events.
 *
 * Duplicates: Notion has no idempotency key, so before creating a page we look for one whose
 * "Platform ID" is the meeting's id (recovers from an interrupted create).
 *
 * Rate limits: Notion allows an average of 3 requests/second per connection (180/minute); we
 * stay under 150/minute and honour 429 Retry-After.
 */
import { Inject, Injectable } from '@nestjs/common';
import { formatLocal, isValidTimeZone, toRRule, utcToLocal } from '@esports/shared';
import { eq } from 'drizzle-orm';
import { NOW, type Now } from '../../common/now';
import { RateLimitService } from '../../common/rate-limit';
import { sha256 } from '../../common/crypto';
import { type Env, ENV } from '../../config/env';
import { DB, type Database } from '../../db/client';
import { integrationConnections } from '../../db/schema-meetings';
import { type ConnectionRow, ConnectionsService } from '../connections.service';
import { IntegrationError } from '../errors';
import { type Snapshot, type SnapshotKey, stable } from '../sync-engine';
import { httpJson, reserve } from './http';
import type { LinkRow, MeetingView, RemoteChanges, RemoteProvider, RemoteRecord } from './types';

const PER_MINUTE = 150;
const OVERLAP_MS = 2 * 60_000;

export const NOTION_PROPS = {
  platformId: 'Platform ID',
  when: 'When',
  status: 'Status',
  team: 'Team',
  purpose: 'Purpose',
  notes: 'Notes',
  repeats: 'Repeats',
  participants: 'Participants',
} as const;

const STATUS = { scheduled: 'Scheduled', cancelled: 'Cancelled' } as const;

type RichText = { type?: string; plain_text?: string; text?: { content: string } }[];
interface NotionPage {
  object?: string;
  id: string;
  url?: string;
  in_trash?: boolean;
  archived?: boolean;
  last_edited_time?: string;
  properties?: Record<
    string,
    {
      type?: string;
      title?: RichText;
      rich_text?: RichText;
      date?: { start?: string; end?: string | null; time_zone?: string | null } | null;
      select?: { name?: string } | null;
    }
  >;
}

/** Notion ids: 32 hex characters, with or without dashes, possibly inside a URL. */
export function parseNotionId(input: string): string | null {
  const path = input.split('?')[0]!.split('#')[0]!;
  const m = path.replace(/-/g, '').match(/[0-9a-f]{32}(?![0-9a-f])/gi);
  const hex = m?.[m.length - 1]?.toLowerCase();
  if (!hex) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Text as Notion rich text: 2,000 characters per text object, at most 100 objects. */
export function richText(s: string | null | undefined) {
  const text = (s ?? '').slice(0, 200_000);
  const out: { type: 'text'; text: { content: string } }[] = [];
  for (let i = 0; i < text.length && out.length < 100; i += 2000)
    out.push({ type: 'text', text: { content: text.slice(i, i + 2000) } });
  return out;
}

const plain = (rt: RichText | undefined) =>
  (rt ?? []).map((t) => t.plain_text ?? t.text?.content ?? '').join('');

export function pageToRecord(
  page: NotionPage,
  cfg: { titleProperty: string; timeZone: string },
): RemoteRecord {
  const props = page.properties ?? {};
  const platformMeetingId = plain(props[NOTION_PROPS.platformId]?.rich_text).trim() || null;
  const deleted = page.in_trash === true || page.archived === true;
  const base = { id: page.id, url: page.url ?? null, deleted, platformMeetingId };
  const title = plain(props[cfg.titleProperty]?.title).trim();
  const date = props[NOTION_PROPS.when]?.date;
  if (!date?.start || !/T\d{2}:\d{2}/.test(date.start)) {
    return {
      ...base,
      version: sha256(stable({ title, date: date ?? null })),
      snapshot: null,
      unsupported: date?.start ? 'all_day' : 'no_time',
    };
  }
  let tz = date.time_zone && isValidTimeZone(date.time_zone) ? date.time_zone : cfg.timeZone;
  if (!isValidTimeZone(tz)) tz = 'UTC';
  const read = (v: string) => {
    // With a time zone, Notion's start/end carry no offset (wall-clock); otherwise they do.
    if (date.time_zone && !/[zZ]|[+-]\d{2}:\d{2}$/.test(v)) return v.slice(0, 16);
    return formatLocal(utcToLocal(Date.parse(v), tz));
  };
  const startLocal = read(date.start);
  const endLocal = date.end
    ? read(date.end)
    : formatLocal(utcToLocal(Date.parse(`${startLocal}:00Z`) + 3_600_000, 'UTC'));
  const snapshot: Partial<Snapshot> = {
    title,
    description: plain(props[NOTION_PROPS.purpose]?.rich_text).trim() || null,
    notes: plain(props[NOTION_PROPS.notes]?.rich_text).trim() || null,
    time: { startLocal, endLocal, timeZone: tz },
    status:
      props[NOTION_PROPS.status]?.select?.name === STATUS.cancelled ? 'cancelled' : 'scheduled',
  };
  return { ...base, version: sha256(stable({ snapshot, deleted })), snapshot };
}

@Injectable()
export class NotionProvider implements RemoteProvider {
  readonly name = 'notion' as const;
  readonly inboundKeys: SnapshotKey[] = ['title', 'description', 'notes', 'time', 'status'];

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(DB) private readonly db: Database,
    @Inject(NOW) private readonly now: Now,
    private readonly connections: ConnectionsService,
    private readonly limiter: RateLimitService,
  ) {}

  importsNew() {
    return true;
  }

  private cfg(c: ConnectionRow) {
    const cfg = c.config as { titleProperty?: string; timeZone?: string; dataSourceId?: string };
    return {
      titleProperty: cfg.titleProperty ?? 'Name',
      timeZone: cfg.timeZone ?? 'UTC',
      dataSourceId: cfg.dataSourceId ?? '',
    };
  }

  /** One API call with a raw token (also used before the connection exists). */
  async call<T>(token: string, bucket: string, method: string, path: string, body?: unknown) {
    await reserve(this.limiter, `notion:${bucket}`, PER_MINUTE);
    const r = await httpJson<T & { code?: string; message?: string }>(
      'Notion',
      new URL(path, this.env.NOTION_API_URL).toString(),
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          'notion-version': this.env.NOTION_VERSION,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        timeoutMs: this.env.INTEGRATIONS_TIMEOUT_MS,
      },
    );
    if (r.status >= 200 && r.status < 300) return r.body;
    const code = (r.body as { code?: string } | null)?.code ?? '';
    if (r.status === 409)
      throw new IntegrationError(
        'retryable',
        'conflict_error',
        'Notion reported a conflicting edit',
      );
    if (r.status === 403 || r.status === 404)
      throw new IntegrationError(
        'permanent',
        code === 'restricted_resource' || r.status === 403 ? 'not_shared' : 'not_found',
        'Notion: the database is not shared with the integration, or no longer exists',
        undefined,
        r.status,
      );
    throw IntegrationError.fromStatus('Notion', r.status, r.headers.get('retry-after'), code);
  }

  private api<T>(c: ConnectionRow, method: string, path: string, body?: unknown) {
    const s = this.connections.secrets<{ token?: string }>(c);
    if (!s.token) throw new IntegrationError('auth', 'not_connected', 'Notion is not connected');
    return this.call<T>(s.token, c.id, method, path, body);
  }

  /** Connect: find the database's data source, make sure the properties exist. */
  async resolveDatabase(token: string, input: string) {
    const databaseId = parseNotionId(input);
    if (!databaseId)
      throw new IntegrationError(
        'permanent',
        'invalid_database',
        'Not a Notion database id or link',
      );
    const db = await this.call<{
      id: string;
      title?: RichText;
      data_sources?: { id: string; name?: string }[];
    }>(token, `connect:${sha256(token).slice(0, 16)}`, 'GET', `/v1/databases/${databaseId}`);
    const dataSourceId = db.data_sources?.[0]?.id;
    if (!dataSourceId)
      throw new IntegrationError(
        'permanent',
        'invalid_database',
        'The database has no data source',
      );
    const ds = await this.call<{ properties?: Record<string, { type?: string }> }>(
      token,
      `connect:${sha256(token).slice(0, 16)}`,
      'GET',
      `/v1/data_sources/${dataSourceId}`,
    );
    const props = ds.properties ?? {};
    const titleProperty = Object.entries(props).find(([, p]) => p.type === 'title')?.[0] ?? 'Name';
    const wanted: Record<string, unknown> = {
      [NOTION_PROPS.platformId]: { rich_text: {} },
      [NOTION_PROPS.when]: { date: {} },
      [NOTION_PROPS.status]: {
        select: { options: [{ name: STATUS.scheduled }, { name: STATUS.cancelled }] },
      },
      [NOTION_PROPS.team]: { rich_text: {} },
      [NOTION_PROPS.purpose]: { rich_text: {} },
      [NOTION_PROPS.notes]: { rich_text: {} },
      [NOTION_PROPS.repeats]: { rich_text: {} },
      [NOTION_PROPS.participants]: { rich_text: {} },
    };
    const missing = Object.fromEntries(Object.entries(wanted).filter(([k]) => !props[k]));
    if (Object.keys(missing).length)
      await this.call(
        token,
        `connect:${sha256(token).slice(0, 16)}`,
        'PATCH',
        `/v1/data_sources/${dataSourceId}`,
        {
          properties: missing,
        },
      );
    return { databaseId, dataSourceId, titleProperty, databaseTitle: plain(db.title) || null };
  }

  private properties(c: ConnectionRow, view: MeetingView) {
    const s = view.snapshot;
    const l = view.loaded;
    const { titleProperty } = this.cfg(c);
    return {
      [titleProperty]: { title: richText(s.title) },
      [NOTION_PROPS.platformId]: { rich_text: richText(l.row.id) },
      [NOTION_PROPS.when]: {
        date: {
          start: `${s.time.startLocal}:00.000`,
          end: `${s.time.endLocal}:00.000`,
          time_zone: s.time.timeZone,
        },
      },
      [NOTION_PROPS.status]: {
        select: { name: s.status === 'cancelled' ? STATUS.cancelled : STATUS.scheduled },
      },
      [NOTION_PROPS.team]: { rich_text: richText(l.team?.name ?? l.departmentName ?? '') },
      [NOTION_PROPS.purpose]: { rich_text: richText(s.description) },
      [NOTION_PROPS.notes]: { rich_text: richText(s.notes) },
      [NOTION_PROPS.repeats]: {
        rich_text: richText(
          s.recurrence ? toRRule(s.recurrence, s.time.startLocal, s.time.timeZone).slice(6) : '',
        ),
      },
      [NOTION_PROPS.participants]: {
        rich_text: richText(l.participants.map((p) => p.displayName).join(', ')),
      },
    };
  }

  private record(c: ConnectionRow, page: NotionPage) {
    return pageToRecord(page, this.cfg(c));
  }

  async create(c: ConnectionRow, view: MeetingView): Promise<RemoteRecord> {
    const existing = await this.find(c, view.loaded.row.id);
    if (existing) return this.update(c, { remoteId: existing.id } as LinkRow, view);
    const page = await this.api<NotionPage>(c, 'POST', '/v1/pages', {
      parent: { type: 'data_source_id', data_source_id: this.cfg(c).dataSourceId },
      properties: this.properties(c, view),
    });
    return this.record(c, page);
  }

  async update(
    c: ConnectionRow,
    link: Pick<LinkRow, 'remoteId'>,
    view: MeetingView,
  ): Promise<RemoteRecord> {
    const page = await this.api<NotionPage>(c, 'PATCH', `/v1/pages/${link.remoteId}`, {
      properties: this.properties(c, view),
      in_trash: false,
    });
    return this.record(c, page);
  }

  /** No longer carried (team filter, visibility): the page goes to Notion's trash. */
  async remove(c: ConnectionRow, link: LinkRow): Promise<void> {
    if (!link.remoteId) return;
    try {
      await this.api(c, 'PATCH', `/v1/pages/${link.remoteId}`, { in_trash: true });
    } catch (e) {
      if (e instanceof IntegrationError && e.code === 'not_found') return;
      throw e;
    }
  }

  async get(c: ConnectionRow, remoteId: string): Promise<RemoteRecord | null> {
    try {
      return this.record(c, await this.api<NotionPage>(c, 'GET', `/v1/pages/${remoteId}`));
    } catch (e) {
      if (e instanceof IntegrationError && e.code === 'not_found') return null;
      throw e;
    }
  }

  async find(c: ConnectionRow, meetingId: string): Promise<RemoteRecord | null> {
    const r = await this.api<{ results?: NotionPage[] }>(
      c,
      'POST',
      `/v1/data_sources/${this.cfg(c).dataSourceId}/query`,
      {
        filter: { property: NOTION_PROPS.platformId, rich_text: { equals: meetingId } },
        page_size: 5,
      },
    );
    const page = (r.results ?? []).find((p) => !p.in_trash);
    return page ? this.record(c, page) : null;
  }

  async changes(
    c: ConnectionRow,
    opts: { full: boolean; pageIds?: string[] },
  ): Promise<RemoteChanges> {
    const records: RemoteRecord[] = [];
    // Pages named by webhook events (deleted / restored pages don't show up in queries).
    for (const id of opts.pageIds ?? []) {
      const rec = await this.get(c, id);
      if (rec) records.push(rec);
    }
    const cursor = c.cursor as { editedSince?: string };
    const since =
      opts.full || !cursor.editedSince
        ? null
        : new Date(Date.parse(cursor.editedSince) - OVERLAP_MS).toISOString();
    let latest = cursor.editedSince ?? null;
    let startCursor: string | undefined;
    do {
      const r = await this.api<{
        results?: NotionPage[];
        has_more?: boolean;
        next_cursor?: string | null;
      }>(c, 'POST', `/v1/data_sources/${this.cfg(c).dataSourceId}/query`, {
        ...(since
          ? { filter: { timestamp: 'last_edited_time', last_edited_time: { on_or_after: since } } }
          : {}),
        sorts: [{ timestamp: 'last_edited_time', direction: 'ascending' }],
        page_size: 100,
        ...(startCursor ? { start_cursor: startCursor } : {}),
      });
      for (const p of r.results ?? []) {
        if (!records.some((x) => x.id === p.id)) records.push(this.record(c, p));
        if (p.last_edited_time && (!latest || p.last_edited_time > latest))
          latest = p.last_edited_time;
      }
      startCursor = r.has_more && r.next_cursor ? r.next_cursor : undefined;
    } while (startCursor);
    return {
      records,
      fullResync: false,
      commit: async () => {
        // Only Notion's own timestamps move the position (never our clock: they may differ).
        if (!latest) return;
        const next = { ...c.cursor, editedSince: latest };
        await this.db
          .update(integrationConnections)
          .set({ cursor: next })
          .where(eq(integrationConnections.id, c.id));
        c.cursor = next;
      },
    };
  }
}
