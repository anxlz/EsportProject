/**
 * Scheduler tick over HTTP, for deployments where the API runs as functions (Vercel). On the
 * Hobby plan Vercel Cron Jobs may run only once a day, so this is a daily backstop; the
 * scheduler worker (src/worker.ts, a Vercel Daemon) does the minute-by-minute work. On Pro, a
 * cron calling this route every minute could replace the worker.
 *
 * Vercel sends "Authorization: Bearer <CRON_SECRET>"; anything else gets 401, and without a
 * configured secret the route doesn't exist (404). The work is the same as a timer tick and is
 * safe to run concurrently (reminders are claimed by a unique row, jobs with SKIP LOCKED).
 */
import { Controller, Get, Headers, HttpCode, Inject } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../authz/context.js';
import { safeEqual } from '../common/crypto.js';
import { AppError, Errors } from '../common/errors.js';
import { type Env, ENV } from '../config/env.js';
import { SchedulerService } from './scheduler.service.js';

@ApiExcludeController()
@Controller('internal/scheduler')
export class SchedulerController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly scheduler: SchedulerService,
  ) {}

  @Get('tick')
  @Public()
  @HttpCode(200)
  async tick(@Headers('authorization') authorization?: string) {
    const secret = this.env.CRON_SECRET;
    if (!secret) throw Errors.notFound('Route');
    if (!authorization || !safeEqual(authorization, `Bearer ${secret}`))
      throw new AppError('unauthenticated', 401, 'Not allowed');
    const startedAt = Date.now();
    await this.scheduler.tick();
    return { ok: true, durationMs: Date.now() - startedAt };
  }
}
