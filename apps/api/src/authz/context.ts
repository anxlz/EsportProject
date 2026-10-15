import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import { ApiCookieAuth } from '@nestjs/swagger';
import type { Locale, PermissionKey } from '@esports/shared';
import type { Request } from 'express';
import type { LoadedSession } from '../auth/session.service';
import { AppError, Errors } from '../common/errors';
import type { Access } from './access';

export interface ClientMeta {
  ip: string | null;
  userAgent: string | null;
}

export interface AuthContext extends ClientMeta {
  session: LoadedSession;
  user: { id: string; email: string; displayName: string; locale: Locale | null };
  organizationId: string | null;
  access: Access | null;
}

/** Authenticated + an active organization the user is an active member of. */
export interface TenantContext extends AuthContext {
  organizationId: string;
  access: Access;
}

export type RequestWithContext = Request & { ctx?: AuthContext };

export const IS_PUBLIC = 'is_public';
export const REQUIRED_PERMISSIONS = 'required_permissions';
export const REQUIRE_ORG = 'require_org';
export const PLATFORM_ADMIN_ONLY = 'platform_admin_only';

/** No session required (the session, if any, is still loaded). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * The caller must hold every listed permission at SOME scope. Record-level scope checks happen in
 * the service via `ctx.access.coversTeam(...)` / scope filters — this guard is the coarse gate.
 */
export const RequirePermission = (...perms: PermissionKey[]) => {
  const meta = SetMetadata(REQUIRED_PERMISSIONS, perms);
  const doc = ApiCookieAuth();
  return (target: object, key?: string | symbol, descriptor?: PropertyDescriptor) => {
    meta(target, key as string, descriptor as PropertyDescriptor);
    doc(target, key as string, descriptor as PropertyDescriptor);
  };
};

/** Authenticated with an active organization, no specific permission (e.g. own notifications). */
export const RequireOrg = () => SetMetadata(REQUIRE_ORG, true);

export const PlatformAdminOnly = () => SetMetadata(PLATFORM_ADMIN_ONLY, true);

export function clientMeta(req: Request): ClientMeta {
  const ua = req.headers['user-agent'];
  return { ip: req.ip ?? null, userAgent: typeof ua === 'string' ? ua.slice(0, 300) : null };
}

export const Ctx = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthContext => {
  const req = ctx.switchToHttp().getRequest<RequestWithContext>();
  if (!req.ctx) throw Errors.unauthenticated();
  return req.ctx;
});

export const OptionalCtx = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthContext | null =>
    ctx.switchToHttp().getRequest<RequestWithContext>().ctx ?? null,
);

export const TenantCtx = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): TenantContext => {
    const req = ctx.switchToHttp().getRequest<RequestWithContext>();
    if (!req.ctx) throw Errors.unauthenticated();
    if (!req.ctx.organizationId || !req.ctx.access) {
      throw new AppError('no_active_organization', 403, 'No active organization');
    }
    return req.ctx as TenantContext;
  },
);

export const Meta = createParamDecorator((_: unknown, ctx: ExecutionContext): ClientMeta =>
  clientMeta(ctx.switchToHttp().getRequest<Request>()),
);
