import { Controller, Delete, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  acceptInvitationSchema,
  type CreateInvitationInput,
  createInvitationSchema,
  type MeResponse,
} from '@esports/shared';
import type { Response } from 'express';
import type { z } from 'zod';
import {
  type AuthContext,
  type ClientMeta,
  Ctx,
  Meta,
  OptionalCtx,
  Public,
  RequirePermission,
  type TenantContext,
  TenantCtx,
} from '../authz/context';
import { AuthService } from '../auth/auth.service';
import { SessionService } from '../auth/session.service';
import { RateLimit } from '../common/rate-limit';
import { UuidPipe, ZodBody } from '../common/zod';
import { InvitationsService } from './invitations.service';

@ApiTags('invitations')
@Controller()
export class InvitationsController {
  constructor(
    private readonly invitations: InvitationsService,
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  @Post('invitations')
  @RequirePermission('members.invite')
  create(
    @TenantCtx() ctx: TenantContext,
    @ZodBody(createInvitationSchema) body: CreateInvitationInput,
  ) {
    return this.invitations.create(ctx, body);
  }

  @Get('invitations')
  @RequirePermission('members.view')
  list(@TenantCtx() ctx: TenantContext) {
    return this.invitations.listPending(ctx.organizationId);
  }

  @Delete('invitations/:id')
  @HttpCode(204)
  @RequirePermission('members.invite')
  revoke(@TenantCtx() ctx: TenantContext, @Param('id', UuidPipe) id: string) {
    return this.invitations.revoke(ctx, id);
  }

  // --- Public, token-based --------------------------------------------------------------------

  @Get('public/invitations/:token')
  @Public()
  @RateLimit('publicToken')
  getPublic(@Param('token') token: string) {
    return this.invitations.getPublic(token);
  }

  @Post('public/invitations/:token/accept')
  @Public()
  @HttpCode(200)
  @RateLimit('publicToken')
  async accept(
    @Param('token') token: string,
    @ZodBody(acceptInvitationSchema) body: z.infer<typeof acceptInvitationSchema>,
    @Meta() meta: ClientMeta,
    @OptionalCtx() existing: AuthContext | null,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MeResponse> {
    const session = await this.invitations.acceptAsNewUser(token, body, meta);
    if (existing) await this.sessions.destroy(existing.session);
    this.sessions.writeCookie(res, session);
    return this.auth.buildMe(session.data.userId, session.data.activeOrganizationId);
  }

  /** For people who already have an account: sign in first, then accept. */
  @Post('invitations/accept/:token')
  @HttpCode(200)
  @RateLimit('publicToken')
  async acceptAsUser(@Ctx() ctx: AuthContext, @Param('token') token: string): Promise<MeResponse> {
    await this.invitations.acceptAsUser(ctx, token);
    return this.auth.buildMe(ctx.user.id, ctx.session.data.activeOrganizationId);
  }
}
