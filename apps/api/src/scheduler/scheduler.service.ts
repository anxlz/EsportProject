/**
 * A small in-process scheduler for periodic work (meeting reminders, integration jobs, Google
 * channel renewals). Each instance ticks on its own; the work itself is safe to run on several
 * instances at once (reminders are claimed by a unique row, jobs with FOR UPDATE SKIP LOCKED).
 * SCHEDULER_INTERVAL_SECONDS=0 turns it off (the tests drive ticks themselves).
 */
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { type Env, ENV } from '../config/env';

type Task = { name: string; run: () => Promise<unknown> };

@Injectable()
export class SchedulerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Scheduler');
  private readonly tasks: Task[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;

  constructor(@Inject(ENV) private readonly env: Env) {}

  register(name: string, run: () => Promise<unknown>) {
    this.tasks.push({ name, run });
  }

  onApplicationBootstrap() {
    const seconds = this.env.SCHEDULER_INTERVAL_SECONDS;
    if (!seconds) return;
    this.timer = setInterval(() => void this.tick(), seconds * 1000);
    this.timer.unref?.();
  }

  async onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  /** Runs every task once (skipped if the previous tick is still running). */
  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      for (const t of this.tasks) {
        try {
          await t.run();
        } catch (e) {
          this.logger.error(`${t.name} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }
}
