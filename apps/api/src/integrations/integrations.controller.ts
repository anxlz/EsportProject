import {
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  type GoogleConnectInput,
  googleConnectSchema,
  type IncomingWebhookCreateInput,
  incomingWebhookCreateSchema,
  type IntegrationUpdateInput,
  integrationUpdateSchema,
  type NotionConnectInput,
  notionConnectSchema,
  type ObsidianConnectInput,
  obsidianConnectSchema,
  obsidianFeedQuerySchema,
  type ObsidianPushInput,
  obsidianPushSchema,
  type OutgoingWebhookCreateInput,
  outgoingWebhookCreateSchema,
} from '@esports/shared';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import {
  OptionalCtx,
  Public,
  RequireOrg,
  type AuthContext,
  type TenantContext,
  TenantCtx,
} from '../authz/context.js';
import { Errors } from '../common/errors.js';
import { RateLimit } from '../common/rate-limit.js';
import { UuidPipe, ZodBody, ZodQuery } from '../common/zod.js';
import { type Env, ENV } from '../config/env.js';
import { ConnectionsService } from './connections.service.js';
import { IntegrationsService } from './integrations.service.js';
import { ObsidianService } from './obsidian.service.js';
import { WebhooksService } from './webhooks.service.js';

const GOOGLE_NONCE_COOKIE = 'esp_gcal_nonce';

@ApiTags('integrations')
@Controller('integrations')
export class IntegrationsController {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly connections: ConnectionsService,
    private readonly obsidian: ObsidianService,
    private readonly webhooks: WebhooksService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get()
  @RequireOrg()
  async list(@TenantCtx() ctx: TenantContext) {
    return {
      providers: this.integrations.providers(),
      connections: await this.integrations.list(ctx),
    };
  }

  // ---------- Google Calendar (OAuth through the browser) ----------

  @Get('google/start')
  @RequireOrg()
  @RateLimit('oauth')
  async googleStart(
    @TenantCtx() ctx: TenantContext,
    @ZodQuery(googleConnectSchema) q: GoogleConnectInput,
    @Res() res: Response,
  ) {
    const { url, nonce } = await this.integrations.googleStart(ctx, q);
    res.cookie(GOOGLE_NONCE_COOKIE, nonce, {
      httpOnly: true,
      secure: this.env.cookieSecure,
      sameSite: 'lax',
      path: '/',
      maxAge: 10 * 60 * 1000,
    });
    res.redirect(302, url);
  }

