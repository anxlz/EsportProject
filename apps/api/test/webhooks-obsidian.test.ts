/**
 * Phase 6 — generic webhooks (incoming and outgoing, Standard Webhooks signatures) and the
 * Obsidian vault sync (token-authenticated feed and push, plus the real companion script
 * writing into a temporary vault folder).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  IntegrationDto,
  IntegrationEventDto,
  IntegrationSecretDto,
  MeetingDto,
  NotificationDto,
  ObsidianFeedDto,
  ObsidianPushResultDto,
} from '@esports/shared';
import { and, eq } from 'drizzle-orm';
import { createHmac } from 'node:crypto';
import { auditLogs } from '../src/db/schema';
import { integrationJobs, meetings } from '../src/db/schema-meetings';
import { IntegrationsWorker } from '../src/integrations/worker.service';
// The companion script is plain JavaScript meant to run on a member's computer.
import { safePath, syncOnce } from '../../../scripts/obsidian-vault-sync.mjs';
import { financeOrg, withRole } from './finance-fixtures';
import { type Client, roleIdByTemplate, startApp, type TestApp } from './harness';

let t: TestApp;
let worker: IntegrationsWorker;
let nowMs = Date.now();

beforeAll(async () => {
  t = await startApp({ now: () => nowMs, env: { PUBLIC_API_URL: 'https://club.example/api' } });
  worker = t.app.get(IntegrationsWorker);
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  nowMs = Date.now();
});

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

/** Signs like a Standard Webhooks sender. */
function sign(secret: string, id: string, ts: number, body: string) {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')}`;
}

function send(
  connId: string,
  payload: unknown,
  opts: {
    secret?: string;
    id?: string;
    ts?: number;
    tamper?: boolean;
    headers?: Record<string, string>;
  } = {},
) {
  const body = JSON.stringify(payload);
  const id = opts.id ?? `msg_${crypto.randomUUID()}`;
  const ts = opts.ts ?? Math.floor(nowMs / 1000);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(opts.headers ?? {}),
  };
  if (opts.secret) {
    headers['webhook-id'] = id;
    headers['webhook-timestamp'] = String(ts);
    headers['webhook-signature'] = sign(
      opts.secret,
      id,
      ts,
      opts.tamper ? body.replace('Scrim', 'Scam') : body,
    );
  }
  return t
    .client()
    .request('POST', `/integrations/hooks/in/${connId}`, new TextEncoder().encode(body), headers);
}

const createPayload = (extra: Record<string, unknown> = {}) => ({
  type: 'meeting.create',
  data: {
    externalId: 'cal-123',
    title: 'Scrim with Team Liquid',
    start: '2026-11-05T20:00',
    end: '2026-11-05T22:00',
    timeZone: 'Asia/Riyadh',
    participantEmails: ['player@example.com', 'nobody@example.com'],
    ...extra,
  },
});

