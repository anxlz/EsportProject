/**
 * Phase 6 — Notion (organization-level), end to end against a local stand-in of Notion's API
 * (fake-notion.ts). Exercises the real adapter, the webhook signature check, the merge rules,
 * duplicate prevention and rate-limit handling. No call goes to Notion.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { IntegrationDto, IntegrationEventDto, MeetingDto } from '@esports/shared';
import { and, eq } from 'drizzle-orm';
import { createHmac } from 'node:crypto';
import { auditLogs } from '../src/db/schema';
import {
  integrationConnections,
  integrationEvents,
  integrationJobs,
  integrationLinks,
} from '../src/db/schema-meetings';
import { IntegrationsWorker } from '../src/integrations/worker.service';
import { FakeNotion, prop } from './fake-notion';
import { financeOrg, withRole } from './finance-fixtures';
import { type Client, startApp, type TestApp } from './harness';

let t: TestApp;
let worker: IntegrationsWorker;
const notion = new FakeNotion().start();
let nowMs = Date.parse('2026-10-20T09:00:00Z');

beforeAll(async () => {
  t = await startApp({ now: () => nowMs, env: { NOTION_API_URL: notion.url } });
  worker = t.app.get(IntegrationsWorker);
});
afterAll(async () => {
  await t.close();
  notion.stop();
});
beforeEach(async () => {
  await t.reset();
  notion.reset();
  nowMs = Date.parse('2026-10-20T09:00:00Z');
});

async function drain() {
  for (let i = 0; i < 10; i++) if (!(await worker.runDue())) break;
}

async function setup() {
  const f = await financeOrg(t);
  const manager = await withRole(t, f.owner, 'manager@example.com', 'esports_manager', {
    type: 'team',
    id: f.teamA.id,
  });
  const m = (
    await f.owner.post<MeetingDto>('/meetings', {
      title: 'Sponsor review',
      description: 'Quarterly review with the jersey sponsor.',
      notes: 'Agenda: renewal terms.',
      start: '2026-10-21T18:00',
      end: '2026-10-21T19:00',
      timeZone: 'Asia/Riyadh',
      recurrence: { freq: 'weekly', byWeekday: ['WE'], end: { type: 'count', count: 6 } },
      teamId: f.teamA.id,
      participantUserIds: [manager.me.user.id],
    })
  ).body;
  const conn = await f.owner.post<IntegrationDto>('/integrations/notion', {
    token: notion.token,
    database: `https://www.notion.so/acme/Team-meetings-${notion.databaseId}?v=abc`,
    timeZone: 'Asia/Riyadh',
  });
  expect(conn.status).toBe(201);
  return { ...f, manager, m, conn: conn.body };
}

/** A Notion webhook delivery, signed (or not) the way Notion signs it. */
function deliver(connId: string, payload: unknown, token?: string | null, tamper = false) {
  const raw = JSON.stringify(payload);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token)
    headers['x-notion-signature'] = `sha256=${createHmac('sha256', token)
      .update(tamper ? `${raw} ` : raw)
      .digest('hex')}`;
  return t
    .client()
    .request(
      'POST',
      `/integrations/hooks/notion/${connId}`,
      new TextEncoder().encode(raw),
      headers,
    );
}

const pageOf = (meetingId: string) =>
  [...notion.pages.values()].find(
    (p) =>
      ((p.properties['Platform ID'] as { rich_text: { plain_text: string }[] })?.rich_text ?? [])
        .map((x) => x.plain_text)
        .join('') === meetingId,
  )!;

const events = async (c: Client, id: string) =>
  (await c.get<IntegrationEventDto[]>(`/integrations/${id}/events`)).body;

