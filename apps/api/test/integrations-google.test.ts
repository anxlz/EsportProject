/**
 * Phase 6 — Google Calendar two-way sync, end to end: the real app (Postgres, Redis) and the
 * real adapter talking HTTP to a local stand-in of Google's API (fake-google.ts). No call goes
 * to Google: OAuth consent, quotas and push delivery from Google itself are not exercised.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type {
  IntegrationDto,
  IntegrationEventDto,
  MeetingDto,
  NotificationDto,
} from '@esports/shared';
import { and, eq } from 'drizzle-orm';
import { auditLogs } from '../src/db/schema';
import {
  integrationConnections,
  integrationJobs,
  integrationLinks,
  meetings,
} from '../src/db/schema-meetings';
import { googleEventId } from '../src/integrations/providers/google-calendar';
import { IntegrationsWorker } from '../src/integrations/worker.service';
import { FakeGoogle } from './fake-google';
import { financeOrg, withRole } from './finance-fixtures';
import { type Client, startApp, type TestApp } from './harness';

let t: TestApp;
let worker: IntegrationsWorker;
const google = new FakeGoogle().start();
let nowMs = Date.parse('2026-10-20T09:00:00Z');

beforeAll(async () => {
  t = await startApp({
    now: () => nowMs,
    env: {
      GOOGLE_CLIENT_ID: 'test-client-id',
      GOOGLE_CLIENT_SECRET: 'test-client-secret',
      GOOGLE_REDIRECT_URI: 'http://localhost:3000/api/integrations/google/callback',
      GOOGLE_API_URL: google.url,
      GOOGLE_TOKEN_URL: `${google.url}/token`,
      GOOGLE_AUTH_URL: `${google.url}/auth`,
      PUBLIC_API_URL: 'https://club.example/api',
    },
  });
  worker = t.app.get(IntegrationsWorker);
});
afterAll(async () => {
  await t.close();
  google.stop();
});
beforeEach(async () => {
  await t.reset();
  google.reset();
  nowMs = Date.parse('2026-10-20T09:00:00Z');
});

/** Runs due jobs until the queue is quiet (time advances past backoffs only when asked). */
async function drain() {
  for (let i = 0; i < 10; i++) if (!(await worker.runDue())) break;
}

