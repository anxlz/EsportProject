/**
 * Phase 6 — meetings, end to end over HTTP against the real app (Postgres, Redis), with the
 * clock injected so reminder timing is exact.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_ROLE_TEMPLATES,
  type MeetingDto,
  type MeetingOccurrenceDto,
  type NotificationDto,
} from '@esports/shared';
import { and, eq, sql } from 'drizzle-orm';
import { auditLogs } from '../src/db/schema';
import { meetingReminderDeliveries, meetings } from '../src/db/schema-meetings';
import { RemindersService } from '../src/meetings/reminders.service';
import { financeOrg, withRole } from './finance-fixtures';
import { type Client, startApp, type TestApp } from './harness';

let t: TestApp;
let nowMs = Date.parse('2026-10-20T09:00:00Z');
const at = (iso: string) => Date.parse(iso);

beforeAll(async () => {
  t = await startApp({ now: () => nowMs });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  nowMs = Date.parse('2026-10-20T09:00:00Z');
});

async function org() {
  const f = await financeOrg(t);
  const managerA = await withRole(t, f.owner, 'manager.a@example.com', 'esports_manager', {
    type: 'team',
    id: f.teamA.id,
  });
  const managerB = await withRole(t, f.owner, 'manager.b@example.com', 'esports_manager', {
    type: 'team',
    id: f.teamB.id,
  });
  const player1 = await withRole(t, f.owner, 'player1@example.com', 'esports_operations', {
    type: 'team',
    id: f.teamA.id,
  });
  const player2 = await withRole(t, f.owner, 'player2@example.com', 'esports_operations', {
    type: 'team',
    id: f.teamA.id,
  });
  const outsider = await withRole(t, f.owner, 'outsider@example.com', 'esports_operations', {
    type: 'team',
    id: f.teamB.id,
  });
  const head = await withRole(t, f.owner, 'head@example.com', 'head_of_esports', {
    type: 'organization',
  });
  return { ...f, managerA, managerB, player1, player2, outsider, head };
}

const weekly = (overrides: Record<string, unknown> = {}) => ({
  title: 'Weekly scrim review',
  description: 'Review last week’s scrims and plan the next block.',
  start: '2026-10-21T18:00', // a Wednesday
  end: '2026-10-21T19:00',
  timeZone: 'Asia/Riyadh',
  recurrence: { freq: 'weekly', byWeekday: ['WE'], end: { type: 'count', count: 6 } },
  reminderMinutes: [60, 15],
  ...overrides,
});

async function notificationsOf(c: Client, type?: string): Promise<NotificationDto[]> {
  const list = (await c.get('/notifications?limit=100')).body as NotificationDto[];
  return type ? list.filter((n) => n.type === type) : list;
}

describe('Phase 6 Definition of Done (meetings part)', () => {
  test('a manager creates a recurring meeting; invitees confirm or decline; reminders reach everyone who did not decline, once', async () => {
    const o = await org();
    const reminders = t.app.get(RemindersService);

    // 1. Created directly — no approval step.
    const created = await o.managerA.client.post<MeetingDto>('/meetings', {
      ...weekly(),
      teamId: o.teamA.id,
      participantUserIds: [o.player1.me.user.id, o.player2.me.user.id, o.outsider.me.user.id],
    });
    expect(created.status).toBe(201);
    const m = created.body;
    expect(m).toMatchObject({
      kind: 'standard',
      status: 'scheduled',
      teamName: 'Valorant Team A',
      timeZone: 'Asia/Riyadh',
      start: '2026-10-21T18:00:00+03:00',
      end: '2026-10-21T19:00:00+03:00',
      durationMinutes: 60,
      recurrence: {
        freq: 'weekly',
        interval: 1,
        byWeekday: ['WE'],
        end: { type: 'count', count: 6 },
      },
      reminderMinutes: [60, 15],
      version: 1,
      canEdit: true,
    });
    expect(m.upcoming.map((x) => x.start)).toEqual([
      '2026-10-21T18:00:00+03:00',
      '2026-10-28T18:00:00+03:00',
      '2026-11-04T18:00:00+03:00',
      '2026-11-11T18:00:00+03:00',
      '2026-11-18T18:00:00+03:00',
      '2026-11-25T18:00:00+03:00',
    ]);
    expect(m.participants.map((p) => [p.displayName, p.response, p.isOrganizer]).sort()).toEqual(
      [
        ['Invited Member', 'accepted', true],
        ['Invited Member', 'pending', false],
        ['Invited Member', 'pending', false],
        ['Invited Member', 'pending', false],
      ].sort(),
    );

    // 2. Invitations went out through the shared notification service.
    for (const p of [o.player1, o.player2, o.outsider]) {
      const [n] = await notificationsOf(p.client, 'meeting.invited');
      expect(n).toMatchObject({
        data: {
          meetingId: m.id,
          title: 'Weekly scrim review',
          timeZone: 'Asia/Riyadh',
          recurring: true,
          start: '2026-10-21T15:00:00.000Z',
        },
        link: `/dashboard/meetings/${m.id}`,
      });
    }
    expect(await notificationsOf(o.managerA.client, 'meeting.invited')).toHaveLength(0);

    // 3. Confirm / decline (calendar-invite model). The organizer hears about each answer.
    expect(
      (await o.player1.client.post(`/meetings/${m.id}/respond`, { response: 'accepted' })).body
        .myResponse,
    ).toBe('accepted');
    const declined = await o.player2.client.post<MeetingDto>(`/meetings/${m.id}/respond`, {
      response: 'declined',
      note: 'At a LAN that week.',
    });
    expect(declined.status).toBe(200);
    expect(declined.body.myResponse).toBe('declined');
    const answers = await notificationsOf(o.managerA.client, 'meeting.response');
    expect(answers.map((n) => n.data.response).sort()).toEqual(['accepted', 'declined']);
    expect(answers.find((n) => n.data.response === 'declined')!.data.note).toBe(
      'At a LAN that week.',
    );

    // An invitee outside team A still sees and answers it; someone not invited can't see it.
    expect((await o.outsider.client.get(`/meetings/${m.id}`)).status).toBe(200);
    expect((await o.managerB.client.get(`/meetings/${m.id}`)).status).toBe(404);

    // 4. The calendar view lists every occurrence.
    const cal = await o.player1.client.get<MeetingOccurrenceDto[]>(
      '/meetings?from=2026-10-20&to=2026-11-30',
    );
    expect(cal.body.filter((x) => x.meetingId === m.id).map((x) => x.start)).toEqual(
      m.upcoming.map((x) => x.start),
    );
    expect(cal.body[0]).toMatchObject({
      myResponse: 'accepted',
      recurring: true,
      teamName: 'Valorant Team A',
    });

    // 5. Reminders (18:00 Riyadh = 15:00Z): 60 minutes before, then 15 minutes before.
    expect(await reminders.tick(at('2026-10-21T13:59:00Z'))).toBe(0);
    expect(await reminders.tick(at('2026-10-21T14:00:00Z'))).toBe(1);
    expect(await reminders.tick(at('2026-10-21T14:05:00Z'))).toBe(0); // never twice
    expect(await reminders.tick(at('2026-10-21T14:45:00Z'))).toBe(1);
    const [r60, r15] = [...(await notificationsOf(o.player1.client, 'meeting.reminder'))].reverse();
    expect(r60).toMatchObject({
      data: { meetingId: m.id, minutes: 60, start: '2026-10-21T15:00:00.000Z' },
    });
    expect(r15).toMatchObject({ data: { minutes: 15 } });
    expect(await notificationsOf(o.outsider.client, 'meeting.reminder')).toHaveLength(2); // pending still reminded
    expect(await notificationsOf(o.managerA.client, 'meeting.reminder')).toHaveLength(2);
    expect(await notificationsOf(o.player2.client, 'meeting.reminder')).toHaveLength(0); // declined
    const deliveries = await t.db
      .select()
      .from(meetingReminderDeliveries)
      .where(eq(meetingReminderDeliveries.meetingId, m.id));
    expect(deliveries.map((d) => [d.offsetMinutes, d.recipients]).sort()).toEqual([
      [15, 3],
      [60, 3],
    ]);

    // A reminder more than 15 minutes late (e.g. after downtime) is skipped, not sent stale.
    expect(await reminders.tick(at('2026-10-28T14:30:00Z'))).toBe(0);
    expect(await reminders.tick(at('2026-10-28T14:45:00Z'))).toBe(1); // the 15-minute one

    // 6. One occurrence cancelled: it shows as cancelled and gets no reminder.
    nowMs = at('2026-10-29T09:00:00Z');
    const key = m.upcoming[2]!.key; // 4 Nov
    const cancelled = await o.managerA.client.post<MeetingDto>(
      `/meetings/${m.id}/occurrences/cancel`,
      { originalStart: key },
    );
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.overrides).toEqual([
      { originalStart: key, status: 'cancelled', start: null, end: null },
    ]);
    expect(cancelled.body.upcoming.find((x) => x.key === key)!.cancelled).toBe(true);
    expect(
      (await notificationsOf(o.player1.client, 'meeting.occurrence_cancelled'))[0]!.data.start,
    ).toBe(key);
    expect(await reminders.tick(at('2026-11-04T14:00:00Z'))).toBe(0);
    expect(await reminders.tick(at('2026-11-04T14:45:00Z'))).toBe(0);

    // 7. A time change: participants are notified; a stale editor gets version_conflict.
    const moved = await o.managerA.client.patch<MeetingDto>(`/meetings/${m.id}`, {
      start: '2026-10-21T19:00',
      end: '2026-10-21T20:30',
      expectedVersion: cancelled.body.version,
    });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({
      start: '2026-10-21T19:00:00+03:00',
      durationMinutes: 90,
      version: cancelled.body.version + 1,
    });
    // The cancelled occurrence no longer exists in the new series, so its exception is gone.
    expect(moved.body.overrides).toEqual([]);
    const updated = await notificationsOf(o.player1.client, 'meeting.updated');
    expect(updated[0]!.data).toMatchObject({ meetingId: m.id, changed: ['time'] });
    const stale = await o.managerA.client.patch(`/meetings/${m.id}`, {
      title: 'Renamed',
      expectedVersion: 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('version_conflict');

    // 8. Everything is in the audit log, in order.
    const trail = await t.db
      .select({ action: auditLogs.action, metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(and(eq(auditLogs.targetType, 'meeting'), eq(auditLogs.targetId, m.id)))
      .orderBy(auditLogs.id);
    expect(trail.map((x) => x.action)).toEqual([
      'meeting.created',
      'meeting.responded',
      'meeting.responded',
      'meeting.occurrence_cancelled',
      'meeting.updated',
    ]);
    expect(trail[4]!.metadata).toMatchObject({ changed: ['time'] });
  });
});

describe('who may create, see, change and answer meetings', () => {
  test('creation follows meetings.create scope; administrative meetings are the Owner’s', async () => {
    const o = await org();
    const post = (c: Client, body: Record<string, unknown>) =>
      c.post('/meetings', { ...weekly({ recurrence: null }), ...body });
    expect((await post(o.managerA.client, { teamId: o.teamA.id })).status).toBe(201);
    expect((await post(o.managerA.client, { teamId: o.teamB.id })).status).toBe(403); // outside scope
    expect((await post(o.managerA.client, {})).status).toBe(403); // organization-level needs an org-wide grant
    expect((await post(o.player1.client, { teamId: o.teamA.id })).status).toBe(403); // view only
    expect((await post(o.head.client, {})).status).toBe(201);
    expect((await post(o.head.client, { departmentId: o.esports.id })).status).toBe(201);
    expect((await post(o.head.client, { kind: 'administrative' })).status).toBe(403);
    const admin = await post(o.owner, { kind: 'administrative', title: 'All-hands' });
    expect(admin.status).toBe(201);
    expect(admin.body.kind).toBe('administrative');
    const bad = await post(o.owner, { kind: 'administrative', teamId: o.teamA.id });
    expect(bad.status).toBe(400);
    // The invitee picker needs a create permission somewhere.
    expect((await o.player1.client.get('/meetings/invitees')).status).toBe(403);
    expect((await o.managerA.client.get('/meetings/invitees')).body.length).toBeGreaterThanOrEqual(
      7,
    );
  });

  test('visibility: scope or invitation; editing: organizer or meetings.manage in scope; 404 outside', async () => {
    const o = await org();
    const m = (
      await o.head.client.post<MeetingDto>('/meetings', {
        ...weekly(),
        teamId: o.teamA.id,
        participantUserIds: [o.outsider.me.user.id],
      })
    ).body;
    // Team A people see it through their scope; team B people only if invited.
    expect((await o.player1.client.get(`/meetings/${m.id}`)).body.canEdit).toBe(false);
    expect((await o.managerA.client.get(`/meetings/${m.id}`)).body.canEdit).toBe(true); // meetings.manage on team A
    expect((await o.outsider.client.get(`/meetings/${m.id}`)).body.canEdit).toBe(false);
    expect((await o.managerB.client.get(`/meetings/${m.id}`)).status).toBe(404);
    expect((await o.managerB.client.patch(`/meetings/${m.id}`, { title: 'x' })).status).toBe(404);
    expect((await o.outsider.client.patch(`/meetings/${m.id}`, { title: 'x' })).status).toBe(403);
    expect((await o.player1.client.post(`/meetings/${m.id}/cancel`, {})).status).toBe(403);
    expect(
      (await o.managerA.client.patch(`/meetings/${m.id}`, { title: 'Scrim review (A)' })).status,
    ).toBe(200);
    // Moving it to team B needs cover there too.
    expect(
      (await o.managerA.client.patch(`/meetings/${m.id}`, { teamId: o.teamB.id })).status,
    ).toBe(403);
    // Lists only show what each person may see.
    const listB = await o.managerB.client.get<MeetingOccurrenceDto[]>(
      '/meetings?from=2026-10-20&to=2026-11-30',
    );
    expect(listB.body.filter((x) => x.meetingId === m.id)).toHaveLength(0);
    const mine = await o.player1.client.get<MeetingOccurrenceDto[]>(
      '/meetings?from=2026-10-20&to=2026-11-30&mine=true',
    );
    expect(mine.body).toHaveLength(0); // sees it through scope, but isn't invited
  });

  test('only invitees answer; cancelled meetings are final; bad input is refused', async () => {
    const o = await org();
    const m = (
      await o.managerA.client.post<MeetingDto>('/meetings', {
        ...weekly(),
        teamId: o.teamA.id,
        participantUserIds: [o.player1.me.user.id],
      })
    ).body;
    const notInvited = await o.player2.client.post(`/meetings/${m.id}/respond`, {
      response: 'accepted',
    });
    expect(notInvited.status).toBe(403);
    expect(notInvited.body.error.code).toBe('not_a_participant');
    expect(
      (await o.managerB.client.post(`/meetings/${m.id}/respond`, { response: 'accepted' })).status,
    ).toBe(404);

    const cancel = await o.managerA.client.post<MeetingDto>(`/meetings/${m.id}/cancel`, {
      reason: 'Roster change',
    });
    expect(cancel.body).toMatchObject({
      status: 'cancelled',
      cancelReason: 'Roster change',
      canEdit: false,
      canRespond: false,
    });
    expect((await notificationsOf(o.player1.client, 'meeting.cancelled'))[0]!.data).toMatchObject({
      reason: 'Roster change',
    });
    expect(
      (await o.player1.client.post(`/meetings/${m.id}/respond`, { response: 'accepted' })).body
        .error.code,
    ).toBe('meeting_not_editable');
    expect(
      (await o.managerA.client.patch(`/meetings/${m.id}`, { title: 'x' })).body.error.code,
    ).toBe('meeting_not_editable');
    expect((await o.managerA.client.post(`/meetings/${m.id}/cancel`, {})).status).toBe(200); // idempotent

    const wrongDay = await o.managerA.client.post('/meetings', {
      ...weekly({
        recurrence: { freq: 'weekly', byWeekday: ['MO'], end: { type: 'count', count: 3 } },
      }),
      teamId: o.teamA.id,
    });
    expect(wrongDay.status).toBe(400);
    expect(JSON.stringify(wrongDay.body.error.details)).toContain('start_not_on_weekday');
    const stranger = await o.managerA.client.post('/meetings', {
      ...weekly(),
      teamId: o.teamA.id,
      participantUserIds: [crypto.randomUUID()],
    });
    expect(stranger.status).toBe(400);
    const notOccurrence = await o.managerA.client.post(
      `/meetings/${(await o.managerA.client.post<MeetingDto>('/meetings', { ...weekly(), teamId: o.teamA.id })).body.id}/occurrences/cancel`,
      {
        originalStart: '2026-10-22T15:00:00.000Z',
      },
    );
    expect(notOccurrence.status).toBe(400);
  });

  test('a moved occurrence keeps its identity and its reminders follow the new time', async () => {
    const o = await org();
    const reminders = t.app.get(RemindersService);
    const m = (
      await o.managerA.client.post<MeetingDto>('/meetings', {
        ...weekly({ reminderMinutes: [15] }),
        teamId: o.teamA.id,
        participantUserIds: [o.player1.me.user.id],
      })
    ).body;
    const second = m.upcoming[1]!;
    const moved = await o.managerA.client.post<MeetingDto>(`/meetings/${m.id}/occurrences/move`, {
      originalStart: second.key,
      start: '2026-10-29T20:00',
      end: '2026-10-29T21:00',
    });
    expect(moved.status).toBe(200);
    expect(moved.body.upcoming[1]).toMatchObject({
      key: second.key,
      start: '2026-10-29T20:00:00+03:00',
      moved: true,
    });
    expect(await reminders.tick(at('2026-10-28T14:45:00Z'))).toBe(0); // the old slot
    expect(await reminders.tick(at('2026-10-29T16:45:00Z'))).toBe(1); // 15 min before 20:00 Riyadh
  });
});

describe('storage rules', () => {
  test('a meeting’s version never goes backwards; durations and reminders stay within their rules', async () => {
    const o = await org();
    const m = (
      await o.managerA.client.post<MeetingDto>('/meetings', { ...weekly(), teamId: o.teamA.id })
    ).body;
    // Drizzle builders are thenables; Promise.resolve turns them into promises for `rejects`.
    await expect(
      Promise.resolve(t.db.update(meetings).set({ version: 0 }).where(eq(meetings.id, m.id))),
    ).rejects.toThrow();
    await expect(
      Promise.resolve(
        t.db.execute(sql`update app.meetings set duration_minutes = 2 where id = ${m.id}`),
      ),
    ).rejects.toThrow();
    await expect(
      Promise.resolve(
        t.db.execute(sql`update app.meetings set reminder_minutes = '{7}' where id = ${m.id}`),
      ),
    ).rejects.toThrow();
  });

  test('migration 0011 gives existing template roles exactly the Phase 6 permissions of the templates', () => {
    const sqlText = readFileSync(
      join(import.meta.dir, '../drizzle/0011_meetings_hardening.sql'),
      'utf8',
    );
    const granted = new Map<string, string[]>();
    for (const m of sqlText.matchAll(
      /unnest\(ARRAY\[([^\]]+)\]\) AS p\(key\)\s+WHERE r\.template_key = '(\w+)'/g,
    ))
      granted.set(
        m[2]!,
        m[1]!.split(',').map((x) => x.trim().replace(/'/g, '')),
      );
    for (const tpl of DEFAULT_ROLE_TEMPLATES.filter((r) => !r.grantsAll)) {
      const phase6 = tpl.permissions.filter(
        (p) => p.startsWith('meetings.') || p.startsWith('integrations.'),
      );
      expect({ tpl: tpl.templateKey, keys: (granted.get(tpl.templateKey) ?? []).sort() }).toEqual({
        tpl: tpl.templateKey,
        keys: phase6.sort(),
      });
    }
  });
});