describe('Notion two-way sync', () => {
  test('connect adds the properties; meetings become pages; signed webhooks bring edits back; unsigned ones are refused', async () => {
    const o = await setup();
    expect(o.conn).toMatchObject({
      provider: 'notion',
      personal: false,
      direction: 'two_way',
      settings: { databaseTitle: 'Team meetings', verificationToken: null },
    });
    expect(Object.keys(notion.properties).sort()).toEqual([
      'Name',
      'Notes',
      'Owner',
      'Participants',
      'Platform ID',
      'Purpose',
      'Repeats',
      'Status',
      'Team',
      'When',
    ]);
    const [row] = await t.db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, o.conn.id));
    expect(row!.secrets).not.toContain(notion.token);

    await drain();
    const page = pageOf(o.m.id);
    expect(page.properties).toMatchObject({
      Name: { title: [{ plain_text: 'Sponsor review' }] },
      When: {
        date: {
          start: '2026-10-21T18:00:00.000',
          end: '2026-10-21T19:00:00.000',
          time_zone: 'Asia/Riyadh',
        },
      },
      Status: { select: { name: 'Scheduled' } },
      Team: { rich_text: [{ plain_text: 'Valorant Team A' }] },
      Purpose: { rich_text: [{ plain_text: 'Quarterly review with the jersey sponsor.' }] },
      Notes: { rich_text: [{ plain_text: 'Agenda: renewal terms.' }] },
      Repeats: { rich_text: [{ plain_text: 'FREQ=WEEKLY;BYDAY=WE;COUNT=6' }] },
    });
    expect(notion.calls('POST', /\/v1\/pages$/)).toHaveLength(1);
    expect(notion.requests.every((r) => r.headers['notion-version'] === '2026-03-11')).toBe(true);

    // The subscription's verification request (unsigned by Notion's design) is kept once.
    expect((await deliver(o.conn.id, { verification_token: 'secret_verify_abc' })).status).toBe(
      200,
    );
    expect(
      (await o.owner.get<IntegrationDto>(`/integrations/${o.conn.id}`)).body.settings
        .verificationToken,
    ).toBe('secret_verify_abc');
    expect((await deliver(o.conn.id, { verification_token: 'attacker' })).status).toBe(401);

    // Events must be signed with it.
    const event = {
      id: crypto.randomUUID(),
      type: 'page.properties_updated',
      entity: { id: page.id, type: 'page' },
      data: { parent: { data_source_id: notion.dataSourceId } },
      attempt_number: 1,
    };
    expect((await deliver(o.conn.id, event)).status).toBe(401);
    expect((await deliver(o.conn.id, event, 'wrong-token')).status).toBe(401);
    expect((await deliver(o.conn.id, event, 'secret_verify_abc', true)).status).toBe(401);
    expect((await deliver(crypto.randomUUID(), event, 'secret_verify_abc')).status).toBe(401);
    let pulls = await t.db
      .select()
      .from(integrationJobs)
      .where(and(eq(integrationJobs.connectionId, o.conn.id), eq(integrationJobs.kind, 'pull')));
    expect(pulls).toHaveLength(0);

    notion.userEdit(page.id, { Notes: prop.text('Agenda: renewal terms, new kit colours.') });
    expect((await deliver(o.conn.id, event, 'secret_verify_abc')).status).toBe(200);
    pulls = await t.db
      .select()
      .from(integrationJobs)
      .where(and(eq(integrationJobs.connectionId, o.conn.id), eq(integrationJobs.kind, 'pull')));
    expect(pulls).toHaveLength(1);
    await drain();
    expect((await o.owner.get<MeetingDto>(`/meetings/${o.m.id}`)).body.notes).toBe(
      'Agenda: renewal terms, new kit colours.',
    );
    const [audit] = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'meeting.updated'), eq(auditLogs.targetId, o.m.id)));
    expect(audit!.metadata).toMatchObject({
      changed: ['notes'],
      via: 'notion',
      connectionId: o.conn.id,
    });

    // Conflict: notes changed in both places → the platform's version is kept and written back.
    await o.owner.patch(`/meetings/${o.m.id}`, { notes: 'Platform notes' });
    notion.userEdit(page.id, { Notes: prop.text('Notion notes') });
    await drain();
    expect((await o.owner.get<MeetingDto>(`/meetings/${o.m.id}`)).body.notes).toBe(
      'Platform notes',
    );
    expect(
      (pageOf(o.m.id).properties.Notes as { rich_text: { plain_text: string }[] }).rich_text[0]!
        .plain_text,
    ).toBe('Platform notes');
    expect(
      (await events(o.owner, o.conn.id)).find((e) => e.code === 'conflict_resolved')!.detail,
    ).toMatchObject({
      conflicts: [{ field: 'notes', platform: 'Platform notes', provider: 'Notion notes' }],
    });
  });

  test('an interrupted create is recovered without a duplicate page; new pages in the database are imported', async () => {
    const o = await setup();
    // As if an earlier attempt created the page but failed before recording the link.
    notion.userCreate({
      Name: prop.title('Sponsor review'),
      'Platform ID': prop.text(o.m.id),
      When: prop.when('2026-10-21T18:00:00.000', '2026-10-21T19:00:00.000', 'Asia/Riyadh'),
    });
    await drain();
    expect([...notion.pages.values()]).toHaveLength(1);
    expect(pageOf(o.m.id).properties.Status).toEqual({
      type: 'select',
      select: { name: 'Scheduled' },
    });

    const id = notion.userCreate({
      Name: prop.title('Bootcamp planning'),
      When: prop.when('2026-11-02T10:00:00.000', '2026-11-02T12:00:00.000', 'Asia/Riyadh'),
      Notes: prop.text('Book the venue.'),
    });
    await o.owner.post(`/integrations/${o.conn.id}/sync`);
    await drain();
    const [link] = await t.db
      .select()
      .from(integrationLinks)
      .where(and(eq(integrationLinks.connectionId, o.conn.id), eq(integrationLinks.remoteId, id)));
    const imported = (await o.owner.get<MeetingDto>(`/meetings/${link!.meetingId}`)).body;
    expect(imported).toMatchObject({
      title: 'Bootcamp planning',
      notes: 'Book the venue.',
      source: 'notion',
      start: '2026-11-02T10:00:00+03:00',
      durationMinutes: 120,
    });
    expect(
      (notion.pages.get(id)!.properties['Platform ID'] as { rich_text: { plain_text: string }[] })
        .rich_text[0]!.plain_text,
    ).toBe(imported.id);
    // Synced again: still one page per meeting.
    await o.owner.post(`/integrations/${o.conn.id}/sync`);
    await drain();
    expect([...notion.pages.values()]).toHaveLength(2);
  });

  test('a page moved to the trash cancels the meeting when the owner may; a 429 waits as long as Notion asks', async () => {
    const o = await setup();
    await drain();
    await deliver(o.conn.id, { verification_token: 'tok' });
    const page = pageOf(o.m.id);
    notion.userTrash(page.id);
    expect(
      (
        await deliver(
          o.conn.id,
          { id: crypto.randomUUID(), type: 'page.deleted', entity: { id: page.id, type: 'page' } },
          'tok',
        )
      ).status,
    ).toBe(200);
    await drain();
    expect((await o.owner.get<MeetingDto>(`/meetings/${o.m.id}`)).body.status).toBe('cancelled');

    const m2 = (
      await o.owner.post<MeetingDto>('/meetings', {
        title: 'Another',
        start: '2026-10-22T18:00',
        end: '2026-10-22T19:00',
        timeZone: 'Asia/Riyadh',
        teamId: o.teamA.id,
      })
    ).body;
    notion.failNext(429, 1, { 'retry-after': '12' });
    await worker.runDue();
    const [job] = await t.db
      .select()
      .from(integrationJobs)
      .where(and(eq(integrationJobs.meetingId, m2.id), eq(integrationJobs.status, 'pending')));
    expect(job!.nextAttemptAt.getTime() - nowMs).toBe(12_000);
    expect(job!.attempts).toBe(0);
  });

  test('only integrations.manage connects Notion; a bad token or database is refused; the log is append-only', async () => {
    const o = await setup();
    const head = await withRole(t, o.owner, 'head@example.com', 'head_of_esports', {
      type: 'organization',
    });
    expect(
      (
        await head.client.post('/integrations/notion', {
          token: notion.token,
          database: notion.databaseId,
        })
      ).status,
    ).toBe(403);
    expect((await head.client.get(`/integrations/${o.conn.id}`)).status).toBe(404);
    const badToken = await o.owner.post('/integrations/notion', {
      token: 'secret_wrong_token_0000000000',
      database: notion.databaseId,
    });
    expect(badToken.status).toBe(400);
    expect(badToken.body.error.code).toBe('integration_unavailable');
    const badDb = await o.owner.post('/integrations/notion', {
      token: notion.token,
      database: 'ffffffffffffffffffffffffffffffff',
    });
    expect(badDb.status).toBe(400);
    expect(badDb.body.error.details).toMatchObject({ reason: 'not_found' });
    const [e] = await t.db
      .select()
      .from(integrationEvents)
      .where(eq(integrationEvents.connectionId, o.conn.id));
    await expect(
      Promise.resolve(
        t.db.update(integrationEvents).set({ message: 'x' }).where(eq(integrationEvents.id, e!.id)),
      ),
    ).rejects.toThrow();
    await expect(
      Promise.resolve(t.db.delete(integrationEvents).where(eq(integrationEvents.id, e!.id))),
    ).rejects.toThrow();
  });
});
