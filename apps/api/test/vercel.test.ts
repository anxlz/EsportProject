/**
 * Deploying on Vercel (one project, `web` and `api` services): Vercel Cron Jobs drive the
 * scheduler through an authenticated tick route, because functions don't run between requests.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SchedulerService } from '../src/scheduler/scheduler.service';
import { startApp, type TestApp } from './harness';

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
});
