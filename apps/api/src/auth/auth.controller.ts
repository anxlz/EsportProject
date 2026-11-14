import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  type AuthConfigDto,
  changePasswordSchema,
  forgotPasswordSchema,
  type LoginInput,
  loginSchema,
  type MeResponse,
  type RegisterOrganizationInput,
  registerOrganizationSchema,
  resetPasswordSchema,
  switchOrganizationSchema,
  updateProfileSchema,
} from '@esports/shared';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import {
  type AuthContext,
  type ClientMeta,
  Ctx,
  Meta,
  OptionalCtx,
  Public,
} from '../authz/context.js';
import { RateLimit } from '../common/rate-limit.js';
import { ZodBody } from '../common/zod.js';
import { type Env, ENV } from '../config/env.js';
import { AuthService } from './auth.service.js';
import { SessionService } from './session.service.js';

const OAUTH_NONCE_COOKIE = 'esp_oauth_nonce';

@ApiTags('auth')
@Controller()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('auth/config')
  @Public()
  config(): AuthConfigDto {
    return { discordEnabled: this.env.discordEnabled, signupEnabled: this.env.ORG_SIGNUP_ENABLED };
  }

  @Post('auth/register')
  @Public()
  @RateLimit('register')
  async register(
    @ZodBody(registerOrganizationSchema) body: RegisterOrganizationInput,
    @Meta() meta: ClientMeta,
    @OptionalCtx() existing: AuthContext | null,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MeResponse> {
    const session = await this.auth.registerOrganization(body, meta);
    if (existing) await this.sessions.destroy(existing.session);
    this.sessions.writeCookie(res, session);
    return this.auth.buildMe(session.data.userId, session.data.activeOrganizationId);
  }

  @Post('auth/login')
  @Public()
  @HttpCode(200)
  @RateLimit('login')
  async login(
    @ZodBody(loginSchema) body: LoginInput,
    @Meta() meta: ClientMeta,
    @OptionalCtx() existing: AuthContext | null,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MeResponse> {
    const session = await this.auth.login(body, meta);
    // Never reuse a pre-login session (session fixation).
    if (existing) await this.sessions.destroy(existing.session);
    this.sessions.writeCookie(res, session);
    return this.auth.buildMe(session.data.userId, session.data.activeOrganizationId);
  }

  @Post('auth/logout')
  @HttpCode(204)
  async logout(@Ctx() ctx: AuthContext, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(ctx);
    this.sessions.clearCookie(res);
  }

  @Get('auth/me')
  me(@Ctx() ctx: AuthContext): Promise<MeResponse> {
    return this.auth.buildMe(ctx.user.id, ctx.organizationId);
  }

  @Post('auth/switch-organization')
  @HttpCode(200)
  async switchOrganization(
    @Ctx() ctx: AuthContext,
    @ZodBody(switchOrganizationSchema) body: z.infer<typeof switchOrganizationSchema>,
  ): Promise<MeResponse> {
    await this.auth.switchOrganization(ctx, body.organizationId);
    return this.auth.buildMe(ctx.user.id, body.organizationId);
  }

  @Post('auth/password/forgot')
  @Public()
  @HttpCode(204)
  @RateLimit('forgotPassword')
  async forgot(
    @ZodBody(forgotPasswordSchema) body: z.infer<typeof forgotPasswordSchema>,
    @Meta() meta: ClientMeta,
  ): Promise<void> {
    await this.auth.forgotPassword(body.email, meta);
  }

  @Post('auth/password/reset')
  @Public()
  @HttpCode(204)
  @RateLimit('resetPassword')
  async reset(
    @ZodBody(resetPasswordSchema) body: z.infer<typeof resetPasswordSchema>,
    @Meta() meta: ClientMeta,
  ): Promise<void> {
    await this.auth.resetPassword(body.token, body.password, meta);
  }

  // --- Discord ----------------------------------------------------------------------------------

  @Get('auth/discord/start')
  @Public()
  @RateLimit('oauth')
  async discordStart(
    @Query('mode') mode: string | undefined,
    @OptionalCtx() ctx: AuthContext | null,
    @Res() res: Response,
  ): Promise<void> {
    const { url, nonce } = await this.auth.discordStart(mode === 'link' ? 'link' : 'login', ctx);
    res.cookie(OAUTH_NONCE_COOKIE, nonce, {
      httpOnly: true,
      secure: this.env.cookieSecure,
      sameSite: 'lax',
      path: '/',
      maxAge: 10 * 60 * 1000,
    });
    res.redirect(302, url);
  }

  @Get('auth/discord/callback')
  @Public()
  @RateLimit('oauth')
  async discordCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Req() req: Request & { cookies?: Record<string, string> },
    @Meta() meta: ClientMeta,
    @OptionalCtx() existing: AuthContext | null,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.auth.discordCallback(
      { code, state, nonce: req.cookies?.[OAUTH_NONCE_COOKIE] },
      meta,
    );
    res.clearCookie(OAUTH_NONCE_COOKIE, { path: '/' });
    if (result.session) {
      if (existing) await this.sessions.destroy(existing.session);
      this.sessions.writeCookie(res, result.session);
    }
    res.redirect(302, `${this.env.WEB_APP_URL}${result.redirect}`);
  }

  // --- Me ---------------------------------------------------------------------------------------

  @Patch('me')
  async updateProfile(
    @Ctx() ctx: AuthContext,
    @ZodBody(updateProfileSchema) body: z.infer<typeof updateProfileSchema>,
  ): Promise<MeResponse> {
    await this.auth.updateProfile(ctx, body);
    return this.auth.buildMe(ctx.user.id, ctx.organizationId);
  }

  @Post('me/password')
  @HttpCode(204)
  @RateLimit('changePassword')
  async changePassword(
    @Ctx() ctx: AuthContext,
    @ZodBody(changePasswordSchema) body: z.infer<typeof changePasswordSchema>,
  ): Promise<void> {
    await this.auth.changePassword(ctx, body.currentPassword, body.newPassword);
  }

  @Post('me/sessions/revoke-others')
  @HttpCode(200)
  async revokeOthers(@Ctx() ctx: AuthContext): Promise<{ revoked: number }> {
    return { revoked: await this.auth.revokeOtherSessions(ctx) };
  }

  @Delete('me/discord')
  @HttpCode(204)
  unlinkDiscord(@Ctx() ctx: AuthContext): Promise<void> {
    return this.auth.unlinkDiscord(ctx);
  }
}
