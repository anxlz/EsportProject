import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { type Env, ENV } from '../config/env';
import { createDb, DB, DB_HANDLE, type DbHandle } from '../db/client';

export const REDIS = Symbol('REDIS');

@Injectable()
class Shutdown implements OnApplicationShutdown {
  constructor(
    @Inject(DB_HANDLE) private readonly handle: DbHandle,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.handle.sql.end({ timeout: 5 });
    this.redis.disconnect();
  }
}

/** Global infrastructure: validated env, Postgres (Drizzle) and Redis. */
@Global()
@Module({})
export class CoreModule {
  static forRoot(env: Env) {
    return {
      module: CoreModule,
      providers: [
        { provide: ENV, useValue: env },
        {
          provide: DB_HANDLE,
          useFactory: () =>
            createDb(env.DATABASE_URL, {
              prepare: env.DATABASE_PREPARE,
              max: env.DATABASE_POOL_MAX,
            }),
        },
        { provide: DB, useFactory: (h: DbHandle) => h.db, inject: [DB_HANDLE] },
        {
          provide: REDIS,
          useFactory: () =>
            new Redis(env.REDIS_URL, {
              lazyConnect: true,
              maxRetriesPerRequest: 3,
              connectTimeout: 5000,
              commandTimeout: 5000,
              retryStrategy: (attempt) => (attempt >= 3 ? null : Math.min(attempt * 200, 1000)),
            }),
        },
        Shutdown,
      ],
      exports: [ENV, DB, DB_HANDLE, REDIS],
    };
  }
}
