/**
 * Setting up and managing integrations, and verifying what providers send us.
 *
 * Who manages what: personal connections (Google Calendar, Obsidian) only by their owner;
 * organization connections (Notion, webhooks) by holders of `integrations.manage`. Anything
 * else answers 404, like other out-of-scope records.
 */
import { Inject, Injectable } from '@nestjs/common';
import type {
  GoogleConnectInput,
  IntegrationDto,
  IntegrationEventCode,
  IntegrationEventDto,
  IntegrationEventLevel,
  IntegrationProvidersDto,
  IntegrationUpdateInput,
  NotionConnectInput,
} from '@esports/shared';
import { and, desc, eq, ne, or } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { TenantContext } from '../authz/context';
import { AuditService } from '../audit/audit.service';
import { randomToken, safeEqual, sha256 } from '../common/crypto';
import { AppError, Errors } from '../common/errors';
import { NOW, type Now } from '../common/now';
import { RateLimitService } from '../common/rate-limit';
import { type Env, ENV } from '../config/env';
import { REDIS } from '../core/core.module';
import { DB, type Database } from '../db/client';
import { teams } from '../db/schema';
import { integrationConnections, integrationEvents, integrationLinks } from '../db/schema-meetings';
import { type ConnectionRow, ConnectionsService } from './connections.service';
import { IntegrationError } from './errors';
import { JobsService } from './jobs.service';
import { ObsidianService } from './obsidian.service';
import { GoogleCalendarProvider } from './providers/google-calendar';
import { NotionProvider } from './providers/notion';
import { WebhooksService } from './webhooks.service';

const OAUTH_TTL_SECONDS = 600;

interface GoogleOAuthState {
  userId: string;
  organizationId: string;
  nonceHash: string;
  input: GoogleConnectInput;
}

