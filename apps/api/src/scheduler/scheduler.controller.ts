/**
 * Scheduler tick for deployments where the API runs as a function (Vercel): nothing runs between
 * requests there, so Vercel Cron Jobs call this route every minute instead of the in-process
 * timer. Vercel sends "Authorization: Bearer <CRON_SECRET>"; anything else gets 401, and without
 * a configured secret the route doesn't exist (404). The work is the same as a timer tick and is
 * safe to run concurrently (reminders are claimed by a unique row, jobs with SKIP LOCKED).
 */
import { Controller, Get, Headers, HttpCode, Inject } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../authz/context';
import { safeEqual } from '../common/crypto';
import { AppError, Errors } from '../common/errors';
import { type Env, ENV } from '../config/env';
import { SchedulerService } from './scheduler.service';

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