describe('incoming webhooks', () => {
  test('Phase 6 Definition of Done: unauthenticated requests are rejected; signed ones act as the endpoint owner, once', async () => {
    const o = await org();
    const made = await o.owner.post<IntegrationSecretDto>('/integrations/webhooks/incoming', {
      name: 'Scheduling tool',
      actions: ['meeting.create', 'meeting.update', 'meeting.cancel'],
      teamId: o.teamA.id,
    });
    expect(made.status).toBe(201);
    const { integration, secret } = made.body;
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    expect(integration.settings.endpointUrl).toBe(
      `https://club.example/api/integrations/hooks/in/${integration.id}`,
    );

    // Every unauthenticated variant gets the same 401, and nothing happens.
    const refused = [
      await send(integration.id, createPayload()), // no signature headers at all
      await send(integration.id, createPayload(), {
        secret: 'whsec_' + Buffer.from('x'.repeat(32)).toString('base64'),
      }), // wrong secret
      await send(integration.id, createPayload(), { secret, ts: Math.floor(nowMs / 1000) - 600 }), // stale (10 min)
      await send(integration.id, createPayload(), { secret, ts: Math.floor(nowMs / 1000) + 600 }), // from the future
      await send(integration.id, createPayload(), { secret, tamper: true }), // body changed after signing
      await send(crypto.randomUUID(), createPayload(), { secret }), // unknown endpoint
      await send('not-a-uuid', createPayload(), { secret }),
      await send(integration.id, createPayload(), {
        headers: {
          'webhook-id': 'x',
          'webhook-timestamp': String(Math.floor(nowMs / 1000)),
          'webhook-signature': 'v1,AAAA',
        },
      }),
    ];
    for (const r of refused) {
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe('invalid_signature');
    }
    expect(await t.db.select().from(meetings)).toHaveLength(0);
    const log = (await o.owner.get<IntegrationEventDto[]>(`/integrations/${integration.id}/events`))
      .body;
    expect(log.filter((e) => e.code === 'signature_rejected')).toHaveLength(1); // throttled: one per minute

    // Signed: the meeting is created as the endpoint's owner, participants matched by email.
    const id = 'msg_first';
    const ok = await send(integration.id, createPayload(), { secret, id });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      result: 'created',
      unmatchedParticipants: ['nobody@example.com'],
    });
    const m = (await o.owner.get<MeetingDto>(`/meetings/${ok.body.meetingId}`)).body;
    expect(m).toMatchObject({
      title: 'Scrim with Team Liquid',
      source: 'webhook',
      teamId: o.teamA.id,
      durationMinutes: 120,
    });
    expect(m.organizer!.id).toBe(o.ownerId);
    expect(m.participants.map((p) => p.userId).sort()).toEqual(
      [o.ownerId, o.player.me.user.id].sort(),
    );
    expect(
      (await o.player.client.get<NotificationDto[]>('/notifications')).body.some(
        (n) => n.type === 'meeting.invited',
      ),
    ).toBe(true);
    const [audit] = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'meeting.created'), eq(auditLogs.targetId, m.id)));
    expect(audit!.metadata).toMatchObject({ via: 'webhook', connectionId: integration.id });

    // Replays (same message id) are not processed again; a retried create is idempotent.
    expect((await send(integration.id, createPayload(), { secret, id })).body).toEqual({
      duplicate: true,
    });
    expect((await send(integration.id, createPayload(), { secret })).body).toMatchObject({
      result: 'exists',
      meetingId: m.id,
    });
    expect(await t.db.select().from(meetings)).toHaveLength(1);

    // Update and cancel by the sender's own id.
    const upd = await send(
      integration.id,
      {
        type: 'meeting.update',
        data: { externalId: 'cal-123', title: 'Scrim with Team Liquid (BO5)' },
      },
      { secret },
    );
    expect(upd.body).toMatchObject({ result: 'updated', version: 2 });
    const cancel = await send(
      integration.id,
      { type: 'meeting.cancel', data: { externalId: 'cal-123', reason: 'They withdrew' } },
      { secret },
    );
    expect(cancel.body).toMatchObject({ result: 'cancelled' });
    expect((await o.owner.get<MeetingDto>(`/meetings/${m.id}`)).body).toMatchObject({
      status: 'cancelled',
      cancelReason: 'They withdrew',
    });
    // Invalid payloads are refused after authentication.
    expect(
      (await send(integration.id, { type: 'meeting.delete', data: {} }, { secret })).status,
    ).toBe(400);
  });

  test('an endpoint only does what it allows, with its owner’s current permissions', async () => {
    const o = await org();
    // A delegated admin (integrations.manage + meetings on team A) sets up the endpoint…
    const role = await o.owner.post('/roles', {
      nameEn: 'Integrations admin',
      permissions: ['integrations.manage', 'meetings.view', 'meetings.create'],
    });
    const admin = await withRole(t, o.owner, 'admin@example.com', 'esports_operations', {
      type: 'team',
      id: o.teamA.id,
    });
    const assignments = [
      { roleId: role.body.id, scopeType: 'team', scopeId: o.teamA.id },
      {
        roleId: await roleIdByTemplate(o.owner, 'esports_operations'),
        scopeType: 'team',
        scopeId: o.teamA.id,
      },
    ];
    expect(
      (await o.owner.put(`/members/${admin.me.user.id}/assignments`, { assignments })).status,
    ).toBe(200);
    const made = (
      await admin.client.post<IntegrationSecretDto>('/integrations/webhooks/incoming', {
        name: 'Create only',
        actions: ['meeting.create'],
        teamId: o.teamA.id,
      })
    ).body;
    expect(
      (
        await send(
          made.integration.id,
          { type: 'meeting.cancel', data: { externalId: 'x' } },
          { secret: made.secret },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await send(made.integration.id, createPayload({ teamId: o.teamB.id }), {
          secret: made.secret,
        })
      ).status,
    ).toBe(403); // outside their scope
    expect((await send(made.integration.id, createPayload(), { secret: made.secret })).status).toBe(
      200,
    );
    // …and loses that access: the endpoint can no longer create anything.
    await o.owner.put(`/members/${admin.me.user.id}/assignments`, {
      assignments: assignments.slice(1),
    });
    expect(
      (
        await send(made.integration.id, createPayload({ externalId: 'cal-999' }), {
          secret: made.secret,
        })
      ).status,
    ).toBe(403);
    // Rotating the secret retires the old one.
    const rotated = (
      await o.owner.post<IntegrationSecretDto>(`/integrations/${made.integration.id}/rotate-secret`)
    ).body;
    expect(rotated.secret).not.toBe(made.secret);
    expect(
      (
        await send(made.integration.id, createPayload({ externalId: 'cal-1000' }), {
          secret: made.secret,
        })
      ).status,
    ).toBe(401);
  });
});