@Injectable()
export class IntegrationsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(NOW) private readonly now: Now,
    @Inject(ENV) private readonly env: Env,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly connections: ConnectionsService,
    private readonly jobs: JobsService,
    private readonly google: GoogleCalendarProvider,
    private readonly notion: NotionProvider,
    private readonly obsidian: ObsidianService,
    private readonly webhooks: WebhooksService,
    private readonly audit: AuditService,
    private readonly limiter: RateLimitService,
  ) {}

  providers(): IntegrationProvidersDto {
    return {
      google: { configured: this.env.googleEnabled },
      notion: { configured: true },
      obsidian: { configured: true },
      webhooks: { configured: true },
      publicBaseUrl: this.env.publicApiUrl,
    };
  }

  async list(ctx: TenantContext): Promise<IntegrationDto[]> {
    const manage = ctx.access.has('integrations.manage');
    const rows = await this.db
      .select()
      .from(integrationConnections)
      .where(
        and(
          eq(integrationConnections.organizationId, ctx.organizationId),
          ne(integrationConnections.status, 'disconnected'),
          or(
            and(
              eq(integrationConnections.personal, true),
              eq(integrationConnections.ownerUserId, ctx.user.id),
            ),
            manage ? eq(integrationConnections.personal, false) : undefined,
          ),
        ),
      )
      .orderBy(desc(integrationConnections.createdAt));
    return Promise.all(rows.map((r) => this.connections.toDto(r)));
  }

  /** A connection `ctx` may manage, or 404. */
  async manageable(ctx: TenantContext, id: string): Promise<ConnectionRow> {
    const c = await this.connections.byId(id);
    const ok =
      c &&
      c.organizationId === ctx.organizationId &&
      c.status !== 'disconnected' &&
      (c.personal ? c.ownerUserId === ctx.user.id : ctx.access.has('integrations.manage'));
    if (!ok) throw Errors.notFound('Integration');
    return c;
  }

  async get(ctx: TenantContext, id: string) {
    return this.connections.toDto(await this.manageable(ctx, id));
  }

  async events(ctx: TenantContext, id: string): Promise<IntegrationEventDto[]> {
    const c = await this.manageable(ctx, id);
    const rows = await this.db
      .select()
      .from(integrationEvents)
      .where(eq(integrationEvents.connectionId, c.id))
      .orderBy(desc(integrationEvents.createdAt))
      .limit(100);
    return rows.map((e) => ({
      id: e.id,
      level: e.level as IntegrationEventLevel,
      code: e.code as IntegrationEventCode,
      message: e.message,
      meetingId: e.meetingId,
      detail: e.detail,
      createdAt: e.createdAt.toISOString(),
    }));
  }

  private async checkTeam(ctx: TenantContext, teamId: string | null | undefined) {
    if (!teamId) return;
    const [t] = await this.db
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.id, teamId), eq(teams.organizationId, ctx.organizationId)));
    if (!t) throw Errors.badRequest('invalid_scope', 'Unknown team');
  }

  private requireManage(ctx: TenantContext) {
    if (!ctx.access.has('integrations.manage')) throw Errors.forbidden();
  }

  private fullSync(c: ConnectionRow) {
    return this.jobs.enqueue({
      organizationId: c.organizationId,
      connectionId: c.id,
      kind: 'full_sync',
      dedupeKey: 'full_sync',
    });
  }

  async update(
    ctx: TenantContext,
    id: string,
    input: IntegrationUpdateInput,
  ): Promise<IntegrationDto> {
    const c = await this.manageable(ctx, id);
    const set: Partial<typeof integrationConnections.$inferInsert> = {};
    const changed: string[] = [];
    const remote = c.provider === 'google_calendar' || c.provider === 'notion';
    if (input.name !== undefined && input.name !== c.name) {
      set.name = input.name;
      changed.push('name');
    }
    if (input.direction !== undefined && input.direction !== c.direction) {
      if (!['google_calendar', 'notion', 'obsidian'].includes(c.provider))
        throw Errors.validation([{ path: 'direction', message: 'not_applicable', code: 'custom' }]);
      set.direction = input.direction;
      changed.push('direction');
    }
    if (input.teamId !== undefined && input.teamId !== c.teamId) {
      await this.checkTeam(ctx, input.teamId);
      set.teamId = input.teamId;
      changed.push('team');
    }
    const cfg = { ...(c.config as Record<string, unknown>) };
    if (input.calendarId !== undefined && input.calendarId !== cfg.calendarId)
      throw Errors.validation([
        { path: 'calendarId', message: 'reconnect_to_change_calendar', code: 'custom' },
      ]);
    if (input.events !== undefined) {
      if (c.provider !== 'webhook_outgoing')
        throw Errors.validation([{ path: 'events', message: 'not_applicable', code: 'custom' }]);
      cfg.events = input.events;
      changed.push('events');
    }
    if (input.actions !== undefined) {
      if (c.provider !== 'webhook_incoming')
        throw Errors.validation([{ path: 'actions', message: 'not_applicable', code: 'custom' }]);
      cfg.actions = input.actions;
      changed.push('actions');
    }
    if (input.paused !== undefined && input.paused !== c.paused) {
      set.paused = input.paused;
      changed.push(input.paused ? 'paused' : 'resumed');
    }
    if (!changed.length) return this.connections.toDto(c);
    set.config = cfg;
    set.updatedAt = new Date(this.now());
    // An error state is cleared by changing settings (e.g. after the problem was fixed).
    if (c.status === 'error' && !input.paused) set.status = 'active';
    await this.db.transaction(async (tx) => {
      await tx.update(integrationConnections).set(set).where(eq(integrationConnections.id, c.id));
      if (changed.includes('direction') && input.direction === 'two_way' && remote) {
        // Changes made at the provider while push-only were never read; starting two-way from
        // the platform's version means they don't come back as surprises.
        await tx
          .update(integrationLinks)
          .set({ syncedSnapshot: null })
          .where(eq(integrationLinks.connectionId, c.id));
        await tx
          .update(integrationConnections)
          .set({ cursor: {} })
          .where(eq(integrationConnections.id, c.id));
      }
      await this.audit.fromCtx(
        ctx,
        'integration.updated',
        { type: 'integration', id: c.id },
        { provider: c.provider, changed },
        tx,
      );
    });
    const next = (await this.connections.byId(c.id))!;
    await this.connections.log(
      next,
      'info',
      'settings_changed',
      `Settings changed: ${changed.join(', ')}.`,
    );
    if (input.paused) await this.jobs.cancelPending(c.id);
    else if (
      remote &&
      (changed.includes('team') ||
        changed.includes('direction') ||
        changed.includes('resumed') ||
        set.status === 'active')
    )
      await this.fullSync(next);
    return this.connections.toDto(next);
  }

  async syncNow(ctx: TenantContext, id: string) {
    const c = await this.manageable(ctx, id);
    if (c.provider !== 'google_calendar' && c.provider !== 'notion')
      throw Errors.validation([{ path: 'id', message: 'not_applicable', code: 'custom' }]);
    if (c.status !== 'active' || c.paused)
      throw new AppError(
        'integration_unavailable',
        409,
        'Resume or reconnect the integration first',
      );
    await this.fullSync(c);
    return this.connections.toDto(c);
  }

  async disconnect(ctx: TenantContext, id: string) {
    const c = await this.manageable(ctx, id);
    if (c.provider === 'google_calendar') {
      const ch = c.channel as { id?: string; resourceId?: string } | null;
      if (ch?.id && ch.resourceId)
        await this.google.stopChannel(c, ch.id, ch.resourceId).catch(() => undefined);
      await this.google.revoke(c).catch(() => undefined);
    }
    await this.db.transaction(async (tx) => {
      await tx
        .update(integrationConnections)
        .set({
          status: 'disconnected',
          secrets: null,
          tokenHash: null,
          channel: null,
          disconnectedAt: new Date(this.now()),
          updatedAt: new Date(this.now()),
        })
        .where(eq(integrationConnections.id, c.id));
      await tx
        .update(integrationLinks)
        .set({ state: 'unlinked' })
        .where(eq(integrationLinks.connectionId, c.id));
      await this.audit.fromCtx(
        ctx,
        'integration.disconnected',
        { type: 'integration', id: c.id },
        { provider: c.provider },
        tx,
      );
    });
    await this.jobs.cancelPending(c.id);
    await this.connections.log(
      c,
      'info',
      'disconnected',
      'Disconnected. Records already created at the provider were left as they are.',
    );
  }

  async rotateSecret(ctx: TenantContext, id: string) {
    const c = await this.manageable(ctx, id);
    let secret: string;
    if (c.provider === 'obsidian') secret = await this.obsidian.rotate(c);
    else if (c.provider === 'webhook_outgoing' || c.provider === 'webhook_incoming')
      secret = await this.webhooks.rotate(c);
    else throw Errors.validation([{ path: 'id', message: 'not_applicable', code: 'custom' }]);
    await this.audit.fromCtx(
      ctx,
      'integration.secret_rotated',
      { type: 'integration', id: c.id },
      { provider: c.provider },
    );
    return {
      integration: await this.connections.toDto((await this.connections.byId(c.id))!),
      secret,
    };
  }

  async resetVerification(ctx: TenantContext, id: string) {
    const c = await this.manageable(ctx, id);
    if (c.provider !== 'notion')
      throw Errors.validation([{ path: 'id', message: 'not_applicable', code: 'custom' }]);
    const s = this.connections.secrets<Record<string, unknown>>(c);
    delete s.verificationToken;
    await this.connections.setSecrets(c, s);
    await this.audit.fromCtx(
      ctx,
      'integration.updated',
      { type: 'integration', id: c.id },
      { provider: c.provider, changed: ['verification_reset'] },
    );
    return this.connections.toDto((await this.connections.byId(c.id))!);
  }

  // ---------------------------------------------------------------- Google Calendar (OAuth)

  async googleStart(
    ctx: TenantContext,
    input: GoogleConnectInput,
  ): Promise<{ url: string; nonce: string }> {
    if (!this.env.googleEnabled)
      throw new AppError('integration_not_configured', 503, 'Google Calendar is not configured');
    await this.checkTeam(ctx, input.teamId);
    const existing = await this.db
      .select({ id: integrationConnections.id })
      .from(integrationConnections)
      .where(
        and(
          eq(integrationConnections.organizationId, ctx.organizationId),
          eq(integrationConnections.ownerUserId, ctx.user.id),
          eq(integrationConnections.provider, 'google_calendar'),
          ne(integrationConnections.status, 'disconnected'),
        ),
      );
    if (existing.length) throw Errors.conflict('conflict', 'Google Calendar is already connected');
    const state = randomToken(24);
    const nonce = randomToken(24);
    const value: GoogleOAuthState = {
      userId: ctx.user.id,
      organizationId: ctx.organizationId,
      nonceHash: sha256(nonce),
      input,
    };
    await this.redis.set(`oauth:google:${state}`, JSON.stringify(value), 'EX', OAUTH_TTL_SECONDS);
    return { url: this.google.authUrl(state), nonce };
  }

  /** Returns the dashboard path to go back to (with ?connected= or ?error=). */
  async googleCallback(
    ctx: TenantContext | null,
    p: { code?: string; state?: string; nonce?: string; error?: string },
  ): Promise<string> {
    const back = (q: string) => `/dashboard/integrations?${q}`;
    if (!p.state || p.state.length > 100) return back('error=oauth_state_invalid');
    // The state is consumed on any attempt (single use) and bound to the starting browser.
    const raw = await this.redis.getdel(`oauth:google:${p.state}`);
    if (!raw) return back('error=oauth_state_invalid');
    const state = JSON.parse(raw) as GoogleOAuthState;
    if (!p.nonce || !safeEqual(state.nonceHash, sha256(p.nonce)))
      return back('error=oauth_state_invalid');
    if (!ctx || ctx.user.id !== state.userId || ctx.organizationId !== state.organizationId)
      return back('error=oauth_state_invalid');
    if (p.error || !p.code) return back('error=google_denied');
    let secrets;
    try {
      secrets = await this.google.exchangeCode(p.code);
    } catch {
      return back('error=integration_unavailable');
    }
    const c = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(integrationConnections)
        .values({
          organizationId: ctx.organizationId,
          provider: 'google_calendar',
          name: 'Google Calendar',
          ownerUserId: ctx.user.id,
          personal: true,
          direction: state.input.direction,
          teamId: state.input.teamId ?? null,
          config: { calendarId: state.input.calendarId },
        })
        .returning();
      await this.connections.setSecrets(row!, secrets, tx);
      await this.audit.fromCtx(
        ctx,
        'integration.connected',
        { type: 'integration', id: row!.id },
        {
          provider: 'google_calendar',
          direction: state.input.direction,
          calendar: state.input.calendarId === 'primary' ? 'primary' : 'dedicated',
        },
        tx,
      );
      return row!;
    });
    await this.connections.log(
      c,
      'info',
      'connected',
      `Connected (${state.input.direction === 'two_way' ? 'two-way' : 'push only'}).`,
    );
    await this.jobs.enqueue({
      organizationId: c.organizationId,
      connectionId: c.id,
      kind: 'renew_channel',
      dedupeKey: 'renew',
    });
    await this.fullSync(c);
    return back('connected=google_calendar');
  }

  // ---------------------------------------------------------------- Notion

  async notionConnect(ctx: TenantContext, input: NotionConnectInput): Promise<IntegrationDto> {
    this.requireManage(ctx);
    await this.checkTeam(ctx, input.teamId);
    let db;
    try {
      db = await this.notion.resolveDatabase(input.token, input.database);
    } catch (e) {
      if (e instanceof IntegrationError)
        throw new AppError(
          e.kind === 'auth' ? 'integration_unavailable' : 'integration_unavailable',
          400,
          e.message,
          { reason: e.code },
        );
      throw e;
    }
    const c = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(integrationConnections)
        .values({
          organizationId: ctx.organizationId,
          provider: 'notion',
          name: input.name,
          ownerUserId: ctx.user.id,
          personal: false,
          direction: input.direction,
          teamId: input.teamId ?? null,
          config: {
            databaseId: db.databaseId,
            dataSourceId: db.dataSourceId,
            titleProperty: db.titleProperty,
            databaseTitle: db.databaseTitle,
            timeZone: input.timeZone,
          },
        })
        .returning();
      await this.connections.setSecrets(row!, { token: input.token }, tx);
      await this.audit.fromCtx(
        ctx,
        'integration.connected',
        { type: 'integration', id: row!.id },
        { provider: 'notion', direction: input.direction },
        tx,
      );
      return row!;
    });
    await this.connections.log(
      c,
      'info',
      'connected',
      `Connected to "${db.databaseTitle ?? 'Notion database'}".`,
    );
    await this.fullSync(c);
    return this.connections.toDto((await this.connections.byId(c.id))!);
  }

  // ---------------------------------------------------------------- verifying provider calls

  private unauthorized(): never {
    throw new AppError('invalid_signature', 401, 'Missing or invalid authentication');
  }

  /** Google push notification: channel id, its secret token and the resource must all match. */
  async googleHook(id: string, headers: Record<string, string | string[] | undefined>) {
    const h = (k: string) => {
      const v = headers[k];
      return Array.isArray(v) ? v[0] : v;
    };
    const channelId = h('x-goog-channel-id');
    const token = h('x-goog-channel-token');
    const resourceId = h('x-goog-resource-id');
    const state = h('x-goog-resource-state');
    if (!/^[0-9a-f-]{36}$/i.test(id) || !channelId || !token || !resourceId) this.unauthorized();
    const c = await this.connections.byId(id);
    if (!c || c.provider !== 'google_calendar' || c.status !== 'active') this.unauthorized();
    const ch = c.channel as {
      id?: string;
      resourceId?: string;
      tokenHash?: string;
      previous?: { id?: string; resourceId?: string; tokenHash?: string } | null;
    } | null;
    const candidates = [ch, ch?.previous].filter(Boolean) as {
      id?: string;
      resourceId?: string;
      tokenHash?: string;
    }[];
    const match = candidates.find(
      (x) =>
        x.id === channelId &&
        x.resourceId === resourceId &&
        !!x.tokenHash &&
        safeEqual(x.tokenHash, sha256(token)),
    );
    if (!match) {
      if ((await this.limiter.consume(`hooklog:${c.id}`, 1, 60)) === null)
        await this.connections.log(
          c,
          'warn',
          'signature_rejected',
          'Refused a push notification with a wrong channel or token.',
        );
      this.unauthorized();
    }
    if (state === 'sync') return { ok: true };
    if (!c.paused && c.direction === 'two_way')
      await this.jobs.enqueue({
        organizationId: c.organizationId,
        connectionId: c.id,
        kind: 'pull',
        dedupeKey: 'pull',
      });
    return { ok: true };
  }

  /**
   * Notion webhook. The one-time verification request carries a token (that's Notion's
   * protocol: it can't be signed yet); it's stored only if none is stored, and the admin pastes
   * it into Notion to confirm. Every event after that must be signed with it:
   * X-Notion-Signature = "sha256=" + HMAC-SHA256(token, raw body). Events are only signals —
   * the pull reads the actual pages from Notion's API with our own credentials.
   */
  async notionHook(
    id: string,
    headers: Record<string, string | string[] | undefined>,
    raw: Buffer | undefined,
  ) {
    const sig = headers['x-notion-signature'];
    const signature = Array.isArray(sig) ? sig[0] : sig;
    if (!/^[0-9a-f-]{36}$/i.test(id) || !raw?.length) this.unauthorized();
    const c = await this.connections.byId(id);
    if (!c || c.provider !== 'notion' || c.status !== 'active') this.unauthorized();
    let body: {
      verification_token?: unknown;
      type?: unknown;
      entity?: { id?: unknown };
      data?: { parent?: { data_source_id?: unknown } };
    };
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      this.unauthorized();
    }
    const secrets = this.connections.secrets<{ token?: string; verificationToken?: string }>(c);
    if (!signature && typeof body.verification_token === 'string') {
      if (secrets.verificationToken || body.verification_token.length > 200) this.unauthorized();
      await this.connections.setSecrets(c, {
        ...secrets,
        verificationToken: body.verification_token,
      });
      await this.connections.log(
        c,
        'info',
        'verification_received',
        "Received Notion's verification token; paste it into the webhook settings in Notion to finish.",
      );
      return { ok: true };
    }
    if (!secrets.verificationToken || !signature) this.unauthorized();
    const expected = `sha256=${createHmac('sha256', secrets.verificationToken).update(raw).digest('hex')}`;
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      if ((await this.limiter.consume(`hooklog:${c.id}`, 1, 60)) === null)
        await this.connections.log(
          c,
          'warn',
          'signature_rejected',
          'Refused a Notion event with a missing or wrong signature.',
        );
      this.unauthorized();
    }
    const type = typeof body.type === 'string' ? body.type : '';
    const pageId = typeof body.entity?.id === 'string' ? body.entity.id : null;
    const ds = body.data?.parent?.data_source_id;
    const ours = !ds || ds === (c.config as { dataSourceId?: string }).dataSourceId;
    if (!c.paused && c.direction === 'two_way' && ours && type.startsWith('page.')) {
      if ((type === 'page.deleted' || type === 'page.undeleted') && pageId)
        await this.jobs.enqueue({
          organizationId: c.organizationId,
          connectionId: c.id,
          kind: 'pull',
          payload: { pageIds: [pageId] },
          dedupeKey: `page:${pageId}`,
        });
      else
        await this.jobs.enqueue({
          organizationId: c.organizationId,
          connectionId: c.id,
          kind: 'pull',
          dedupeKey: 'pull',
        });
    }
    return { ok: true };
  }
}
