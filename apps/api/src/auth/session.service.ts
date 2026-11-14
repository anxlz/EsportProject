/**
 * Server-side sessions in Redis (not JWTs) so any session can be revoked instantly — on logout,
 * password change, password reset, or member suspension.
 *
 * - The browser holds only an opaque 256-bit session id in an HttpOnly cookie.
 * - Redis keys are HMAC(SESSION_SECRET, id), so a Redis dump cannot be replayed as cookies.
 * - Sessions have an idle timeout (sliding) and an absolute lifetime.
 * - A per-user index set allows "revoke all sessions for this user (in this organization)".
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import type { Redis } from 'ioredis';
import { type Env, ENV } from '../config/env';
import { hmacSha256, randomToken } from '../common/crypto';
import { REDIS } from '../core/core.module';

export interface SessionData {
  userId: string;
  activeOrganizationId: string | null;
  createdAt: number;
  lastSeenAt: number;
  ip: string | null;
  userAgent: string | null;
}

export interface LoadedSession {
  id: string;
  key: string;
  data: SessionData;
}

const TOUCH_INTERVAL_MS = 60_000;

@Injectable()
export class SessionService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly env: Env,
  ) {}

  get cookieName(): string {
    // The __Host- prefix makes browsers refuse the cookie unless Secure, Path=/ and no Domain.
    return this.env.cookieSecure ? '__Host-esp_sid' : 'esp_sid';
  }

  get absoluteTtlMs(): number {
    return this.env.SESSION_ABSOLUTE_TTL_DAYS * 24 * 3600 * 1000;
  }

  private get idleTtlSeconds(): number {
    return Math.round(this.env.SESSION_IDLE_TTL_HOURS * 3600);
  }

  private keyFor(id: string): string {
    return `sess:${hmacSha256(this.env.SESSION_SECRET, id)}`;
  }

  private userIndex(userId: string): string {
    return `usess:${userId}`;
  }

  writeCookie(res: Response, session: LoadedSession): void {
    res.cookie(this.cookieName, session.id, {
      httpOnly: true,
      secure: this.env.cookieSecure,
      sameSite: 'lax',
      path: '/',
      maxAge: this.absoluteTtlMs,
    });
  }

  clearCookie(res: Response): void {
    res.clearCookie(this.cookieName, {
      httpOnly: true,
      secure: this.env.cookieSecure,
      sameSite: 'lax',
      path: '/',
    });
  }

  async create(
    userId: string,
    activeOrganizationId: string | null,
    meta: { ip: string | null; userAgent: string | null },
  ): Promise<LoadedSession> {
    const id = randomToken(32);
    const key = this.keyFor(id);
    const now = Date.now();
    const data: SessionData = {
      userId,
      activeOrganizationId,
      createdAt: now,
      lastSeenAt: now,
      ip: meta.ip,
      userAgent: meta.userAgent?.slice(0, 300) ?? null,
    };
    await this.redis
      .multi()
      .set(key, JSON.stringify(data), 'EX', this.idleTtlSeconds)
      .sadd(this.userIndex(userId), key)
      .expire(this.userIndex(userId), Math.ceil(this.absoluteTtlMs / 1000))
      .exec();
    return { id, key, data };
  }

  async load(id: string | undefined): Promise<LoadedSession | null> {
    if (!id || id.length > 100) return null;
    const key = this.keyFor(id);
    const raw = await this.redis.get(key);
    if (!raw) return null;
    const data = JSON.parse(raw) as SessionData;
    const now = Date.now();
    if (now - data.createdAt > this.absoluteTtlMs) {
      await this.destroyByKey(key, data.userId);
      return null;
    }
    if (now - data.lastSeenAt > TOUCH_INTERVAL_MS) {
      data.lastSeenAt = now;
      await this.redis.set(key, JSON.stringify(data), 'EX', this.idleTtlSeconds);
    }
    return { id, key, data };
  }

  async setActiveOrganization(
    session: LoadedSession,
    organizationId: string | null,
  ): Promise<void> {
    session.data.activeOrganizationId = organizationId;
    await this.redis.set(session.key, JSON.stringify(session.data), 'EX', this.idleTtlSeconds);
  }

  async destroy(session: LoadedSession): Promise<void> {
    await this.destroyByKey(session.key, session.data.userId);
  }

  private async destroyByKey(key: string, userId: string): Promise<void> {
    await this.redis.multi().del(key).srem(this.userIndex(userId), key).exec();
  }

  /**
   * Revoke sessions for a user. With `organizationId`, only sessions whose active organization is
   * that one (used for suspension). With `exceptKey`, keeps the caller's current session.
   * Returns how many sessions were revoked.
   */
  async destroyAllForUser(
    userId: string,
    opts: { organizationId?: string; exceptKey?: string } = {},
  ): Promise<number> {
    const index = this.userIndex(userId);
    const keys = await this.redis.smembers(index);
    let revoked = 0;
    for (const key of keys) {
      if (key === opts.exceptKey) continue;
      const raw = await this.redis.get(key);
      if (!raw) {
        await this.redis.srem(index, key);
        continue;
      }
      if (opts.organizationId) {
        const data = JSON.parse(raw) as SessionData;
        if (data.activeOrganizationId !== opts.organizationId) continue;
      }
      await this.destroyByKey(key, userId);
      revoked++;
    }
    return revoked;
  }
}