describe('outgoing webhooks', () => {
  test('meeting events are delivered signed; failures retry on the Standard Webhooks schedule; 410 disables the endpoint', async () => {
    const o = await org();
    const received: { headers: Record<string, string>; body: string }[] = [];
    let answer = 200;
    const receiver = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => {
        received.push({
          headers: Object.fromEntries(req.headers.entries()),
          body: await req.text(),
        });
        return new Response(null, { status: answer });
      },
    });
    try {
      const made = (
        await o.owner.post<IntegrationSecretDto>('/integrations/webhooks/outgoing', {
          name: 'Ops dashboard',
          url: `http://127.0.0.1:${receiver.port}/hooks`,
          events: ['meeting.created', 'meeting.cancelled'],
        })
      ).body;
      const m = (
        await o.manager.client.post<MeetingDto>('/meetings', {
          title: 'Scrim review',
          notes: 'Internal notes stay inside.',
          start: '2026-11-05T20:00',
          end: '2026-11-05T21:00',
          timeZone: 'Asia/Riyadh',
          teamId: o.teamA.id,
          participantUserIds: [o.player.me.user.id],
        })
      ).body;
      await o.manager.client.patch(`/meetings/${m.id}`, { title: 'Not subscribed: no delivery' });
      await worker.runDue();
      expect(received).toHaveLength(1);
      const [r] = received;
      // Verify exactly as a receiver would (Standard Webhooks).
      const ts = Number(r!.headers['webhook-timestamp']);
      expect(Math.abs(ts - nowMs / 1000)).toBeLessThan(5);
      expect(r!.headers['webhook-signature']).toBe(
        sign(made.secret, r!.headers['webhook-id']!, ts, r!.body),
      );
      const payload = JSON.parse(r!.body);
      expect(payload).toMatchObject({
        type: 'meeting.created',
        data: {
          meeting: {
            id: m.id,
            title: 'Scrim review',
            team: { name: 'Valorant Team A' },
            start: '2026-11-05T20:00',
            timeZone: 'Asia/Riyadh',
          },
          change: { type: 'created' },
        },
      });
      expect(r!.body).not.toContain('Internal notes'); // no notes
      expect(r!.body).not.toContain('@example.com'); // no email addresses

      // A failing receiver: retried 5 s later (±10%), the job is kept, not lost.
      answer = 500;
      await o.manager.client.post(`/meetings/${m.id}/cancel`, {});
      await worker.runDue();
      const [job] = await t.db
        .select()
        .from(integrationJobs)
        .where(
          and(
            eq(integrationJobs.connectionId, made.integration.id),
            eq(integrationJobs.status, 'pending'),
          ),
        );
      const wait = job!.nextAttemptAt.getTime() - nowMs;
      expect(wait).toBeGreaterThanOrEqual(4500);
      expect(wait).toBeLessThanOrEqual(5500);
      // Same message id on the retry (receivers dedupe on it).
      answer = 410;
      nowMs += 10_000;
      await worker.runDue();
      expect(received.at(-1)!.headers['webhook-id']).toBe(received.at(-2)!.headers['webhook-id']);
      const info = (await o.owner.get<IntegrationDto>(`/integrations/${made.integration.id}`)).body;
      expect(info.status).toBe('error');
      expect(
        (
          await o.owner.get<IntegrationEventDto[]>(`/integrations/${made.integration.id}/events`)
        ).body.some((e) => e.code === 'endpoint_disabled'),
      ).toBe(true);
      expect(
        (await o.owner.get<NotificationDto[]>('/notifications')).body.some(
          (n) => n.type === 'integration.failed',
        ),
      ).toBe(true);
    } finally {
      receiver.stop(true);
    }
  });
});

