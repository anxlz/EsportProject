/**
 * Redis fixed-window rate limiting, shared across all API instances.
 *
 *   @RateLimit('login')   // on a route handler
 *
 * Policies are keyed by client IP and, where useful, by the submitted email so that one
 * attacker cannot lock out a victim from everywhere, and many IPs cannot hammer one account.
 */
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import type Redis from 'ioredis';
import { REDIS } from '../core/core.module';
import { AppError } from './errors';
import { sha256 } from './crypto';

interface Rule {
  by: 'ip' | 'email';
  limit: number;
  windowSeconds: number;
}

export const RATE_LIMIT_POLICIES = {
  login: [
    { by: 'ip', limit: 30, windowSeconds: 900 },
    { by: 'email', limit: 10, windowSeconds: 900 },
  ],
  register: [{ by: 'ip', limit: 5, windowSeconds: 3600 }],
  forgotPassword: [
    { by: 'ip', limit: 10, windowSeconds: 3600 },
    { by: 'email', limit: 3, windowSeconds: 3600 },
  ],
  resetPassword: [{ by: 'ip', limit: 20, windowSeconds: 900 }],
  publicToken: [{ by: 'ip', limit: 30, windowSeconds: 900 }],
  oauth: [{ by: 'ip', limit: 30, windowSeconds: 900 }],
  changePassword: [{ by: 'ip', limit: 10, windowSeconds: 900 }],
} satisfies Record<string, Rule[]>;

export type RateLimitPolicy = keyof typeof RATE_LIMIT_POLICIES;

const RATE_LIMIT_KEY = 'rate_limit_policy';
export const RateLimit = (policy: RateLimitPolicy) => SetMetadata(RATE_LIMIT_KEY, policy);

@Injectable()
export class RateLimitService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Returns seconds to wait if the limit is exceeded, otherwise null. */
  async consume(bucket: string, limit: number, windowSeconds: number): Promise<number | null> {
    const key = `rl:${bucket}`;
    const res = await this.redis.multi().incr(key).expire(key, windowSeconds, 'NX').ttl(key).exec();
    const count = Number(res?.[0]?.[1] ?? 0);
    const ttl = Number(res?.[2]?.[1] ?? windowSeconds);
    return count > limit ? Math.max(ttl, 1) : null;
  }
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimitService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const policy = this.reflector.get<RateLimitPolicy | undefined>(RATE_LIMIT_KEY, ctx.getHandler());
    if (!policy) return true;
    const req = ctx.switchToHttp().getRequest<Request>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const ip = req.ip ?? 'unknown';
    const body = (req.body ?? {}) as { email?: unknown };
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : null;

    for (const rule of RATE_LIMIT_POLICIES[policy] as Rule[]) {
      const subject = rule.by === 'ip' ? ip : email;
      if (!subject) continue;
      const wait = await this.limiter.consume(
        `${policy}:${rule.by}:${sha256(subject)}`,
        rule.limit,
        rule.windowSeconds,
      );
      if (wait !== null) {
        res.setHeader('Retry-After', String(wait));
        throw new AppError('rate_limited', 429, 'Too many requests, try again later', {
          retryAfterSeconds: wait,
        });
      }
    }
    return true;
  }
}
