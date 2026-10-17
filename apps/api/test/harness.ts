/**
 * Integration-test harness: boots the real Nest app (real Postgres + Redis, test databases),
 * listening on a random port, and drives it over HTTP with a cookie-aware client — exactly the
 * path a browser takes. Only external services (Discord, SMTP) are replaced.
 */
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { MeResponse, RoleAssignmentInput } from '@esports/shared';
import { desc, eq, sql } from 'drizzle-orm';
import Redis from 'ioredis';
import { AI_PROVIDER, type AiProvider } from '../src/ai/ai.provider';
import { AppModule } from '../src/app.module';
import { DISCORD_CLIENT, type DiscordOAuthClient } from '../src/auth/discord.client';
import { configureApp } from '../src/bootstrap';
import { loadEnv } from '../src/config/env';
import { createDb, type DbHandle } from '../src/db/client';
import { CLOCK, type Clock } from '../src/finance/clock';
import { FX_PROVIDER, type FxRateProvider } from '../src/finance/fx.provider';
import { runMigrations } from '../src/db/migrate';
import { devOutbox } from '../src/db/schema';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:devpass@127.0.0.1:5432/esports_test';
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/1';
export const WEB_ORIGIN = 'http://localhost:3000';

const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: TEST_DATABASE_URL,
  REDIS_URL: TEST_REDIS_URL,
  WEB_APP_URL: WEB_ORIGIN,
  // Test-only value; real deployments generate their own (see .env.example).
  SESSION_SECRET: 'test-session-secret-not-used-anywhere-else-0123456789',
  COOKIE_SECURE: 'false',
  MAIL_TRANSPORT: 'outbox',
  ENABLE_API_DOCS: 'false',
  // Tests never call the real exchange-rate service; individual tests inject a fake provider.
  FX_PROVIDER: 'none',
};

let migrated = false;

export interface TestApp {
  app: INestApplication;
  baseUrl: string;
  db: DbHandle['db'];
  redis: Redis;
  client(): Client;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function startApp(
  opts: {
    env?: Record<string, string>;
    discord?: DiscordOAuthClient;
    fx?: FxRateProvider;
    clock?: Clock;
    ai?: AiProvider;
  } = {},
): Promise<TestApp> {
  if (!migrated) {
    await runMigrations(TEST_DATABASE_URL);
    migrated = true;
  }
  const chromium = process.env.CHROMIUM_EXECUTABLE_PATH;
  const env = loadEnv({
    ...BASE_ENV,
    ...(chromium ? { CHROMIUM_EXECUTABLE_PATH: chromium } : {}),
    ...opts.env,
  });
  let builder = Test.createTestingModule({ imports: [AppModule.forRoot(env)] });
  if (opts.discord) builder = builder.overrideProvider(DISCORD_CLIENT).useValue(opts.discord);
  if (opts.fx) builder = builder.overrideProvider(FX_PROVIDER).useValue(opts.fx);
  if (opts.clock) builder = builder.overrideProvider(CLOCK).useValue(opts.clock);
  if (opts.ai) builder = builder.overrideProvider(AI_PROVIDER).useValue(opts.ai);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({
    logger: process.env.TEST_LOGS ? ['error', 'warn'] : false,
  });
  configureApp(app, env);
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const handle = createDb(TEST_DATABASE_URL, { prepare: true, max: 2 });
  const redis = new Redis(TEST_REDIS_URL);

  const t: TestApp = {
    app,
    baseUrl,
    db: handle.db,
    redis,
    client: () => new Client(baseUrl),
    reset: async () => {
      const tables = await handle.sql<{ tablename: string }[]>`
        select tablename from pg_tables where schemaname = 'app' and tablename <> '__drizzle_migrations'`;
      await handle.sql.unsafe(
        `truncate ${tables.map((r) => `app."${r.tablename}"`).join(', ')} restart identity cascade`,
      );
      await redis.flushdb();
    },
    close: async () => {
      await app.close();
      await handle.sql.end();
      redis.disconnect();
    },
  };
  await t.reset();
  return t;
}

export interface Res<T = any> {
  status: number;
  body: T;
  headers: Headers;
  text: string;
  bytes: Buffer;
}

/** Minimal browser stand-in: keeps cookies, sends the web app's Origin on writes. */
export class Client {
  readonly cookies = new Map<string, string>();
  origin: string | null = WEB_ORIGIN;

  constructor(private readonly baseUrl: string) {}