describe('Obsidian vault sync', () => {
  async function vaultToken(c: Client, direction = 'two_way') {
    const r = await c.post<IntegrationSecretDto>('/integrations/obsidian', { direction });
    expect(r.status).toBe(201);
    expect(r.body.secret).toMatch(/^obs_/);
    return r.body;
  }
  const feed = (token: string, since?: string) =>
    t
      .client()
      .request<ObsidianFeedDto>(
        'GET',
        `/integrations/obsidian/feed${since ? `?since=${since}` : ''}`,
        undefined,
        { authorization: `Bearer ${token}` },
      );
  const push = (token: string, notes: unknown[]) =>
    t
      .client()
      .request<ObsidianPushResultDto>(
        'POST',
        '/integrations/obsidian/push',
        { notes },
        { authorization: `Bearer ${token}` },
      );

  test('the feed holds the member’s meetings as notes; edits come back with the same rules as other integrations', async () => {
    const o = await org();
    const m = (
      await o.manager.client.post<MeetingDto>('/meetings', {
        title: 'Scrim review',
        description: 'Go through Sunday’s scrims.',
        start: '2026-11-04T20:00',
        end: '2026-11-04T21:00',
        timeZone: 'Asia/Riyadh',
        recurrence: { freq: 'weekly', byWeekday: ['WE'], end: { type: 'count', count: 4 } },
        teamId: o.teamA.id,
        participantUserIds: [o.player.me.user.id],
      })
    ).body;
    await o.owner.post('/meetings', {
      title: 'Not for the player',
      start: '2026-11-04T10:00',
      end: '2026-11-04T11:00',
      timeZone: 'Asia/Riyadh',
    });
    const mine = await vaultToken(o.manager.client);
    const theirs = await vaultToken(o.player.client);

    expect((await t.client().get('/integrations/obsidian/feed')).status).toBe(401);
    expect((await feed('obs_wrong')).status).toBe(401);
    const f1 = (await feed(theirs.secret)).body;
    expect(f1.notes).toHaveLength(1);
    const note = f1.notes[0]!;
    expect(note.path).toBe(`Meetings/2026-11-04 Scrim review (${m.id.slice(0, 6)}).md`);
    expect(note.content).toContain(`platform_meeting_id: "${m.id}"`);
    expect(note.content).toContain('repeats: "FREQ=WEEKLY;BYDAY=WE;COUNT=4"');
    expect(note.content).toContain('Go through Sunday’s scrims.');
    // Unchanged since the cursor → no content; changed → content again.
    expect((await feed(theirs.secret, f1.cursor)).body.notes[0]!.content).toBeNull();
    await o.manager.client.patch(`/meetings/${m.id}`, { notes: 'Bring VODs.' });
    const f2 = (await feed(theirs.secret, f1.cursor)).body;
    expect(f2.notes[0]!.content).toContain('Bring VODs.');

    // The player may not change the meeting: their edit is rejected (the script keeps a copy).
    const edited = f2.notes[0]!.content!.replace('Bring VODs.', 'Bring VODs and snacks.');
    const rejected = (
      await push(theirs.secret, [
        { meetingId: m.id, baseVersion: f2.notes[0]!.version, content: edited },
      ])
    ).body.results[0]!;
    expect(rejected).toMatchObject({ outcome: 'rejected', message: 'forbidden' });
    expect(rejected.content).toContain('Bring VODs.');

    // The organizer may: applied, as them, via Obsidian.
    const mf = (await feed(mine.secret)).body.notes[0]!;
    const applied = (
      await push(mine.secret, [
        {
          meetingId: m.id,
          baseVersion: mf.version,
          content: mf
            .content!.replace('Bring VODs.', 'Bring VODs and headsets.')
            .replace('title: "Scrim review"', 'title: "Scrim review (week 45)"'),
        },
      ])
    ).body.results[0]!;
    expect(applied.outcome).toBe('applied');
    expect((await o.manager.client.get<MeetingDto>(`/meetings/${m.id}`)).body).toMatchObject({
      notes: 'Bring VODs and headsets.',
      title: 'Scrim review (week 45)',
    });
    const [audit] = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'meeting.updated'), eq(auditLogs.targetId, m.id)))
      .orderBy(auditLogs.id);
    expect(audit).toBeTruthy();

    // A note written from an older version, changed on both sides → the platform's kept.
    await o.manager.client.patch(`/meetings/${m.id}`, { notes: 'Platform notes.' });
    const conflict = (
      await push(mine.secret, [
        {
          meetingId: m.id,
          baseVersion: mf.version,
          content: mf.content!.replace('Bring VODs.', 'Vault notes.'),
        },
      ])
    ).body.results[0]!;
    expect(conflict.outcome).toBe('conflict');
    expect((await o.manager.client.get<MeetingDto>(`/meetings/${m.id}`)).body.notes).toBe(
      'Platform notes.',
    );

    // A meeting the token's owner isn't part of is "not found".
    const other = (await t.db.select().from(meetings)).find(
      (x) => x.title === 'Not for the player',
    )!;
    expect(
      (await push(theirs.secret, [{ meetingId: other.id, baseVersion: 1, content: 'x' }])).body
        .results[0]!.outcome,
    ).toBe('not_found');
  });

  test('the companion script writes the vault, sends edits back, keeps conflict copies, and never writes outside Meetings/', async () => {
    const o = await org();
    const m = (
      await o.manager.client.post<MeetingDto>('/meetings', {
        title: 'Bootcamp planning',
        start: '2026-11-10T18:00',
        end: '2026-11-10T19:00',
        timeZone: 'Asia/Riyadh',
        teamId: o.teamA.id,
      })
    ).body;
    const { secret } = await vaultToken(o.manager.client);
    const vault = await mkdtemp(join(tmpdir(), 'vault-'));
    const cfg = { vault, url: t.baseUrl, token: secret };
    const quiet = () => undefined;

    expect(await syncOnce(cfg, quiet)).toMatchObject({ written: 1, conflicts: 0 });
    const files = await readdir(join(vault, 'Meetings'));
    expect(files).toEqual([`2026-11-10 Bootcamp planning (${m.id.slice(0, 6)}).md`]);
    const path = join(vault, 'Meetings', files[0]!);

    // Edit the Notes section in the vault → applied on the platform.
    const text = await readFile(path, 'utf8');
    await writeFile(
      path,
      text.replace(
        '<!-- platform:notes:start -->\n',
        '<!-- platform:notes:start -->\nBook the hotel by Friday.',
      ),
    );
    expect(await syncOnce(cfg, quiet)).toMatchObject({ applied: 1, conflicts: 0 });
    expect((await o.manager.client.get<MeetingDto>(`/meetings/${m.id}`)).body.notes).toBe(
      'Book the hotel by Friday.',
    );

    // Changed on both sides → the vault keeps the member's text as a conflict copy.
    await o.manager.client.patch(`/meetings/${m.id}`, { notes: 'Hotel booked.' });
    const now = await readFile(path, 'utf8');
    await writeFile(path, now.replace('Book the hotel by Friday.', 'Ask for a late checkout.'));
    expect(await syncOnce(cfg, quiet)).toMatchObject({ conflicts: 1 });
    const after = await readdir(join(vault, 'Meetings'));
    const copy = after.find((f) => f.includes('.conflict-'))!;
    expect(await readFile(join(vault, 'Meetings', copy), 'utf8')).toContain(
      'Ask for a late checkout.',
    );
    expect(await readFile(path, 'utf8')).toContain('Hotel booked.');

    // Paths from the server are checked: nothing outside Meetings/, nothing but .md.
    expect(safePath(vault, 'Meetings/a.md')).toBe(join(vault, 'Meetings', 'a.md'));
    for (const bad of [
      '../evil.md',
      'Meetings/../../evil.md',
      '/etc/passwd',
      'Meetings/a.sh',
      '.obsidian/plugins/x.md',
      'Other/a.md',
    ])
      expect(safePath(vault, bad)).toBeNull();
  });

  test('push-only vaults never change the platform; revoking the token stops the script', async () => {
    const o = await org();
    const m = (
      await o.manager.client.post<MeetingDto>('/meetings', {
        title: 'Review',
        start: '2026-11-10T18:00',
        end: '2026-11-10T19:00',
        timeZone: 'Asia/Riyadh',
        teamId: o.teamA.id,
      })
    ).body;
    const tok = await vaultToken(o.manager.client, 'push_only');
    const n = (await feed(tok.secret)).body.notes[0]!;
    const r = (
      await push(tok.secret, [
        {
          meetingId: m.id,
          baseVersion: n.version,
          content: n.content!.replace('title: "Review"', 'title: "Changed"'),
        },
      ])
    ).body.results[0]!;
    expect(r.outcome).toBe('ignored');
    expect((await o.manager.client.get<MeetingDto>(`/meetings/${m.id}`)).body.title).toBe('Review');
    expect(
      (await o.manager.client.post(`/integrations/${tok.integration.id}/disconnect`)).status,
    ).toBe(204);
    expect((await feed(tok.secret)).status).toBe(401);
  });
});
