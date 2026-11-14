import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { Public } from './authz/context';
import { REDIS } from './core/core.module';
import { DB, type Database } from './db/client';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get()
  @Public()
  async check() {
    const [db, redis] = await Promise.allSettled([
      this.db.execute(sql`select 1`),
      this.redis.ping(),
    ]);
    return {
      status: db.status === 'fulfilled' && redis.status === 'fulfilled' ? 'ok' : 'degraded',
      database: db.status === 'fulfilled' ? 'up' : 'down',
      redis: redis.status === 'fulfilled' ? 'up' : 'down',
    };
  }
}
