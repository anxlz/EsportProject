import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_ROLE_TEMPLATES, type MeResponse } from '@esports/shared';
import { eq, sql } from 'drizzle-orm';
import { PERMISSIONS_DOC_PATH, renderPermissionsDoc } from '../src/cli/generate-permissions-doc';
import { AccessService } from '../src/authz/access.service';
import { auditLogs, platformAdmins } from '../src/db/schema';
import { inviteAndAccept, registerOwner, roleIdByTemplate, startApp, type TestApp } from './harness';

let t: TestApp;
beforeAll(async () => {
  t = await startApp();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

describe('platform admin tier', () => {
  test('tenant Owners cannot reach platform endpoints', async () => {
    const { client } = await registerOwner(t);
    expect((await client.get('/platform/organizations')).status).toBe(403);
  });

  test('a platform admin sees every tenant, and each look is audited on that tenant', async () => {
    const { client: a, me } = await registerOwner(t);
    await registerOwner(t, { slug: 'jeddah-eagles', email: 'b@example.com', name: 'Jeddah Eagles' });
    // Platform admins are granted out-of-band (CLI); simulate that here.
    await t.db.insert(platformAdmins).values({ userId: me.user.id });

    const orgs = await a.get('/platform/organizations');
    expect(orgs.status).toBe(200);
    expect(orgs.body.map((o: { slug: string }) => o.slug).sort()).toEqual(['jeddah-eagles', 'riyadh-falcons']);
    const other = orgs.body.find((o: { slug: string }) => o.slug === 'jeddah-eagles');
    expect(other.ownerEmails).toEqual(['b@example.com']);

    const members = await a.get(`/platform/organizations/${other.id}/members`);
    expect(members.body[0].email).toBe('b@example.com');
    const [log] = await t.db.select().from(auditLogs).where(eq(auditLogs.action, 'platform.members_viewed'));
    expect(log).toMatchObject({ organizationId: other.id, actorType: 'platform_admin', actorUserId: me.user.id });
  });

  test('platform admin is never a tenant role and grants nothing inside a tenant', async () => {
    const { client: owner } = await registerOwner(t);
    const { client: m, me } = await inviteAndAccept(t, owner, 'staff@example.com', []);
    await t.db.insert(platformAdmins).values({ userId: me.user.id });
    const roles = (await owner.get('/roles')).body as { templateKey: string }[];
    expect(roles.map((r) => r.templateKey).sort()).toEqual(DEFAULT_ROLE_TEMPLATES.map((r) => r.templateKey).sort());
    expect((await m.get('/teams')).status).toBe(403);
    expect((await m.get<MeResponse>('/auth/me')).body.isPlatformAdmin).toBe(true);
  });
});

describe('audit log', () => {
  test('is append-only at the database level', async () => {
    await registerOwner(t);
    const [row] = await t.db.select().from(auditLogs).limit(1);
    let updateError: unknown = null;
    try {
      await t.db.update(auditLogs).set({ action: 'tampered' }).where(eq(auditLogs.id, row!.id));
    } catch (e) {
      updateError = e;
    }
    expect(String((updateError as { cause?: unknown })?.cause ?? updateError)).toContain('append-only');
    let deleteError: unknown = null;
    try {
      await t.db.delete(auditLogs).where(eq(auditLogs.id, row!.id));
    } catch (e) {
      deleteError = e;
    }
    expect(String((deleteError as { cause?: unknown })?.cause ?? deleteError)).toContain('append-only');
  });

  test('records role changes and is readable by holders of audit.view only', async () => {
    const { client: owner } = await registerOwner(t);
    await owner.post('/roles', { nameEn: 'Scout', permissions: ['teams.view'] });
    const logs = await owner.get('/audit-logs?action=role.created');
    expect(logs.body.length).toBe(1);
    expect(logs.body[0]).toMatchObject({ action: 'role.created', actor: { displayName: 'Fahad Owner' } });
    const ops = await roleIdByTemplate(owner, 'esports_operations');
    const { client: o } = await inviteAndAccept(t, owner, 'o@example.com', [{ roleId: ops, scopeType: 'organization' }]);
    expect((await o.get('/audit-logs')).status).toBe(403);
  });
});

describe('notification recipients by permission', () => {
  test('resolves holders of a permission covering a specific team', async () => {
    const { client: owner, me } = await registerOwner(t);
    const dept = (await owner.post('/departments', { name: 'Esports' })).body;
    const teamA = (await owner.post('/teams', { name: 'A', departmentId: dept.id })).body;
    const teamB = (await owner.post('/teams', { name: 'B' })).body;
    const mgr = await roleIdByTemplate(owner, 'esports_manager');
    const { me: deptMgr } = await inviteAndAccept(t, owner, 'd@example.com', [{ roleId: mgr, scopeType: 'department', scopeId: dept.id }]);
    const { me: teamBMgr } = await inviteAndAccept(t, owner, 'b@example.com', [{ roleId: mgr, scopeType: 'team', scopeId: teamB.id }]);

    const access = t.app.get(AccessService);
    const orgId = me.activeOrganization!.id;
    const forA = await access.usersWithPermission(orgId, 'teams.edit', { id: teamA.id, departmentId: dept.id });
    expect(forA.sort()).toEqual([me.user.id, deptMgr.user.id].sort());
    const forB = await access.usersWithPermission(orgId, 'teams.edit', { id: teamB.id, departmentId: null });
    expect(forB.sort()).toEqual([me.user.id, teamBMgr.user.id].sort());
  });
});

describe('structural guarantees', () => {
  test('row level security is enabled on every table in the app schema', async () => {
    const rows = await t.db.execute<{ tablename: string; rowsecurity: boolean }>(
      sql`select tablename, rowsecurity from pg_tables where schemaname = 'app'`,
    );
    const off = [...rows].filter((r) => !r.rowsecurity).map((r) => r.tablename);
    expect(off).toEqual([]);
  });

  test('backend code never branches on a role name', () => {
    const srcDir = join(import.meta.dir, '../src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(srcDir);
    const names = DEFAULT_ROLE_TEMPLATES.flatMap((r) => [r.nameEn, r.nameAr, r.templateKey]);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const name of names) {
        expect({ file, found: text.includes(`'${name}'`) || text.includes(`"${name}"`) }).toEqual({ file, found: false });
      }
    }
  });

  test('docs/PERMISSIONS.md matches the permission catalog', () => {
    expect(readFileSync(PERMISSIONS_DOC_PATH, 'utf8')).toBe(renderPermissionsDoc());
  });

  test('health endpoint reports dependencies', async () => {
    expect((await t.client().get('/health')).body).toEqual({ status: 'ok', database: 'up', redis: 'up' });
  });
});