  async request<T = any>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<Res<T>> {
    const headers: Record<string, string> = { ...extraHeaders };
    const raw = body instanceof Uint8Array;
    if (body !== undefined && !raw) headers['content-type'] = 'application/json';
    if (this.origin && method !== 'GET') headers.origin = this.origin;
    if (this.cookies.size) {
      headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    const res = await fetch(this.baseUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : raw ? (body as Uint8Array) : JSON.stringify(body),
      redirect: 'manual',
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      const idx = pair!.indexOf('=');
      const name = pair!.slice(0, idx).trim();
      const value = pair!.slice(idx + 1).trim();
      const expired = attrs.some(
        (a) => /expires=thu, 01 jan 1970/i.test(a.trim()) || /max-age=0/i.test(a.trim()),
      );
      if (expired || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    const text = bytes.toString('utf8');
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    return { status: res.status, body: parsed as T, headers: res.headers, text, bytes };
  }

  /** Raw upload: the request body is the file itself. */
  upload<T = any>(path: string, data: Uint8Array, contentType: string) {
    return this.request<T>('POST', path, data, { 'content-type': contentType });
  }

  get<T = any>(path: string) {
    return this.request<T>('GET', path);
  }
  post<T = any>(path: string, body: unknown = {}) {
    return this.request<T>('POST', path, body);
  }
  put<T = any>(path: string, body: unknown = {}) {
    return this.request<T>('PUT', path, body);
  }
  patch<T = any>(path: string, body: unknown = {}) {
    return this.request<T>('PATCH', path, body);
  }
  del<T = any>(path: string) {
    return this.request<T>('DELETE', path);
  }

  /** A second "device" for the same user: shares nothing but a copy of the cookies. */
  clone(): Client {
    const c = new Client(this.baseUrl);
    for (const [k, v] of this.cookies) c.cookies.set(k, v);
    return c;
  }
}

export const PASSWORD = 'correct horse battery staple';

export async function registerOwner(
  t: TestApp,
  overrides: Partial<{ slug: string; email: string; name: string; displayName: string }> = {},
): Promise<{ client: Client; me: MeResponse }> {
  const client = t.client();
  const res = await client.post<MeResponse>('/auth/register', {
    organizationName: overrides.name ?? 'Riyadh Falcons',
    organizationSlug: overrides.slug ?? 'riyadh-falcons',
    defaultLocale: 'en',
    displayName: overrides.displayName ?? 'Fahad Owner',
    email: overrides.email ?? 'owner@example.com',
    password: PASSWORD,
  });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${res.text}`);
  return { client, me: res.body };
}

export async function latestEmail(t: TestApp, to: string) {
  const [row] = await t.db
    .select()
    .from(devOutbox)
    .where(eq(devOutbox.to, to))
    .orderBy(desc(devOutbox.createdAt))
    .limit(1);
  return row ?? null;
}

export function extractUrl(text: string, pathPrefix: string): string {
  const match = text.match(
    new RegExp(`${WEB_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${pathPrefix}[^\\s]+`),
  );
  if (!match) throw new Error(`No ${pathPrefix} link in email`);
  return match[0];
}

/** Owner invites `email` with `assignments`; the invitee accepts. Returns the invitee's client. */
export async function inviteAndAccept(
  t: TestApp,
  owner: Client,
  email: string,
  assignments: RoleAssignmentInput[],
  displayName = 'Invited Member',
): Promise<{ client: Client; me: MeResponse; inviteUrl: string }> {
  const inv = await owner.post('/invitations', { email, assignments });
  if (inv.status !== 201) throw new Error(`invite failed: ${inv.status} ${inv.text}`);
  const token = (inv.body.inviteUrl as string).split('/invite/')[1]!;
  const client = t.client();
  const acc = await client.post<MeResponse>(`/public/invitations/${token}/accept`, {
    displayName,
    password: PASSWORD,
  });
  if (acc.status !== 200) throw new Error(`accept failed: ${acc.status} ${acc.text}`);
  return { client, me: acc.body, inviteUrl: inv.body.inviteUrl };
}

export async function roleIdByTemplate(owner: Client, templateKey: string): Promise<string> {
  const roles = await owner.get('/roles');
  const role = (roles.body as { id: string; templateKey: string | null }[]).find(
    (r) => r.templateKey === templateKey,
  );
  if (!role) throw new Error(`no role ${templateKey}`);
  return role.id;
}

export { sql };
