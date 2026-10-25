/**
 * Deploying on Vercel (one project, `web` and `api` services, Hobby plan): functions don't run
 * between requests and cron jobs may run only once a day, so a standalone worker (a Vercel
 * Daemon) drives the scheduler, with a daily cron tick through an authenticated route as a
 * backstop.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { formatLocal, utcToLocal } from '@esports/shared';
import { eq } from 'drizzle-orm';
import { notifications } from '../src/db/schema';
import { SchedulerService } from '../src/scheduler/scheduler.service';
import {
  registerOwner,
  startApp,
  TEST_DATABASE_URL,
  TEST_REDIS_URL,
  type TestApp,
} from './harness';

const SECRET = 'cron-secret-for-tests-0123456789';

describe('scheduler tick for Vercel Cron Jobs', () => {
  let t: TestApp;
  let plain: TestApp;
  beforeAll(async () => {
    t = await startApp({ env: { CRON_SECRET: SECRET } });
    plain = await startApp({});
  });
  afterAll(async () => {
    await t.close();
    await plain.close();
  });

  test('only the cron secret runs a tick; without a configured secret the route is closed', async () => {
    let ran = 0;
    t.app.get(SchedulerService).register('probe', async () => {
      ran++;
    });
    const c = t.client();
    const tick = (auth?: string) =>
      c.request('GET', '/internal/scheduler/tick', undefined, auth ? { authorization: auth } : {});

    expect((await tick()).status).toBe(401);
    expect((await tick('Bearer wrong-secret-0123456789')).status).toBe(401);
    expect((await tick(SECRET)).status).toBe(401); // the scheme is part of what Vercel sends
    expect(ran).toBe(0);
    const ok = await tick(`Bearer ${SECRET}`);
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(ran).toBe(1);

    // No CRON_SECRET configured: the route doesn't exist, whatever is sent.
    expect(
      (
        await plain.client().request('GET', '/internal/scheduler/tick', undefined, {
          authorization: `Bearer ${SECRET}`,
        })
      ).status,
    ).toBe(404);
  });

  test('the worker process delivers due reminders on its own and stops cleanly on SIGTERM', async () => {
    await t.reset();
    const { client } = await registerOwner(t);
    // A meeting 10 minutes from now with a 15-minute reminder: due on the worker's first tick.
    const startMs = Math.ceil((Date.now() + 10 * 60_000) / 60_000) * 60_000;
    const local = (ms: number) => formatLocal(utcToLocal(ms, 'Asia/Riyadh'));
    const created = await client.post('/meetings', {
      kind: 'standard',
      title: 'Worker check',
      start: local(startMs),
      end: local(startMs + 3_600_000),
      timeZone: 'Asia/Riyadh',
      recurrence: null,
      participantUserIds: [],
      reminderMinutes: [15],
    });
    expect(created.status).toBe(201);

    const worker = Bun.spawn(['bun', 'src/worker.ts'], {
      cwd: join(import.meta.dir, '..'),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: TEST_DATABASE_URL,
        REDIS_URL: TEST_REDIS_URL,
        WEB_APP_URL: 'http://localhost:3000',
        SESSION_SECRET: 'test-session-secret-not-used-anywhere-else-0123456789',
        MAIL_TRANSPORT: 'outbox',
        FX_PROVIDER: 'none',
        WORKER_INTERVAL_SECONDS: '10',
        // As on Vercel, where the API's own timer is off: the worker ticks regardless.
        VERCEL: '1',
        VERCEL_URL: 'esports-abc123.vercel.app',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    let reminders: unknown[] = [];
    for (let i = 0; i < 40 && !reminders.length; i++) {
      await Bun.sleep(500);
      reminders = await t.db
        .select()
        .from(notifications)
        .where(eq(notifications.type, 'meeting.reminder'));
    }
    worker.kill('SIGTERM');
    const code = await worker.exited;
    const out =
      (await new Response(worker.stdout).text()) + (await new Response(worker.stderr).text());
    expect({ reminders: reminders.length, code }).toEqual({ reminders: 1, code: 0 });
    expect(out).toContain('one tick every 10s');
    expect(out).toContain('Scheduler worker stopped');
  }, 40_000);
});
