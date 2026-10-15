/**
 * Discord OAuth with a fake provider. The values below are placeholders that only satisfy env
 * validation; the real HTTP client is replaced, so nothing ever reaches Discord.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MeResponse } from '@esports/shared';
import type { DiscordOAuthClient, DiscordProfile } from '../src/auth/discord.client';
import { type Client, registerOwner, startApp, type TestApp, WEB_ORIGIN } from './harness';

class FakeDiscord implements DiscordOAuthClient {
  profiles = new Map<string, DiscordProfile>();
  authorizeUrl(state: string) {
    return `https://discord.test/authorize?state=${state}`;
  }
  async fetchProfile(code: string) {
    const p = this.profiles.get(code);
    if (!p) throw new Error('bad code');
    return p;
  }
}

const fake = new FakeDiscord();
let t: TestApp;
beforeAll(async () => {
  t = await startApp({
    discord: fake,
    env: {
      DISCORD_CLIENT_ID: 'placeholder-client-id',
      DISCORD_CLIENT_SECRET: 'placeholder-client-secret',
      DISCORD_REDIRECT_URI: `${WEB_ORIGIN}/api/auth/discord/callback`,
    },
  });
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.reset();
  fake.profiles.clear();
  fake.profiles.set('code-fahad', { id: '111', username: 'fahad', globalName: 'Fahad', email: 'owner@example.com', verified: true });
  fake.profiles.set('code-other', { id: '222', username: 'other', globalName: null, email: 'x@example.com', verified: true });
});

async function runFlow(client: Client, mode: 'login' | 'link', code: string) {
  const start = await client.get(`/auth/discord/start?mode=${mode}`);
  expect(start.status).toBe(302);
  const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
  const cb = await client.get(`/auth/discord/callback?code=${code}&state=${state}`);
  expect(cb.status).toBe(302);
  return { state, location: cb.headers.get('location')! };
}

describe('Discord OAuth', () => {
  test('config advertises Discord when configured', async () => {
    expect((await t.client().get('/auth/config')).body.discordEnabled).toBe(true);
  });

  test('login with an unlinked Discord account is refused (no auto-link by email)', async () => {
    await registerOwner(t);
    const c = t.client();
    const { location } = await runFlow(c, 'login', 'code-fahad');
    expect(location).toBe(`${WEB_ORIGIN}/login?error=discord_not_linked`);
    expect(c.cookies.has('esp_sid')).toBe(false);
  });

  test('link from settings, then sign in with Discord', async () => {
    const { client: owner } = await registerOwner(t);
    const linked = await runFlow(owner, 'link', 'code-fahad');
    expect(linked.location).toBe(`${WEB_ORIGIN}/dashboard/settings?discord=linked`);
    expect((await owner.get<MeResponse>('/auth/me')).body.user).toMatchObject({ discordLinked: true, discordUsername: 'Fahad' });

    const fresh = t.client();
    const { location } = await runFlow(fresh, 'login', 'code-fahad');
    expect(location).toBe(`${WEB_ORIGIN}/dashboard`);
    expect((await fresh.get<MeResponse>('/auth/me')).body.user.email).toBe('owner@example.com');
  });

  test('a Discord account can only be linked to one user', async () => {
    const { client: a } = await registerOwner(t);
    const { client: b } = await registerOwner(t, { slug: 'jeddah-eagles', email: 'b@example.com', name: 'Jeddah Eagles' });
    await runFlow(a, 'link', 'code-fahad');
    const { location } = await runFlow(b, 'link', 'code-fahad');
    expect(location).toContain('error=discord_already_linked');
  });

  test('state is single-use and bound to the browser that started the flow', async () => {
    const { client: owner } = await registerOwner(t);
    await runFlow(owner, 'link', 'code-fahad');

    const victim = t.client();
    const start = await victim.get('/auth/discord/start?mode=login');
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    // Another browser (no nonce cookie) presenting the victim's state is refused.
    const attacker = t.client();
    const stolen = await attacker.get(`/auth/discord/callback?code=code-fahad&state=${state}`);
    expect(stolen.headers.get('location')).toContain('error=oauth_state_invalid');
    // And the state is now consumed.
    const replay = await victim.get(`/auth/discord/callback?code=code-fahad&state=${state}`);
    expect(replay.headers.get('location')).toContain('error=oauth_state_invalid');
  });

  test('linking requires a session; unlinking requires a password to remain', async () => {
    const anon = t.client();
    expect((await anon.get('/auth/discord/start?mode=link')).status).toBe(401);
    const { client: owner } = await registerOwner(t);
    await runFlow(owner, 'link', 'code-fahad');
    expect((await owner.del('/me/discord')).status).toBe(204);
    expect((await owner.get<MeResponse>('/auth/me')).body.user.discordLinked).toBe(false);
  });
});

describe('Discord not configured', () => {
  test('start returns 503 and config hides it', async () => {
    const t2 = await startApp();
    try {
      expect((await t2.client().get('/auth/config')).body.discordEnabled).toBe(false);
      expect((await t2.client().get('/auth/discord/start')).status).toBe(503);
    } finally {
      await t2.close();
    }
  });
});
