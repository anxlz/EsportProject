/**
 * Background worker: runs the scheduler (meeting reminders, integration sync jobs, Google
 * channel renewals) in a loop, without serving HTTP.
 *
 * Why it exists: on Vercel the API runs as functions, which don't run between requests, and on
 * the Hobby plan cron jobs may run at most once a day. This process runs as a Vercel Daemon
 * (always on; see vercel.json and Dockerfile.worker). Elsewhere the API's own in-process timer
 * does the same work, so the worker isn't needed there.
 *
 * Every task is safe to run alongside other instances (reminders are claimed by a unique row,
 * jobs with FOR UPDATE SKIP LOCKED), so overlapping with an API instance or the daily cron tick
 * does no harm. SIGTERM (a new deployment rolling out) stops it after the current tick.
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';
import { SchedulerService } from './scheduler/scheduler.service';

// The loop below drives the ticks, so the in-process timer stays off whatever the environment says.
const env = loadEnv({ ...process.env, SCHEDULER_INTERVAL_SECONDS: '0' });
const logger = new Logger('Worker');
const app = await NestFactory.createApplicationContext(AppModule.forRoot(env), {
  logger: env.NODE_ENV === 'production' ? ['log', 'warn', 'error'] : undefined,
});
const scheduler = app.get(SchedulerService);
const stop = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    logger.log(`${signal} received: finishing the current tick`);
    stop.abort();
  });

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    stop.signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });

logger.log(`Scheduler worker started: one tick every ${env.WORKER_INTERVAL_SECONDS}s`);
while (!stop.signal.aborted) {
  await scheduler.tick(); // each task logs its own failures; the loop keeps going
  await sleep(env.WORKER_INTERVAL_SECONDS * 1000);
}
await app.close();
logger.log('Scheduler worker stopped');
process.exit(0);
