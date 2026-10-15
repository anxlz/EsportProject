import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MeResponse } from '@esports/shared';
import { and, eq, sql } from 'drizzle-orm';
import { auditLogs, passwordResetTokens } from '../src/db/schema';
import { extractUrl, latestEmail, PASSWORD, registerOwner, startApp, type TestApp } from './harness';

let t: TestApp;
beforeAll(async () => {
  t = await startApp();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

describe('organization signup', () => {
  test('creates the org, makes the caller its Owner and starts a session', async () => {
    const { client, me } = await registerOwner(t);
    expect(me.isOwner).toBe(true);
    expect(me.activeOrganization?.slug).toBe('riyadh-falcons');
    expect(client.cookies.has('esp_sid')).toBe(true);
    expect((await client.get<MeResponse>('/auth/me')).body.user.email).toBe('owner@example.com');
  });

  test('rejects duplicate slug and email, and weak passwords', async () => {
    await registerOwner(t);
    const c = t.client();
    const dupSlug = await c.post('/auth/register', {
      organizationName: 'Other Org', organizationSlug: 'riyadh-falcons', defaultLocale: 'en',
      displayName: 'X', email: 'new@example.com', password: PASSWORD,
    });
    expect(dupSlug.body.error.code).toBe('slug_taken');
    const dupEmail = await c.post('/auth/register', {
      organizationName: 'Other Org', organizationSlug: 'other-org', defaultLocale: 'en',
      displayName: 'X', email: 'OWNER@example.com', password: PASSWORD,
    });
    expect(dupEmail.body.error.code).toBe('email_taken');
    const weak = await c.post('/auth/register', {
      organizationName: 'Other Org', organizationSlug: 'third-org', defaultLocale: 'en',
      displayName: 'X', email: 'w@example.com', password: 'short',
    });
    expect(weak.status).toBe(400);
  });

  test('can be disabled by environment', async () => {
    const t2 = await startApp({ env: { ORG_SIGNUP_ENABLED: 'false' } });
    try {
      const res = await t2.client().post('/auth/register', {
        organizationName: 'Other Org', organizationSlug: 'xx-org', defaultLocale: 'en',
        displayName: 'X', email: 'x@example.com', password: PASSWORD,
      });
      expect(res.body.error.code).toBe('signup_disabled');
    } finally {
      await t2.close();
    }
  });
});

describe('login / logout / sessions', () => {
  test('wrong password and unknown email give the same error, and are logged', async () => {
    await registerOwner(t);
    const c = t.client();
    const wrong = await c.post('/auth/login', { email: 'owner@example.com', password: 'nope-nope-nope' });
    const unknown = await c.post('/auth/login', { email: 'ghost@example.com', password: 'nope-nope-nope' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error).toEqual(unknown.body.error);
    const failures = await t.db.select().from(auditLogs).where(eq(auditLogs.action, 'auth.login_failed'));
    expect(failures.length).toBe(2);
  });

  test('login is case-insensitive on email and issues a fresh session id', async () => {
    const { client: first } = await registerOwner(t);
    const oldSid = first.cookies.get('esp_sid');
    const res = await first.post('/auth/login', { email: 'Owner@Example.com', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(first.cookies.get('esp_sid')).not.toBe(oldSid);
    // The pre-login session id no longer works (session fixation defence).
    const stale = t.client();
    stale.cookies.set('esp_sid', oldSid!);
    expect((await stale.get('/auth/me')).status).toBe(401);
  });

  test('logout revokes the session server-side immediately', async () => {
    const { client } = await registerOwner(t);
    const copy = client.clone();
    expect((await client.post('/auth/logout')).status).toBe(204);
    expect((await copy.get('/auth/me')).status).toBe(401);
  });

  test('session cookie is HttpOnly and SameSite=Lax', async () => {
    const c = t.client();
    await registerOwner(t);
    const res = await c.post('/auth/login', { email: 'owner@example.com', password: PASSWORD });
    const cookie = res.headers.getSetCookie().find((x) => x.startsWith('esp_sid='))!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
  });

  test('revoke other sessions keeps only the current one', async () => {
    const { client } = await registerOwner(t);
    const other = t.client();
    await other.post('/auth/login', { email: 'owner@example.com', password: PASSWORD });
    const res = await client.post('/me/sessions/revoke-others');
    expect(res.body.revoked).toBe(1);
    expect((await other.get('/auth/me')).status).toBe(401);
    expect((await client.get('/auth/me')).status).toBe(200);
  });
});

describe('rate limiting', () => {
  test('login attempts per email are limited', async () => {
    await registerOwner(t);
    const c = t.client();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await c.post('/auth/login', { email: 'owner@example.com', password: 'wrong-password-x' })).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
    const blocked = await c.post('/auth/login', { email: 'owner@example.com', password: PASSWORD });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});

describe('CSRF origin check', () => {
  test('state-changing requests from a foreign origin are refused', async () => {
    const { client } = await registerOwner(t);
    client.origin = 'https://evil.example';
    const res = await client.post('/departments', { name: 'X' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('origin_not_allowed');
  });
});

describe('password recovery', () => {
  test('full reset flow: email link, single use, revokes all sessions', async () => {
    const { client } = await registerOwner(t);
    const anon = t.client();
    expect((await anon.post('/auth/password/forgot', { email: 'owner@example.com' })).status).toBe(204);
    const mail = await latestEmail(t, 'owner@example.com');
    const url = extractUrl(mail!.text, '/reset-password');
    const token = new URL(url).searchParams.get('token')!;

    const newPassword = 'a brand new passphrase';
    expect((await anon.post('/auth/password/reset', { token, password: newPassword })).status).toBe(204);
    // Existing sessions were revoked.
    expect((await client.get('/auth/me')).status).toBe(401);
    // Old password no longer works, new one does.
    expect((await anon.post('/auth/login', { email: 'owner@example.com', password: PASSWORD })).status).toBe(401);
    expect((await anon.post('/auth/login', { email: 'owner@example.com', password: newPassword })).status).toBe(200);
    // Token is single-use.
    const again = await anon.post('/auth/password/reset', { token, password: 'yet another passphrase' });
    expect(again.body.error.code).toBe('invalid_or_expired_token');
  });

  test('unknown emails get the same response and no email is sent', async () => {
    const res = await t.client().post('/auth/password/forgot', { email: 'ghost@example.com' });
    expect(res.status).toBe(204);
    expect(await latestEmail(t, 'ghost@example.com')).toBeNull();
  });

  test('only the newest link works, and expired links are refused', async () => {
    await registerOwner(t);
    const anon = t.client();
    await anon.post('/auth/password/forgot', { email: 'owner@example.com' });
    const first = new URL(extractUrl((await latestEmail(t, 'owner@example.com'))!.text, '/reset-password')).searchParams.get('token')!;
    await Bun.sleep(5);
    await anon.post('/auth/password/forgot', { email: 'owner@example.com' });
    const second = new URL(extractUrl((await latestEmail(t, 'owner@example.com'))!.text, '/reset-password')).searchParams.get('token')!;
    expect(first).not.toBe(second);
    expect((await anon.post('/auth/password/reset', { token: first, password: 'some new password!' })).status).toBe(400);

    await t.db.update(passwordResetTokens).set({ expiresAt: sql`now() - interval '1 minute'` }).where(and(sql`true`));
    expect((await anon.post('/auth/password/reset', { token: second, password: 'some new password!' })).status).toBe(400);
  });

  test('reset tokens are stored hashed, never in plain text', async () => {
    await registerOwner(t);
    await t.client().post('/auth/password/forgot', { email: 'owner@example.com' });
    const token = new URL(extractUrl((await latestEmail(t, 'owner@example.com'))!.text, '/reset-password')).searchParams.get('token')!;
    const rows = await t.db.select().from(passwordResetTokens);
    expect(rows.length).toBe(1);
    expect(rows[0]!.tokenHash).not.toBe(token);
    expect(rows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('change password', () => {
  test('requires the current password and revokes other sessions', async () => {
    const { client } = await registerOwner(t);
    const other = t.client();
    await other.post('/auth/login', { email: 'owner@example.com', password: PASSWORD });
    const bad = await client.post('/me/password', { currentPassword: 'wrong', newPassword: 'new password 1234' });
    expect(bad.status).toBe(400);
    const ok = await client.post('/me/password', { currentPassword: PASSWORD, newPassword: 'new password 1234' });
    expect(ok.status).toBe(204);
    expect((await other.get('/auth/me')).status).toBe(401);
    expect((await client.get('/auth/me')).status).toBe(200);
  });
});

describe('profile', () => {
  test('locale preference can be set to Arabic', async () => {
    const { client } = await registerOwner(t);
    const res = await client.patch<MeResponse>('/me', { locale: 'ar', displayName: 'فهد' });
    expect(res.body.user.locale).toBe('ar');
    expect(res.body.user.displayName).toBe('فهد');
  });
});