async function connect(c: Client, who: string, query = 'direction=two_way') {
  const start = await c.get(`/integrations/google/start?${query}`);
  expect(start.status).toBe(302);
  const loc = new URL(start.headers.get('location')!);
  expect(loc.origin + loc.pathname).toBe(`${google.url}/auth`);
  expect(loc.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/calendar.events');
  expect(loc.searchParams.get('access_type')).toBe('offline');
  const back = await c.get(
    `/integrations/google/callback?code=good-code:${who}&state=${loc.searchParams.get('state')}`,
  );
  expect(back.status).toBe(302);
  expect(back.headers.get('location')).toBe(
    'http://localhost:3000/dashboard/integrations?connected=google_calendar',
  );
  const list = (await c.get('/integrations')).body as { connections: IntegrationDto[] };
  return list.connections.find((x) => x.provider === 'google_calendar')!;
}

async function org() {
  const f = await financeOrg(t);
  const manager = await withRole(t, f.owner, 'manager@example.com', 'esports_manager', {
    type: 'team',
    id: f.teamA.id,
  });
  const player = await withRole(t, f.owner, 'player@example.com', 'esports_operations', {
    type: 'team',
    id: f.teamA.id,
  });
  return { ...f, manager, player };
}

async function meeting(
  c: Client,
  teamId: string,
  invite: string[],
  extra: Record<string, unknown> = {},
) {
  const r = await c.post<MeetingDto>('/meetings', {
    title: 'Scrim review',
    start: '2026-10-21T18:00',
    end: '2026-10-21T19:00',
    timeZone: 'Asia/Riyadh',
    recurrence: { freq: 'weekly', byWeekday: ['WE'], end: { type: 'count', count: 6 } },
    teamId,
    participantUserIds: invite,
    ...extra,
  });
  expect(r.status).toBe(201);
  return r.body;
}

const events = async (c: Client, id: string) =>
  (await c.get<IntegrationEventDto[]>(`/integrations/${id}/events`)).body;

/** What Google would POST to our address after a change (headers from the watch we created). */
function pushHeaders(i = -1) {
  const w = google.watches.at(i)!;
  return {
    'x-goog-channel-id': w.id,
    'x-goog-channel-token': w.token,
    'x-goog-resource-id': w.resourceId,
    'x-goog-resource-state': 'exists',
    'x-goog-message-number': '2',
  };
}

describe('Phase 6 Definition of Done (integration part): Google Calendar two-way', () => {
  test('a recurring meeting syncs both ways; a conflict keeps the platform’s version, documented and notified; push notifications must authenticate', async () => {
    const o = await org();
    const m = await meeting(o.manager.client, o.teamA.id, [o.player.me.user.id]);
    const conn = await connect(o.manager.client, 'manager');
    expect(conn).toMatchObject({
      direction: 'two_way',
      status: 'active',
      personal: true,
      settings: { calendarId: 'primary' },
    });
    // The OAuth tokens are stored encrypted, never in clear.
    const [row] = await t.db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, conn.id));
    expect(row!.secrets).toStartWith('v1.');
    expect(row!.secrets).not.toContain('rt-');

    // Platform → Google: the watch channel and the meeting, as one recurring event.
    await drain();
    expect(google.watches).toHaveLength(1);
    expect(google.watches[0]!.address).toBe(
      `https://club.example/api/integrations/hooks/google/${conn.id}`,
    );
    const eventId = googleEventId(conn.id, m.id);
    const ev = google.events.get(eventId)!;
    expect(ev).toMatchObject({
      summary: 'Scrim review',
      status: 'confirmed', // the organizer has accepted
      start: { dateTime: '2026-10-21T18:00:00+03:00', timeZone: 'Asia/Riyadh' },
      end: { dateTime: '2026-10-21T19:00:00+03:00', timeZone: 'Asia/Riyadh' },
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=6'],
      extendedProperties: { private: { platformMeetingId: m.id, platformConnectionId: conn.id } },
    });
    expect(google.calls('POST', /\/events\?sendUpdates=none$/)).toHaveLength(1);
    // No duplicates however often it syncs.
    await o.manager.client.post(`/integrations/${conn.id}/sync`);
    await drain();
    expect(google.calendarOf('manager')).toHaveLength(1);
    expect(google.calls('POST', /\/events\?sendUpdates=none$/)).toHaveLength(1);
    expect((await o.manager.client.get<MeetingDto>(`/meetings/${m.id}`)).body.syncLinks).toEqual([
      expect.objectContaining({
        connectionId: conn.id,
        provider: 'google_calendar',
        remoteUrl: `https://calendar.example/${eventId}`,
      }),
    ]);

    // Push notifications must authenticate: no headers, a wrong token or channel → 401.
    const hook = (headers: Record<string, string>) =>
      t.client().request('POST', `/integrations/hooks/google/${conn.id}`, undefined, headers);
    expect((await hook({})).status).toBe(401);
    expect((await hook({ ...pushHeaders(), 'x-goog-channel-token': 'guess' })).status).toBe(401);
    expect(
      (await hook({ ...pushHeaders(), 'x-goog-channel-id': crypto.randomUUID() })).status,
    ).toBe(401);
    expect((await hook({ ...pushHeaders(), 'x-goog-resource-id': 'res-999' })).status).toBe(401);
    expect(
      (
        await t
          .client()
          .request(
            'POST',
            `/integrations/hooks/google/${crypto.randomUUID()}`,
            undefined,
            pushHeaders(),
          )
      ).status,
    ).toBe(401);
    const unauth = await t.db
      .select()
      .from(integrationJobs)
      .where(and(eq(integrationJobs.connectionId, conn.id), eq(integrationJobs.kind, 'pull')));
    expect(unauth).toHaveLength(0); // nothing was queued by the refused calls
    expect(
      (await events(o.manager.client, conn.id)).some((e) => e.code === 'signature_rejected'),
    ).toBe(true);

    // Google → platform: the title changed in Google Calendar; Google notifies; we pull.
    google.userEdit(eventId, { summary: 'Scrim review (moved room)' });
    expect((await hook(pushHeaders())).status).toBe(200);
    const puts = google.calls('PUT', /\/events\//).length;
    await drain();
    const after = (await o.manager.client.get<MeetingDto>(`/meetings/${m.id}`)).body;
    expect(after.title).toBe('Scrim review (moved room)');
    expect(google.calls('PUT', /\/events\//).length).toBe(puts); // not written back: no echo loop
    const [audit] = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'meeting.updated'), eq(auditLogs.targetId, m.id)));
    expect(audit!.metadata).toMatchObject({
      changed: ['title'],
      via: 'google_calendar',
      connectionId: conn.id,
    });
    expect(audit!.actorUserId).toBe(o.manager.me.user.id); // acting as the connection's owner
    // …and the invitee was told about the change, like any other edit.
    const told = (await o.player.client.get<NotificationDto[]>('/notifications')).body.filter(
      (n) => n.type === 'meeting.updated',
    );
    expect(told[0]!.data).toMatchObject({ changed: ['title'] });

    // Platform → Google again: a time change is written with If-Match on the last etag.
    await o.manager.client.patch(`/meetings/${m.id}`, {
      start: '2026-10-21T19:00',
      end: '2026-10-21T20:00',
    });
    await drain();
    expect(google.events.get(eventId)!.start).toEqual({
      dateTime: '2026-10-21T19:00:00+03:00',
      timeZone: 'Asia/Riyadh',
    });
    expect(google.calls('PUT', /\/events\//).at(-1)!.headers['if-match']).toMatch(/^"e\d+"$/);

    // CONFLICT: the title changes on both sides before the next sync.
    await o.manager.client.patch(`/meetings/${m.id}`, { title: 'Platform title' });
    google.userEdit(eventId, { summary: 'Google title' });
    await drain();
    expect((await o.manager.client.get<MeetingDto>(`/meetings/${m.id}`)).body.title).toBe(
      'Platform title',
    );
    expect(google.events.get(eventId)!.summary).toBe('Platform title'); // overwritten
    const conflict = (await events(o.manager.client, conn.id)).find(
      (e) => e.code === 'conflict_resolved',
    )!;
    expect(conflict).toMatchObject({
      level: 'warn',
      meetingId: m.id,
      detail: {
        rule: 'platform_wins',
        conflicts: [{ field: 'title', platform: 'Platform title', provider: 'Google title' }],
      },
    });
    const note = (await o.manager.client.get<NotificationDto[]>('/notifications')).body.find(
      (n) => n.type === 'integration.conflict',
    )!;
    expect(note.data).toMatchObject({
      meetingId: m.id,
      fields: 'title',
      provider: 'google_calendar',
    });

    // Different fields changed on each side are merged, not fought over.
    await o.manager.client.patch(`/meetings/${m.id}`, {
      start: '2026-10-21T17:00',
      end: '2026-10-21T18:00',
    });
    google.userEdit(eventId, { summary: 'Scrim review — bring headsets' });
    await drain();
    const merged = (await o.manager.client.get<MeetingDto>(`/meetings/${m.id}`)).body;
    expect(merged).toMatchObject({
      title: 'Scrim review — bring headsets',
      start: '2026-10-21T17:00:00+03:00',
    });
    expect(google.events.get(eventId)).toMatchObject({
      summary: 'Scrim review — bring headsets',
      start: { dateTime: '2026-10-21T17:00:00+03:00' },
    });
  });
});

describe('Google Calendar: occurrences, deletions, re-sync, failures', () => {
  test('one occurrence cancelled or moved in Google applies to the series; EXDATE goes the other way', async () => {
    const o = await org();
    const m = await meeting(o.manager.client, o.teamA.id, []);
    const conn = await connect(o.manager.client, 'manager');
    await drain();
    const eventId = googleEventId(conn.id, m.id);
    const [first, second, third] = m.upcoming;
    google.userChangeInstance(eventId, second!.key, { cancelled: true });
    google.userChangeInstance(eventId, third!.key, {
      start: '2026-11-04T20:00:00',
      end: '2026-11-04T21:00:00',
    });
    await worker.process((await enqueuePull(conn.id))!);
    await drain();
    const after = (await o.manager.client.get<MeetingDto>(`/meetings/${m.id}`)).body;
    expect(after.upcoming.find((x) => x.key === second!.key)!.cancelled).toBe(true);
    expect(after.upcoming.find((x) => x.key === third!.key)).toMatchObject({
      moved: true,
      start: '2026-11-04T20:00:00+03:00',
    });
    // Platform-side cancellation → EXDATE on the series.
    await o.manager.client.post(`/meetings/${m.id}/occurrences/cancel`, {
      originalStart: first!.key,
    });
    await drain();
    expect(google.events.get(eventId)!.recurrence).toEqual([
      'RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=6',
      'EXDATE;TZID=Asia/Riyadh:20261021T180000',
      'EXDATE;TZID=Asia/Riyadh:20261028T180000',
    ]);
  });

  test('declining removes it from your calendar; deleting it there declines it; an organizer deleting it cancels', async () => {
    const o = await org();
    const m = await meeting(o.manager.client, o.teamA.id, [o.player.me.user.id]);
    const pc = await connect(o.player.client, 'player');
    await drain();
    const pid = googleEventId(pc.id, m.id);
    expect(google.events.get(pid)!.status).toBe('tentative'); // not answered yet
    await o.player.client.post(`/meetings/${m.id}/respond`, { response: 'accepted' });
    await drain();
    expect(google.events.get(pid)!.status).toBe('confirmed');
    // Deleting the invitation from your own calendar declines it.
    google.userDelete(pid);
    await worker.process((await enqueuePull(pc.id))!);
    expect((await o.player.client.get<MeetingDto>(`/meetings/${m.id}`)).body.myResponse).toBe(
      'declined',
    );
    const told = (await o.manager.client.get<NotificationDto[]>('/notifications')).body.find(
      (n) => n.type === 'meeting.response' && n.data.response === 'declined',
    );
    expect(told).toBeTruthy();
    // Accepting again puts it back (same event id: no duplicate).
    await o.player.client.post(`/meetings/${m.id}/respond`, { response: 'accepted' });
    await drain();
    expect(google.events.get(pid)!.status).toBe('confirmed');
    expect(google.calendarOf('player')).toHaveLength(1);

    // The organizer deleting it from their calendar cancels the meeting for everyone.
    const mc = await connect(o.manager.client, 'manager');
    await drain();
    google.userDelete(googleEventId(mc.id, m.id));
    await worker.process((await enqueuePull(mc.id))!);
    expect((await o.manager.client.get<MeetingDto>(`/meetings/${m.id}`)).body.status).toBe(
      'cancelled',
    );
    await drain();
    expect(google.events.get(pid)!.status).toBe('cancelled'); // removed from the invitee’s calendar too
  });

  test('a dropped sync token (410) re-lists everything without duplicates; a dedicated calendar imports new events', async () => {
    const o = await org();
    await meeting(o.manager.client, o.teamA.id, []);
    // Imports land in the connection's team: this manager may only create meetings in team A.
    const conn = await connect(
      o.manager.client,
      'manager',
      `direction=two_way&calendarId=team-calendar%40group.calendar.google.com&teamId=${o.teamA.id}`,
    );
    await drain();
    google.invalidateSyncTokens();
    google.userCreate({
      id: 'createdingoogle01',
      owner: 'manager',
      summary: 'Sponsor call',
      start: { dateTime: '2026-10-23T12:00:00', timeZone: 'Asia/Riyadh' },
      end: { dateTime: '2026-10-23T12:30:00', timeZone: 'Asia/Riyadh' },
    });
    await worker.process((await enqueuePull(conn.id))!);
    await drain();
    const log = await events(o.manager.client, conn.id);
    expect(log.some((e) => e.code === 'full_resync')).toBe(true);
    expect(log.some((e) => e.code === 'imported')).toBe(true);
    const links = await t.db
      .select()
      .from(integrationLinks)
      .where(and(eq(integrationLinks.connectionId, conn.id), eq(integrationLinks.state, 'active')));
    expect(links).toHaveLength(2); // the original + the import, nothing doubled
    const imported = links.find((l) => l.remoteId === 'createdingoogle01')!;
    const dto = (await o.manager.client.get<MeetingDto>(`/meetings/${imported.meetingId}`)).body;
    expect(dto).toMatchObject({
      title: 'Sponsor call',
      source: 'google_calendar',
      teamId: o.teamA.id,
      start: '2026-10-23T12:00:00+03:00',
      durationMinutes: 30,
    });
    // Written back with the meeting id, so it's recognized from now on.
    expect(
      google.events.get('createdingoogle01')!.extendedProperties?.private?.platformMeetingId,
    ).toBe(imported.meetingId);
  });

  test('an import interrupted before its link was saved is linked on the next pass, not imported twice', async () => {
    const o = await org();
    const conn = await connect(
      o.manager.client,
      'manager',
      `direction=two_way&calendarId=team-calendar%40group.calendar.google.com&teamId=${o.teamA.id}`,
    );
    await drain();
    google.userCreate({
      id: 'createdingoogle02',
      owner: 'manager',
      summary: 'Kit fitting',
      start: { dateTime: '2026-10-24T16:00:00', timeZone: 'Asia/Riyadh' },
      end: { dateTime: '2026-10-24T17:00:00', timeZone: 'Asia/Riyadh' },
    });
    await worker.process((await enqueuePull(conn.id))!);
    await drain();
    const [first] = await t.db
      .select()
      .from(integrationLinks)
      .where(
        and(
          eq(integrationLinks.connectionId, conn.id),
          eq(integrationLinks.remoteId, 'createdingoogle02'),
        ),
      );
    // As if the worker died right after creating the meeting: no link, nothing written back.
    await t.db.delete(integrationLinks).where(eq(integrationLinks.id, first!.id));
    google.userEdit('createdingoogle02', { extendedProperties: undefined });
    await worker.process((await enqueuePull(conn.id))!);
    await drain();

    const fromGoogle = await t.db
      .select({ id: meetings.id })
      .from(meetings)
      .where(eq(meetings.sourceConnectionId, conn.id));
    expect(fromGoogle).toEqual([{ id: first!.meetingId }]); // the same meeting, not a second one
    const [again] = await t.db
      .select()
      .from(integrationLinks)
      .where(
        and(
          eq(integrationLinks.connectionId, conn.id),
          eq(integrationLinks.remoteId, 'createdingoogle02'),
        ),
      );
    expect(again).toMatchObject({ meetingId: first!.meetingId, state: 'active' });
    expect(
      google.events.get('createdingoogle02')!.extendedProperties?.private?.platformMeetingId,
    ).toBe(first!.meetingId);
  });

  test('an import the owner isn’t allowed to create is skipped and logged, not forced', async () => {
    const o = await org();
    // No team filter: imports would be organization-level, which a team-scoped manager can't create.
    const conn = await connect(
      o.manager.client,
      'manager',
      'direction=two_way&calendarId=team-calendar%40group.calendar.google.com',
    );
    await drain();
    google.userCreate({
      id: 'orglevelmeeting01',
      owner: 'manager',
      summary: 'Board meeting',
      start: { dateTime: '2026-10-23T12:00:00', timeZone: 'Asia/Riyadh' },
      end: { dateTime: '2026-10-23T13:00:00', timeZone: 'Asia/Riyadh' },
    });
    await worker.process((await enqueuePull(conn.id))!);
    const skipped = (await events(o.manager.client, conn.id)).find(
      (e) => e.code === 'import_skipped',
    )!;
    expect(skipped.detail).toMatchObject({ code: 'forbidden', remoteId: 'orglevelmeeting01' });
    expect(
      await t.db.select().from(integrationLinks).where(eq(integrationLinks.connectionId, conn.id)),
    ).toHaveLength(0);
  });

  test('the primary calendar never imports personal events', async () => {
    const o = await org();
    const conn = await connect(o.manager.client, 'manager');
    await drain();
    google.userCreate({
      id: 'dentistappointment',
      owner: 'manager',
      summary: 'Dentist',
      start: { dateTime: '2026-10-23T12:00:00', timeZone: 'Asia/Riyadh' },
      end: { dateTime: '2026-10-23T13:00:00', timeZone: 'Asia/Riyadh' },
    });
    await worker.process((await enqueuePull(conn.id))!);
    const links = await t.db
      .select()
      .from(integrationLinks)
      .where(eq(integrationLinks.connectionId, conn.id));
    expect(links).toHaveLength(0);
  });

  test('rate limits defer without using attempts; transient errors back off; the owner is told once when it gives up', async () => {
    const o = await org();
    const m = await meeting(o.manager.client, o.teamA.id, []);
    const conn = await connect(o.manager.client, 'manager');
    await drain();
    await o.manager.client.patch(`/meetings/${m.id}`, { title: 'Scrim review v2' });
    const eventPath = /\/events\/[0-9a-f]{32}$/;
    google.failNext(429, 1, { 'retry-after': '7' }, eventPath);
    await worker.runDue();
    const [job] = await t.db
      .select()
      .from(integrationJobs)
      .where(
        and(
          eq(integrationJobs.connectionId, conn.id),
          eq(integrationJobs.kind, 'push_meeting'),
          eq(integrationJobs.status, 'pending'),
        ),
      );
    expect(job).toMatchObject({ status: 'pending', attempts: 0 });
    expect(job!.nextAttemptAt.getTime() - nowMs).toBe(7000);
    expect((await events(o.manager.client, conn.id)).some((e) => e.code === 'rate_limited')).toBe(
      true,
    );

    // 500s: retried 30 s, 2 min, 10 min, 30 min, 2 h, 6 h later (±10%), then dead.
    google.failNext(500, 100, undefined, eventPath);
    const waits: number[] = [];
    for (let i = 0; i < 8; i++) {
      nowMs += 7 * 3600_000;
      await worker.runDue();
      const [j] = await t.db.select().from(integrationJobs).where(eq(integrationJobs.id, job!.id));
      if (j!.status === 'dead') break;
      waits.push(Math.round((j!.nextAttemptAt.getTime() - nowMs) / 1000));
    }
    const expected = [30, 120, 600, 1800, 7200, 21600];
    expect(waits).toHaveLength(expected.length);
    waits.forEach((w, i) =>
      expect(Math.abs(w - expected[i]!) <= expected[i]! * 0.1 + 1).toBe(true),
    );
    const [dead] = await t.db.select().from(integrationJobs).where(eq(integrationJobs.id, job!.id));
    expect(dead!.status).toBe('dead');
    const failures = (await o.manager.client.get<NotificationDto[]>('/notifications')).body.filter(
      (n) => n.type === 'integration.failed',
    );
    expect(failures).toHaveLength(1);
    const info = (await o.manager.client.get<IntegrationDto>(`/integrations/${conn.id}`)).body;
    expect(info.lastError).toMatchObject({ code: 'provider_error' });
    expect(info.status).toBe('active'); // transient trouble doesn't disconnect
  });

  test('revoked access marks the connection as needing attention and stops its queue', async () => {
    const o = await org();
    await meeting(o.manager.client, o.teamA.id, []);
    const conn = await connect(o.manager.client, 'manager');
    google.expireAccessTokens();
    google.revokedRefresh.add('manager');
    await worker.runDue();
    const info = (await o.manager.client.get<IntegrationDto>(`/integrations/${conn.id}`)).body;
    expect(info.status).toBe('error');
    expect(info.lastError!.code).toBe('auth_failed');
    expect(
      (await o.manager.client.get<NotificationDto[]>('/notifications')).body.filter(
        (n) => n.type === 'integration.failed',
      ),
    ).toHaveLength(1);
    const pending = await t.db
      .select()
      .from(integrationJobs)
      .where(and(eq(integrationJobs.connectionId, conn.id), eq(integrationJobs.status, 'pending')));
    expect(pending).toHaveLength(0);
  });

  test('push-only never reads Google back: remote edits are overwritten by the next platform change', async () => {
    const o = await org();
    const m = await meeting(o.manager.client, o.teamA.id, []);
    const conn = await connect(o.manager.client, 'manager', 'direction=push_only');
    await drain();
    const eventId = googleEventId(conn.id, m.id);
    google.userEdit(eventId, { summary: 'Edited in Google' });
    expect(
      (
        await t
          .client()
          .request('POST', `/integrations/hooks/google/${conn.id}`, undefined, pushHeaders())
      ).status,
    ).toBe(200);
    const pulls = await t.db
      .select()
      .from(integrationJobs)
      .where(and(eq(integrationJobs.connectionId, conn.id), eq(integrationJobs.kind, 'pull')));
    expect(pulls).toHaveLength(0);
    expect((await o.manager.client.get<MeetingDto>(`/meetings/${m.id}`)).body.title).toBe(
      'Scrim review',
    );
    await o.manager.client.patch(`/meetings/${m.id}`, { notes: 'Bring the scrim VODs.' });
    await drain();
    expect(google.events.get(eventId)!.summary).toBe('Scrim review');
    expect(google.events.get(eventId)!.description).toContain('Bring the scrim VODs.');
    // Switching to two-way starts from the platform's version (old Google edits don't come back).
    const upd = await o.manager.client.patch<IntegrationDto>(`/integrations/${conn.id}`, {
      direction: 'two_way',
    });
    expect(upd.body.direction).toBe('two_way');
  });

  test('settings and management are the owner’s; disconnecting stops the channel and keeps events', async () => {
    const o = await org();
    const conn = await connect(o.manager.client, 'manager');
    await drain();
    expect((await o.player.client.get(`/integrations/${conn.id}`)).status).toBe(404);
    expect((await o.owner.patch(`/integrations/${conn.id}`, { paused: true })).status).toBe(404); // personal: owner only
    expect(
      (await o.manager.client.get('/integrations/google/start?direction=two_way')).status,
    ).toBe(409); // one per member
    expect((await o.manager.client.post(`/integrations/${conn.id}/disconnect`)).status).toBe(204);
    expect(google.stopped).toEqual([
      { id: google.watches[0]!.id, resourceId: google.watches[0]!.resourceId },
    ]);
    const [row] = await t.db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, conn.id));
    expect(row).toMatchObject({ status: 'disconnected', secrets: null, channel: null });
    expect(
      (
        await t
          .client()
          .request('POST', `/integrations/hooks/google/${conn.id}`, undefined, pushHeaders())
      ).status,
    ).toBe(401);
  });

  test('the OAuth state is single-use and bound to the browser that started it', async () => {
    const o = await org();
    const start = await o.manager.client.get('/integrations/google/start?direction=two_way');
    const state = new URL(start.headers.get('location')!).searchParams.get('state');
    // Another browser (no nonce cookie) can't complete it, and the state is then spent.
    const other = o.manager.client.clone();
    other.cookies.delete('esp_gcal_nonce');
    expect(
      (
        await other.get(`/integrations/google/callback?code=good-code:manager&state=${state}`)
      ).headers.get('location'),
    ).toContain('error=oauth_state_invalid');
    expect(
      (
        await o.manager.client.get(
          `/integrations/google/callback?code=good-code:manager&state=${state}`,
        )
      ).headers.get('location'),
    ).toContain('error=oauth_state_invalid');
  });
});

/** Queues a pull now and returns the claimed job (what a push notification would cause). */
async function enqueuePull(connectionId: string) {
  const [c] = await t.db
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId));
  await t.db.insert(integrationJobs).values({
    organizationId: c!.organizationId,
    connectionId,
    kind: 'pull',
    payload: {},
    nextAttemptAt: new Date(nowMs - 1000),
  });
  const claimed = await (
    worker as unknown as {
      jobs: { claim: (n: number, at: number) => Promise<(typeof integrationJobs.$inferSelect)[]> };
    }
  ).jobs.claim(1, nowMs);
  return claimed.find((j) => j.kind === 'pull') ?? claimed[0];
}
