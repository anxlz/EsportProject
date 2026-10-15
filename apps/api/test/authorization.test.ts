/**
 * Phase 1 Definition of Done, end to end:
 * an Owner creates a custom role with specific permissions and team scoping, assigns it to an
 * invited user, and the backend allows/denies access to a real protected resource (teams)
 * according to that role. Plus scope semantics, cache invalidation, owner-only permissions and
 * cross-tenant isolation.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { RoleDto, TeamDto } from '@esports/shared';
import { sql } from 'drizzle-orm';
import {
  type Client,
  inviteAndAccept,
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

async function setupOrg() {
  const { client: owner } = await registerOwner(t);
  const esports = (await owner.post('/departments', { name: 'Esports' })).body;
  const academy = (await owner.post('/departments', { name: 'Academy' })).body;
  const games = (await owner.get('/games')).body as { id: string; name: string }[];
  const val = games.find((g) => g.name === 'VALORANT')!.id;
  const cs2 = games.find((g) => g.name === 'Counter-Strike 2')!.id;
  const teamA = (
    await owner.post('/teams', { name: 'Valorant Team A', departmentId: esports.id, gameId: val })
  ).body as TeamDto;
  const teamB = (
    await owner.post('/teams', { name: 'CS2 Team B', departmentId: esports.id, gameId: cs2 })
  ).body as TeamDto;
  const teamC = (
    await owner.post('/teams', { name: 'Academy Squad', departmentId: academy.id, gameId: val })
  ).body as TeamDto;
  return { owner, esports, academy, teamA, teamB, teamC };
}

describe('Definition of Done: custom role + team scope enforced by the backend', () => {
  test('a team-scoped custom role sees and edits only its team', async () => {
    const { owner, teamA, teamB } = await setupOrg();

    // 1. Owner creates a custom role with specific permissions.
    const created = await owner.post<RoleDto>('/roles', {
      nameEn: 'Team Analyst',
      nameAr: 'محلل الفريق',
      permissions: ['teams.view', 'games.view'],
    });
    expect(created.status).toBe(201);
    expect(created.body.permissions.sort()).toEqual(['games.view', 'teams.view']);

    // 2. …assigns it, scoped to Team A, to an invited user.
    const { client: analyst, me } = await inviteAndAccept(t, owner, 'analyst@example.com', [
      { roleId: created.body.id, scopeType: 'team', scopeId: teamA.id },
    ]);
    expect(me.isOwner).toBe(false);
    expect(me.permissions.find((p) => p.key === 'teams.view')?.scope).toEqual({
      all: false,
      departmentIds: [],
      teamIds: [teamA.id],
    });

    // 3. Backend allows exactly what the role + scope allow.
    const list = await analyst.get<TeamDto[]>('/teams');
    expect(list.status).toBe(200);
    expect(list.body.map((x) => x.name)).toEqual(['Valorant Team A']);

    expect((await analyst.get(`/teams/${teamA.id}`)).status).toBe(200);
    // Out-of-scope record: indistinguishable from a missing one.
    const hidden = await analyst.get(`/teams/${teamB.id}`);
    expect(hidden.status).toBe(404);
    expect(hidden.body.error.code).toBe('not_found');

    // No teams.edit → denied even on the in-scope team.
    const edit = await analyst.patch(`/teams/${teamA.id}`, { region: 'MENA' });
    expect(edit.status).toBe(403);
    // No teams.create / delete / export.
    expect((await analyst.post('/teams', { name: 'Sneaky' })).status).toBe(403);
    expect((await analyst.del(`/teams/${teamA.id}`)).status).toBe(403);
    expect((await analyst.get('/teams/export.csv')).status).toBe(403);
    // No member/role management at all.
    expect((await analyst.get('/members')).status).toBe(403);
    expect((await analyst.post('/roles', { nameEn: 'x', permissions: [] })).status).toBe(403);
  });

  test('permission changes take effect on the very next request (no stale cache)', async () => {
    const { owner, teamA } = await setupOrg();
    const role = (
      await owner.post<RoleDto>('/roles', { nameEn: 'Coach', permissions: ['teams.view'] })
    ).body;
    const { client: coach } = await inviteAndAccept(t, owner, 'coach@example.com', [
      { roleId: role.id, scopeType: 'team', scopeId: teamA.id },
    ]);
    expect((await coach.patch(`/teams/${teamA.id}`, { region: 'EU' })).status).toBe(403);

    await owner.put(`/roles/${role.id}`, {
      nameEn: 'Coach',
      permissions: ['teams.view', 'teams.edit'],
    });
    const ok = await coach.patch<TeamDto>(`/teams/${teamA.id}`, { region: 'EU' });
    expect(ok.status).toBe(200);
    expect(ok.body.region).toBe('EU');

    await owner.put(`/roles/${role.id}`, { nameEn: 'Coach', permissions: [] });
    expect((await coach.get('/teams')).status).toBe(403);
  });

  test('department scope covers every team in the department and nothing else', async () => {
    const { owner, esports, teamA, teamB, teamC } = await setupOrg();
    const managerRole = await roleIdByTemplate(owner, 'esports_manager');
    const { client: mgr } = await inviteAndAccept(t, owner, 'mgr@example.com', [
      { roleId: managerRole, scopeType: 'department', scopeId: esports.id },
    ]);
    const names = (await mgr.get<TeamDto[]>('/teams')).body.map((x) => x.name).sort();
    expect(names).toEqual(['CS2 Team B', 'Valorant Team A']);
    expect((await mgr.patch(`/teams/${teamB.id}`, { region: 'GCC' })).status).toBe(200);
    expect((await mgr.get(`/teams/${teamC.id}`)).status).toBe(404);
    // Esports Manager has no teams.create by default.
    expect((await mgr.post('/teams', { name: 'New', departmentId: esports.id })).status).toBe(403);
    // Export only includes in-scope teams.
    const csv = await mgr.get('/teams/export.csv');
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('Valorant Team A');
    expect(csv.text).not.toContain('Academy Squad');
    expect(teamA.id).toBeTruthy();
  });

  test('scoped create: may only create teams inside a covered department', async () => {
    const { owner, esports, academy } = await setupOrg();
    const role = (
      await owner.post<RoleDto>('/roles', {
        nameEn: 'Dept lead',
        permissions: ['teams.view', 'teams.create'],
      })
    ).body;
    const { client: lead } = await inviteAndAccept(t, owner, 'lead@example.com', [
      { roleId: role.id, scopeType: 'department', scopeId: esports.id },
    ]);
    expect(
      (await lead.post('/teams', { name: 'Esports New', departmentId: esports.id })).status,
    ).toBe(201);
    expect(
      (await lead.post('/teams', { name: 'Academy New', departmentId: academy.id })).status,
    ).toBe(403);
    expect((await lead.post('/teams', { name: 'No Dept' })).status).toBe(403);
  });

  test('moving a team requires edit coverage of the destination department', async () => {
    const { owner, esports, academy, teamA } = await setupOrg();
    const role = (
      await owner.post<RoleDto>('/roles', {
        nameEn: 'Editor',
        permissions: ['teams.view', 'teams.edit'],
      })
    ).body;
    const { client: ed } = await inviteAndAccept(t, owner, 'ed@example.com', [
      { roleId: role.id, scopeType: 'department', scopeId: esports.id },
    ]);
    expect((await ed.patch(`/teams/${teamA.id}`, { departmentId: academy.id })).status).toBe(403);
    expect(
      (await ed.patch(`/teams/${teamA.id}`, { departmentId: esports.id, region: 'x' })).status,
    ).toBe(200);
  });

  test('organization-level permissions in a scoped role apply as-is', async () => {
    const { owner, teamA } = await setupOrg();
    const role = (
      await owner.post<RoleDto>('/roles', {
        nameEn: 'Scoped',
        permissions: ['teams.view', 'games.view'],
      })
    ).body;
    const { client: m } = await inviteAndAccept(t, owner, 'm@example.com', [
      { roleId: role.id, scopeType: 'team', scopeId: teamA.id },
    ]);
    expect((await m.get('/games')).status).toBe(200);
  });

  test('union of several assignments', async () => {
    const { owner, teamA, teamC } = await setupOrg();
    const role = (
      await owner.post<RoleDto>('/roles', { nameEn: 'Viewer', permissions: ['teams.view'] })
    ).body;
    const { client: v } = await inviteAndAccept(t, owner, 'v@example.com', [
      { roleId: role.id, scopeType: 'team', scopeId: teamA.id },
      { roleId: role.id, scopeType: 'team', scopeId: teamC.id },
    ]);
    expect((await v.get<TeamDto[]>('/teams')).body.map((x) => x.name).sort()).toEqual([
      'Academy Squad',
      'Valorant Team A',
    ]);
  });

  test('deleting a team removes the assignments scoped to it', async () => {
    const { owner, teamA } = await setupOrg();
    const role = (
      await owner.post<RoleDto>('/roles', { nameEn: 'Viewer', permissions: ['teams.view'] })
    ).body;
    const { client: v } = await inviteAndAccept(t, owner, 'v2@example.com', [
      { roleId: role.id, scopeType: 'team', scopeId: teamA.id },
    ]);
    expect((await owner.del(`/teams/${teamA.id}`)).status).toBe(204);
    expect((await v.get('/teams')).status).toBe(403);
  });
});

describe('roles are data, not code', () => {
  test('owner-only permissions cannot be granted to custom roles', async () => {
    const { owner } = await setupOrg();
    const res = await owner.post('/roles', {
      nameEn: 'Escalator',
      permissions: ['teams.view', 'roles.manage'],
    });
    expect(res.status).toBe(400);
    const res2 = await owner.post('/roles', {
      nameEn: 'Escalator',
      permissions: ['members.invite'],
    });
    expect(res2.status).toBe(400);
  });

  test('the Owner role is locked; default roles are editable and deletable', async () => {
    const { owner } = await setupOrg();
    const ownerRole = await roleIdByTemplate(owner, 'owner');
    expect(
      (await owner.put(`/roles/${ownerRole}`, { nameEn: 'Boss', permissions: [] })).body.error.code,
    ).toBe('system_role_locked');
    expect((await owner.del(`/roles/${ownerRole}`)).status).toBe(403);

    const ops = await roleIdByTemplate(owner, 'esports_operations');
    expect(
      (await owner.put(`/roles/${ops}`, { nameAr: 'العمليات', permissions: ['teams.view'] }))
        .status,
    ).toBe(200);
    expect((await owner.del(`/roles/${ops}`)).status).toBe(204);
  });

  test('renaming a default role does not change what it can do (no name checks)', async () => {
    const { owner, esports } = await setupOrg();
    const mgrRole = await roleIdByTemplate(owner, 'esports_manager');
    const current = (await owner.get<RoleDto>(`/roles/${mgrRole}`)).body;
    await owner.put(`/roles/${mgrRole}`, {
      nameEn: 'Something Else Entirely',
      nameAr: null,
      permissions: current.permissions,
    });
    const { client: m } = await inviteAndAccept(t, owner, 'renamed@example.com', [
      { roleId: mgrRole, scopeType: 'department', scopeId: esports.id },
    ]);
    expect((await m.get<TeamDto[]>('/teams')).body.length).toBe(2);
  });

  test('a role in use cannot be deleted', async () => {
    const { owner, teamA } = await setupOrg();
    const role = (await owner.post<RoleDto>('/roles', { nameEn: 'R', permissions: ['teams.view'] }))
      .body;
    await inviteAndAccept(t, owner, 'r@example.com', [
      { roleId: role.id, scopeType: 'team', scopeId: teamA.id },
    ]);
    const res = await owner.del(`/roles/${role.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('role_in_use');
  });

  test('the Owner role cannot be handed out through ordinary assignments or invitations', async () => {
    const { owner } = await setupOrg();
    const ownerRole = await roleIdByTemplate(owner, 'owner');
    const res = await owner.post('/invitations', {
      email: 'sneak@example.com',
      assignments: [{ roleId: ownerRole, scopeType: 'organization' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_scope');
  });
});

describe('tenant isolation', () => {
  async function twoOrgs() {
    const a = await setupOrg();
    const { client: ownerB } = await registerOwner(t, {
      slug: 'jeddah-eagles',
      email: 'b@example.com',
      name: 'Jeddah Eagles',
    });
    return { ...a, ownerB };
  }

  test("another organization's Owner cannot reach this organization's records by id", async () => {
    const { teamA, esports, ownerB } = await twoOrgs();
    expect((await ownerB.get<TeamDto[]>('/teams')).body).toEqual([]);
    expect((await ownerB.get(`/teams/${teamA.id}`)).status).toBe(404);
    expect((await ownerB.patch(`/teams/${teamA.id}`, { name: 'pwned' })).status).toBe(404);
    expect((await ownerB.del(`/teams/${teamA.id}`)).status).toBe(404);
    expect((await ownerB.patch(`/departments/${esports.id}`, { name: 'pwned' })).status).toBe(404);
    // Cannot attach a team to another org's department.
    expect((await ownerB.post('/teams', { name: 'X', departmentId: esports.id })).status).toBe(400);
  });

  test("cannot grant another organization's roles or scopes", async () => {
    const { owner, teamA, ownerB } = await twoOrgs();
    const foreignRole = await roleIdByTemplate(owner, 'esports_manager');
    const ownRole = await roleIdByTemplate(ownerB, 'esports_manager');
    const r1 = await ownerB.post('/invitations', {
      email: 'x@example.com',
      assignments: [{ roleId: foreignRole, scopeType: 'organization' }],
    });
    expect(r1.status).toBe(400);
    const r2 = await ownerB.post('/invitations', {
      email: 'x@example.com',
      assignments: [{ roleId: ownRole, scopeType: 'team', scopeId: teamA.id }],
    });
    expect(r2.status).toBe(400);
  });

  test("switching into an organization you don't belong to is refused", async () => {
    const { ownerB, owner } = await twoOrgs();
    const meA = (await owner.get('/auth/me')).body;
    const res = await ownerB.post('/auth/switch-organization', {
      organizationId: meA.activeOrganization.id,
    });
    expect(res.status).toBe(404);
  });

  test('the database itself rejects cross-tenant references', async () => {
    const { teamA } = await twoOrgs();
    const [orgB] = [
      ...(await t.db.execute<{ id: string }>(
        sql`select id from app.organizations where slug = 'jeddah-eagles'`,
      )),
    ];
    let error: unknown = null;
    try {
      // Bypasses all application checks: a team in org B pointing at org A's department.
      await t.db.execute(sql`insert into app.teams (organization_id, name, department_id)
        select ${orgB!.id}, 'bad', department_id from app.teams where id = ${teamA.id}`);
    } catch (e) {
      error = e;
    }
    expect(String((error as { cause?: unknown })?.cause ?? error)).toContain('teams_department_fk');
  });
});

describe('frontend hints are not trusted', () => {
  test('a caller without permission is refused even if it calls the endpoint directly', async () => {
    const { owner } = await setupOrg();
    const opsRole = await roleIdByTemplate(owner, 'esports_operations');
    const { client: ops } = await inviteAndAccept(t, owner, 'ops@example.com', [
      { roleId: opsRole, scopeType: 'organization' },
    ]);
    const direct: [string, () => Promise<{ status: number }>][] = [
      ['create dept', () => ops.post('/departments', { name: 'Hack' })],
      ['invite', () => ops.post('/invitations', { email: 'z@example.com', assignments: [] })],
      ['audit', () => ops.get('/audit-logs')],
      ['org edit', () => ops.patch('/organization', { name: 'Hack' })],
      ['game create', () => ops.post('/games', { name: 'Hack' })],
    ];
    for (const [label, call] of direct) {
      const res = await call();
      expect({ label, status: res.status }).toEqual({ label, status: 403 });
    }
  });
});

export type { Client };