  @Get('google/callback')
  @Public()
  @RateLimit('oauth')
  async googleCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @OptionalCtx() ctx: AuthContext | null,
    @Req() req: Request & { cookies?: Record<string, string> },
    @Res() res: Response,
  ) {
    const path = await this.integrations.googleCallback(
      ctx?.organizationId && ctx.access ? (ctx as TenantContext) : null,
      { code, state, error, nonce: req.cookies?.[GOOGLE_NONCE_COOKIE] },
    );
    res.clearCookie(GOOGLE_NONCE_COOKIE, { path: '/' });
    res.redirect(302, `${this.env.WEB_APP_URL.replace(/\/$/, '')}${path}`);
  }

  // ---------- Organization connections ----------

  @Post('notion')
  @RequireOrg()
  notion(@TenantCtx() ctx: TenantContext, @ZodBody(notionConnectSchema) body: NotionConnectInput) {
    return this.integrations.notionConnect(ctx, body);
  }

  @Post('webhooks/outgoing')
  @RequireOrg()
  async outgoing(
    @TenantCtx() ctx: TenantContext,
    @ZodBody(outgoingWebhookCreateSchema) body: OutgoingWebhookCreateInput,
  ) {
    if (!ctx.access.has('integrations.manage')) throw Errors.forbidden();
    const { connection, secret } = await this.webhooks.createOutgoing(ctx, body);
    return { integration: await this.connections.toDto(connection), secret };
  }

  @Post('webhooks/incoming')
  @RequireOrg()
  async incoming(
    @TenantCtx() ctx: TenantContext,
    @ZodBody(incomingWebhookCreateSchema) body: IncomingWebhookCreateInput,
  ) {
    if (!ctx.access.has('integrations.manage')) throw Errors.forbidden();
    const { connection, secret } = await this.webhooks.createIncoming(ctx, body);
    return { integration: await this.connections.toDto(connection), secret };
  }

  // ---------- Obsidian ----------

  @Post('obsidian')
  @RequireOrg()
  async obsidianConnect(
    @TenantCtx() ctx: TenantContext,
    @ZodBody(obsidianConnectSchema) body: ObsidianConnectInput,
  ) {
    const { connection, token } = await this.obsidian.connect(ctx, body);
    return { integration: await this.connections.toDto(connection), secret: token };
  }

  /** The vault companion script: what to write into the vault (bearer token, not a session). */
  @Get('obsidian/feed')
  @Public()
  @RateLimit('integrationToken')
  async obsidianFeed(
    @Headers('authorization') auth: string | undefined,
    @ZodQuery(obsidianFeedQuerySchema) q: z.infer<typeof obsidianFeedQuerySchema>,
  ) {
    const c = await this.obsidian.authenticate(auth);
    return this.obsidian.feed(c, q.since);
  }

  @Post('obsidian/push')
  @Public()
  @HttpCode(200)
  @RateLimit('integrationToken')
  async obsidianPush(
    @Headers('authorization') auth: string | undefined,
    @ZodBody(obsidianPushSchema) body: ObsidianPushInput,
  ) {
    const c = await this.obsidian.authenticate(auth);
    return this.obsidian.push(c, body);
  }

  /** One meeting as an Obsidian note (download). */
  @Get('obsidian/notes/:meetingId')
  @RequireOrg()
  async obsidianNote(
    @TenantCtx() ctx: TenantContext,
    @Param('meetingId', UuidPipe) id: string,
    @Res() res: Response,
  ) {
    const note = await this.obsidian.note(ctx, id);
    const name = note.path.split('/').pop()!;
    res.setHeader('content-type', 'text/markdown; charset=utf-8');
    res.setHeader(
      'content-disposition',
      `attachment; filename="meeting.md"; filename*=UTF-8''${encodeURIComponent(name)}`,
    );
    res.send(note.content);
  }

  // ---------- Any connection ----------

  @Get(':id')
  @RequireOrg()
  get(@TenantCtx() ctx: TenantContext, @Param('id', UuidPipe) id: string) {
    return this.integrations.get(ctx, id);
  }

  @Get(':id/events')
  @RequireOrg()
  events(@TenantCtx() ctx: TenantContext, @Param('id', UuidPipe) id: string) {
    return this.integrations.events(ctx, id);
  }

  @Patch(':id')
  @RequireOrg()
  update(
    @TenantCtx() ctx: TenantContext,
    @Param('id', UuidPipe) id: string,
    @ZodBody(integrationUpdateSchema) body: IntegrationUpdateInput,
  ) {
    return this.integrations.update(ctx, id, body);
  }

  @Post(':id/sync')
  @HttpCode(200)
  @RequireOrg()
  sync(@TenantCtx() ctx: TenantContext, @Param('id', UuidPipe) id: string) {
    return this.integrations.syncNow(ctx, id);
  }

  @Post(':id/rotate-secret')
  @HttpCode(200)
  @RequireOrg()
  rotate(@TenantCtx() ctx: TenantContext, @Param('id', UuidPipe) id: string) {
    return this.integrations.rotateSecret(ctx, id);
  }

  @Post(':id/reset-verification')
  @HttpCode(200)
  @RequireOrg()
  resetVerification(@TenantCtx() ctx: TenantContext, @Param('id', UuidPipe) id: string) {
    return this.integrations.resetVerification(ctx, id);
  }

  @Post(':id/disconnect')
  @HttpCode(204)
  @RequireOrg()
  async disconnect(@TenantCtx() ctx: TenantContext, @Param('id', UuidPipe) id: string) {
    await this.integrations.disconnect(ctx, id);
  }
}

/**
 * What outside services call. No session; every endpoint authenticates the request itself
 * (Google channel token, Notion signature, Standard Webhooks signature) and refuses anything
 * unauthenticated with 401.
 */
@ApiTags('integrations')
@Controller('integrations/hooks')
export class IntegrationHooksController {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly webhooks: WebhooksService,
  ) {}

  @Post('google/:id')
  @Public()
  @HttpCode(200)
  @RateLimit('integrationHook')
  google(@Param('id') id: string, @Req() req: Request) {
    return this.integrations.googleHook(id, req.headers);
  }

  @Post('notion/:id')
  @Public()
  @HttpCode(200)
  @RateLimit('integrationHook')
  notion(@Param('id') id: string, @Req() req: Request) {
    return this.integrations.notionHook(id, req.headers, rawBody(req));
  }

  @Post('in/:id')
  @Public()
  @HttpCode(200)
  @RateLimit('integrationHook')
  incoming(@Param('id') id: string, @Req() req: Request) {
    return this.webhooks.handleIncoming(id, req.headers, rawBody(req));
  }
}

/** The exact bytes received (signatures are over the raw body; see bootstrap.ts). */
function rawBody(req: Request): Buffer | undefined {
  return Buffer.isBuffer(req.body) ? req.body : undefined;
}
