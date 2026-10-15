import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MemberDto, MeResponse, NotificationDto } from '@esports/shared';
import { eq, sql } from 'drizzle-orm';
import { auditLogs, invitations } from '../src/db/schema';
import {
  extractUrl,
  inviteAndAccept,
  latestEmail,
  PASSWORD,
  registerOwner,
  roleIdByTemplate,
  startApp,
  type TestApp,
} from './harness';

let t: TestApp;
beforeAll(async () => {
  t = await startApp();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

describe('invitations', () => {
  test('email contains a working single-use link; inviter is notified on join', async () => {
    const { client: owner } = await registerOwner(t);
    const ops = await roleIdByTemplate(owner, 'esports_operations');
    const inv = await owner.post('/invitations', {
      email: 'Player.Ops@Example.com',
      assignments: [{ roleId: ops, scopeType: 'organization' }],
    });
    expect(inv.status).toBe(201);
    expect(inv.body.emailSent).toBe(true);
    expect(inv.body.invitation.email).toBe('player.ops@example.com');

    const mail = await latestEmail(t, 'player.ops@example.com');
    const link = extractUrl(mail!.text, '/invite/');
    expect(link).toBe(inv.body.inviteUrl);
    expect(mail!.text).toContain('Riyadh Falcons');
    const token = link.split('/invite/')[1]!;

    const preview = await t.client().get(`/public/invitations/${token}`);
    expect(preview.body).toMatchObject({ organizationName: 'Riyadh Falcons', accountExists: false, inviterName: 'Fahad Owner' });

    const joiner = t.client();
    const acc = await joiner.post<MeResponse>(`/public/invitations/${token}/accept`, { displayName: 'Ops Person', password: PASSWORD });
    expect(acc.status).toBe(200);
    expect(acc.body.activeOrganization?.name).toBe('Riyadh Falcons');
    expect(acc.body.permissions.map((p) => p.key).sort()).toEqual(['departments.view', 'games.view', 'teams.view']);

    // Single use.
    const again = await t.client().post(`/public/invitations/${token}/accept`, { displayName: 'Again', password: PASSWORD });
    expect(again.status).toBe(404);

    // Inviter notified via the shared notification service.
    const notes = await owner.get<NotificationDto[]>('/notifications');
    expect(notes.body[0]).toMatchObject({ type: 'member.joined', data: { memberName: 'Ops Person' } });
    expect((await owner.get('/notifications/unread-count')).body.count).toBe(1);
    await owner.post(`/notifications/${notes.body[0]!.id}/read`);
    expect((await owner.get('/notifications/unread-count')).body.count).toBe(0);
  });

  test('revoked and expired invitations cannot be used', async () => {
    const { client: owner } = await registerOwner(t);
    const inv = await owner.post('/invitations', { email: 'a@example.com', assignments: [] });
    const token = inv.body.inviteUrl.split('/invite/')[1];
    expect((await owner.del(`/invitations/${inv.body.invitation.id}`)).status).toBe(204);
    expect((await t.client().get(`/public/invitations/${token}`)).status).toBe(404);

    const inv2 = await owner.post('/invitations', { email: 'b@example.com', assignments: [] });
    const token2 = inv2.body.inviteUrl.split('/invite/')[1];
    await t.db.update(invitations).set({ expiresAt: sql`now() - interval '1 second'` }).where(eq(invitations.id, inv2.body.invitation.id));
    expect((await t.client().post(`/public/invitations/${token2}/accept`, { displayName: 'B', password: PASSWORD })).status).toBe(404);
  });

  test('re-inviting the same email replaces the earlier invitation', async () => {
    const { client: owner } = await registerOwner(t);
    const first = await owner.post('/invitations', { email: 'c@example.com', assignments: [] });
    await owner.post('/invitations', { email: 'c@example.com', assignments: [] });
    const firstToken = first.body.inviteUrl.split('/invite/')[1];
    expect((await t.client().get(`/public/invitations/${firstToken}`)).status).toBe(404);
    expect((await owner.get('/invitations')).body.length).toBe(1);
  });

  test('existing accounts must sign in, and only the invited email can accept', async () => {
    const { client: ownerA } = await registerOwner(t);
    const { client: ownerB } = await registerOwner(t, { slug: 'jeddah-eagles', email: 'b@example.com', name: 'Jeddah Eagles' });
    const inv = await ownerA.post('/invitations', { email: 'b@example.com', assignments: [] });
    const token = inv.body.inviteUrl.split('/invite/')[1];

    expect((await t.client().get(`/public/invitations/${token}`)).body.accountExists).toBe(true);
    const asNew = await t.client().post(`/public/invitations/${token}/accept`, { displayName: 'B', password: PASSWORD });
    expect(asNew.body.error.code).toBe('login_required');

    const { client: stranger } = await registerOwner(t, { slug: 'third-org', email: 'c@example.com', name: 'Third Org' });
    expect((await stranger.post(`/invitations/accept/${token}`)).body.error.code).toBe('email_mismatch');

    const ok = await ownerB.post<MeResponse>(`/invitations/accept/${token}`);
    expect(ok.status).toBe(200);
    expect(ok.body.memberships.length).toBe(2);
    expect(ok.body.activeOrganization?.name).toBe('Riyadh Falcons');
    // Switch back to own org.
    const own = ok.body.memberships.find((m) => m.name === 'Jeddah Eagles')!;
    const sw = await ownerB.post<MeResponse>('/auth/switch-organization', { organizationId: own.organizationId });
    expect(sw.body.isOwner).toBe(true);
  });

  test('inviting an existing member is refused', async () => {
    const { client: owner } = await registerOwner(t);
    await inviteAndAccept(t, owner, 'm@example.com', []);
    const res = await owner.post('/invitations', { email: 'm@example.com', assignments: [] });
    expect(res.body.error.code).toBe('already_member');
  });
});

describe('suspension', () => {
  test('revokes live sessions instantly and blocks future logins', async () => {
    const { client: owner } = await registerOwner(t);
    const ops = await roleIdByTemplate(owner, 'esports_operations');
    const { client: member, me } = await inviteAndAccept(t, owner, 'm@example.com', [{ roleId: ops, scopeType: 'organization' }]);
    const secondDevice = t.client();
    await secondDevice.post('/auth/login', { email: 'm@example.com', password: PASSWORD });
    expect((await member.get('/teams')).status).toBe(200);

    const res = await owner.post<MemberDto>(`/members/${me.user.id}/suspend`, { reason: 'Contract ended' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('suspended');

    // Both devices are out on their very next request.
    expect((await member.get('/teams')).status).toBe(401);
    expect((await secondDevice.get('/auth/me')).status).toBe(401);
    const login = await t.client().post('/auth/login', { email: 'm@example.com', password: PASSWORD });
    expect(login.body.error.code).toBe('account_suspended');

    const actions = (await t.db.select().from(auditLogs)).map((a) => a.action);
    expect(actions).toContain('member.suspended');
    expect(actions).toContain('member.sessions_revoked');
    expect(actions).toContain('auth.login_blocked_suspended');

    // Reactivation restores access.
    await owner.post(`/members/${me.user.id}/reactivate`);
    expect((await t.client().post('/auth/login', { email: 'm@example.com', password: PASSWORD })).status).toBe(200);
  });

  test('suspension is per organization: other memberships keep working', async () => {
    const { client: ownerA } = await registerOwner(t);
    const { client: ownerB, me: meB } = await registerOwner(t, { slug: 'jeddah-eagles', email: 'b@example.com', name: 'Jeddah Eagles' });
    const inv = await ownerA.post('/invitations', { email: 'b@example.com', assignments: [] });
    await ownerB.post(`/invitations/accept/${inv.body.inviteUrl.split('/invite/')[1]}`);
    await ownerA.post(`/members/${meB.user.id}/suspend`, {});
    const login = await t.client().post<MeResponse>('/auth/login', { email: 'b@example.com', password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.activeOrganization?.name).toBe('Jeddah Eagles');
  });

  test('cannot suspend yourself, or the last active Owner', async () => {
    const { client: owner, me } = await registerOwner(t);
    expect((await owner.post(`/members/${me.user.id}/suspend`, {})).body.error.code).toBe('cannot_target_self');

    const { client: second, me: secondMe } = await inviteAndAccept(t, owner, 'o2@example.com', []);
    await owner.post(`/members/${secondMe.user.id}/ownership`);
    // Two owners: suspending one is fine…
    expect((await second.post(`/members/${me.user.id}/suspend`, {})).status).toBe(200);
    // …and the remaining sole owner cannot give up ownership.
    const res = await second.del(`/members/${secondMe.user.id}/ownership`);
    expect(res.body.error.code).toBe('last_owner');
  });

  test('non-owners cannot suspend anyone (members.manage is owner-only)', async () => {
    const { client: owner, me } = await registerOwner(t);
    const head = await roleIdByTemplate(owner, 'head_of_esports');
    const { client: h } = await inviteAndAccept(t, owner, 'head@example.com', [{ roleId: head, scopeType: 'organization' }]);
    expect((await h.post(`/members/${me.user.id}/suspend`, {})).status).toBe(403);
  });
});

describe('ownership', () => {
  test('multiple Owners; ownership can be granted and revoked, never below one', async () => {
    const { client: owner, me } = await registerOwner(t);
    const { client: m, me: mMe } = await inviteAndAccept(t, owner, 'm@example.com', []);
    expect((await m.get('/members')).status).toBe(403);

    const granted = await owner.post<MemberDto>(`/members/${mMe.user.id}/ownership`);
    expect(granted.body.isOwner).toBe(true);
    expect((await m.get('/members')).status).toBe(200);
    const notes = await m.get<NotificationDto[]>('/notifications');
    expect(notes.body.map((n) => n.type)).toContain('member.ownership_granted');

    // The original owner steps down; the new one remains.
    expect((await owner.del(`/members/${me.user.id}/ownership`)).status).toBe(200);
    expect((await owner.get('/members')).status).toBe(403);
    expect((await m.del(`/members/${mMe.user.id}/ownership`)).body.error.code).toBe('last_owner');
  });

  test('an invitation can make someone an Owner on acceptance', async () => {
    const { client: owner } = await registerOwner(t);
    const inv = await owner.post('/invitations', { email: 'co@example.com', assignments: [], makeOwner: true });
    const acc = await t.client().post<MeResponse>(`/public/invitations/${inv.body.inviteUrl.split('/invite/')[1]}/accept`, {
      displayName: 'Co Owner',
      password: PASSWORD,
    });
    expect(acc.body.isOwner).toBe(true);
  });
});

describe('role assignment management', () => {
  test('replaces assignments, notifies the member, audits before/after', async () => {
    const { client: owner } = await registerOwner(t);
    const dept = (await owner.post('/departments', { name: 'Esports' })).body;
    const mgr = await roleIdByTemplate(owner, 'esports_manager');
    const { client: m, me } = await inviteAndAccept(t, owner, 'm@example.com', []);
    expect((await m.get('/teams')).status).toBe(403);

    const res = await owner.put<MemberDto>(`/members/${me.user.id}/assignments`, {
      assignments: [{ roleId: mgr, scopeType: 'department', scopeId: dept.id }],
    });
    expect(res.status).toBe(200);
    expect(res.body.assignments[0]).toMatchObject({ scopeType: 'department', scopeName: 'Esports', roleNameEn: 'Esports Manager' });
    expect((await m.get('/teams')).status).toBe(200);
    expect((await m.get<NotificationDto[]>('/notifications')).body[0]!.type).toBe('member.roles_changed');
    const [log] = await t.db.select().from(auditLogs).where(eq(auditLogs.action, 'member.assignments_changed'));
    expect((log!.metadata as { after: unknown[] }).after.length).toBe(1);

    // Assigning the Owner role this way is refused.
    const ownerRole = await roleIdByTemplate(owner, 'owner');
    const bad = await owner.put(`/members/${me.user.id}/assignments`, { assignments: [{ roleId: ownerRole, scopeType: 'organization' }] });
    expect(bad.status).toBe(400);
  });

  test('scope id must match scope type', async () => {
    const { client: owner } = await registerOwner(t);
    const mgr = await roleIdByTemplate(owner, 'esports_manager');
    const { me } = await inviteAndAccept(t, owner, 'm@example.com', []);
    const res = await owner.put(`/members/${me.user.id}/assignments`, {
      assignments: [{ roleId: mgr, scopeType: 'team' }],
    });
    expect(res.status).toBe(400);
  });
});
