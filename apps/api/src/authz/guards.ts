import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PermissionKey } from '@esports/shared';
import { eq } from 'drizzle-orm';
import type { Request } from 'express';
import { SessionService } from '../auth/session.service';
import { type Env, ENV } from '../config/env';
import { AppError, Errors } from '../common/errors';
import { DB, type Database } from '../db/client';
import { platformAdmins, users } from '../db/schema';
import { AccessService } from './access.service';
import {
  clientMeta,
  IS_PUBLIC,
  PLATFORM_ADMIN_ONLY,
  REQUIRE_ORG,
  REQUIRED_PERMISSIONS,
  type RequestWithContext,
} from './context';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence in depth. Session cookies are SameSite=Lax (no cross-site POSTs carry them);
 * additionally, any state-changing request that declares an Origin must come from an allowed one.
 */
@Injectable()
export class OriginGuard implements CanActivate {
  constructor(@Inject(ENV) private readonly env: Env) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method)) return true;
    const origin = req.headers.origin;
    if (origin && !this.env.allowedOrigins.includes(origin)) {
      throw new AppError('origin_not_allowed', 403, 'Origin not allowed');
    }
    return true;
  }
}

/**
 * Loads the session, the user and (if an organization is active) their Access, then enforces
 * the route's declared requirements. Runs for every request.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly accessService: AccessService,
    @Inject(DB) private readonly db: Database,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<RequestWithContext>();
    const handler = ctx.getHandler();
    const cls = ctx.getClass();
    const get = <T>(key: string) => this.reflector.getAllAndOverride<T>(key, [handler, cls]);

    const isPublic = get<boolean>(IS_PUBLIC) === true;
    await this.attachContext(req);

    if (isPublic) return true;
    if (!req.ctx) throw Errors.unauthenticated();

    if (get<boolean>(PLATFORM_ADMIN_ONLY)) {
      const [admin] = await this.db
        .select({ userId: platformAdmins.userId })
        .from(platformAdmins)
        .where(eq(platformAdmins.userId, req.ctx.user.id));
      if (!admin) throw Errors.forbidden();
      return true;
    }

    const required = get<PermissionKey[]>(REQUIRED_PERMISSIONS);
    if (required?.length || get<boolean>(REQUIRE_ORG)) {
      if (!req.ctx.organizationId || !req.ctx.access) {
        throw new AppError('no_active_organization', 403, 'No active organization');
      }
      for (const perm of required ?? []) {
        if (!req.ctx.access.has(perm)) throw Errors.forbidden();
      }
    }
    return true;
  }

  private async attachContext(req: RequestWithContext): Promise<void> {
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies ?? {};
    const session = await this.sessions.load(cookies[this.sessions.cookieName]);
    if (!session) return;

    const [user] = await this.db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        locale: users.locale,
      })
      .from(users)
      .where(eq(users.id, session.data.userId));
    if (!user) {
      await this.sessions.destroy(session);
      return;
    }

    let organizationId = session.data.activeOrganizationId;
    let access = null;
    if (organizationId) {
      const resolved = await this.accessService.resolve(organizationId, user.id);
      if (resolved.status === 'suspended') {
        // Belt and braces: suspension already revokes these sessions, but never trust that alone.
        await this.sessions.destroy(session);
        throw new AppError('account_suspended', 401, 'Your access to this organization is suspended');
      }
      if (resolved.status === 'none') {
        await this.sessions.setActiveOrganization(session, null);
        organizationId = null;
      } else {
        access = resolved.access;
      }
    }

    req.ctx = { session, user, organizationId, access, ...clientMeta(req) };
  }
}
