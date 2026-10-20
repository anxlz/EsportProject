/**
 * Integration connections: who owns them, what they carry, their secrets, their log, and how
 * failures are recorded and reported.
 *
 * - An integration always acts as its owner, with the owner's CURRENT permissions (resolved on
 *   every run): if their access changes, so does what the integration may see or change.
 * - Failures go to the append-only integration log; the owner is notified once per failure
 *   streak (not on every retry), and again after the streak ends and a new one starts.
 */
import { Inject, Injectable } from '@nestjs/common';
import type {
  IntegrationDto,
  IntegrationEventCode,
  IntegrationEventLevel,
  IntegrationProvider,
  SyncDirection,
} from '@esports/shared';
import { and, count, eq, sql } from 'drizzle-orm';
import { AccessService } from '../authz/access.service';
import type { TenantContext } from '../authz/context';
import { NOW, type Now } from '../common/now';
import { type Env, ENV } from '../config/env';
import { DB, type Database, type DbOrTx } from '../db/client';
import { teams, users } from '../db/schema';
import { integrationConnections, integrationEvents, integrationLinks } from '../db/schema-meetings';
import { canView } from '../meetings/meeting-access';
import type { LoadedMeeting, MeetingsService } from '../meetings/meetings.service';
import { NotificationService } from '../notifications/notification.service';
import { JobsService } from './jobs.service';
import { SECRET_BOX, type SecretBox } from './secret-box';

export type ConnectionRow = typeof integrationConnections.$inferSelect;

@Injectable()
export class ConnectionsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(NOW) private readonly now: Now,
    @Inject(ENV) private readonly env: Env,
    @Inject(SECRET_BOX) private readonly box: SecretBox,
    private readonly access: AccessService,
    private readonly notifications: NotificationService,
    private readonly jobs: JobsService,
  ) {}

  async byId(id: string, tx: DbOrTx = this.db): Promise<ConnectionRow | null> {
    const [c] = await tx
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, id));
    return c ?? null;
  }

  async activeInOrg(organizationId: string): Promise<ConnectionRow[]> {
    return this.db
      .select()
      .from(integrationConnections)
      .where(
        and(
          eq(integrationConnections.organizationId, organizationId),
          eq(integrationConnections.status, 'active'),
          eq(integrationConnections.paused, false),
        ),
      );
  }

  // ---------------------------------------------------------------- acting as the owner

  /** The owner's request context with their current permissions, or null if they lost access. */
  async ownerCtx(c: ConnectionRow): Promise<TenantContext | null> {
    const resolved = await this.access.resolve(c.organizationId, c.ownerUserId);
    if (resolved.status !== 'active' || !resolved.access) return null;
    const [u] = await this.db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        locale: users.locale,
      })
      .from(users)
      .where(eq(users.id, c.ownerUserId));
    if (!u) return null;
    return {
      // Integrations run outside any browser session; nothing reads the session from services.
      session: null as never,
      user: u,
      organizationId: c.organizationId,
      access: resolved.access,
      ip: null,
      userAgent: `integration:${c.provider}`,
    };
  }

  /**
   * Whether this connection should mirror the meeting. Personal calendars and vaults carry the
   * meetings their owner is invited to; organization connections (Notion, outgoing webhooks)
   * carry what the owner may see. A team filter narrows either.
   */
  carries(
    c: ConnectionRow,
    l: LoadedMeeting,
    owner: TenantContext,
    meetings: MeetingsService,
  ): boolean {
    if (c.teamId && l.row.teamId !== c.teamId) return false;
    const invited = meetings.isParticipant(l, owner.user.id);
    if (c.personal) return invited;
    return canView(owner.access, meetings.scopeOf(l), invited);
  }

  // ---------------------------------------------------------------- secrets

  aad(c: Pick<ConnectionRow, 'organizationId' | 'id'>) {
    return `${c.organizationId}:${c.id}`;
  }

  secrets<T extends Record<string, unknown>>(c: ConnectionRow): T {
    if (!c.secrets) return {} as T;
    return this.box.open<T>(c.secrets, this.aad(c));
  }

  async setSecrets(
    c: Pick<ConnectionRow, 'organizationId' | 'id'>,
    value: Record<string, unknown> | null,
    tx: DbOrTx = this.db,
  ) {
    await tx
      .update(integrationConnections)
      .set({
        secrets: value ? this.box.seal(value, this.aad(c)) : null,
        updatedAt: new Date(this.now()),
      })
      .where(eq(integrationConnections.id, c.id));
  }

  seal(c: Pick<ConnectionRow, 'organizationId' | 'id'>, value: Record<string, unknown>) {
    return this.box.seal(value, this.aad(c));
  }

  // ---------------------------------------------------------------- log, failures, success

  async log(
    c: Pick<ConnectionRow, 'organizationId' | 'id'>,
    level: IntegrationEventLevel,
    code: IntegrationEventCode,
    message: string,
    extra: { meetingId?: string | null; detail?: Record<string, unknown> } = {},
    tx: DbOrTx = this.db,
  ) {
    await tx.insert(integrationEvents).values({
      organizationId: c.organizationId,
      connectionId: c.id,
      level,
      code,
      message: message.slice(0, 1000),
      meetingId: extra.meetingId ?? null,
      detail: extra.detail ?? {},
    });
  }

  async recordSuccess(c: ConnectionRow, synced = true) {
    await this.db
      .update(integrationConnections)
      .set({
        consecutiveFailures: 0,
        failureNotifiedAt: null,
        ...(synced ? { lastSyncAt: new Date(this.now()) } : {}),
        updatedAt: new Date(this.now()),
      })
      .where(eq(integrationConnections.id, c.id));
  }

  /**
   * A job failed for good (or credentials were rejected). Logged, kept on the connection, and
   * the owner is told — once per streak of failures.
   */
  async recordFailure(
    c: ConnectionRow,
    code: string,
    message: string,
    opts: { markError?: boolean; meetingId?: string | null; eventCode?: IntegrationEventCode } = {},
  ) {
    const at = new Date(this.now());
    await this.db
      .update(integrationConnections)
      .set({
        lastErrorCode: code,
        lastErrorMessage: message.slice(0, 500),
        lastErrorAt: at,
        consecutiveFailures: sql`${integrationConnections.consecutiveFailures} + 1`,
        ...(opts.markError ? { status: 'error' } : {}),
        updatedAt: at,
      })
      .where(eq(integrationConnections.id, c.id));
    await this.log(c, 'error', opts.eventCode ?? 'failed', message, {
      meetingId: opts.meetingId ?? null,
      detail: { code },
    });
    const [claimed] = await this.db
      .update(integrationConnections)
      .set({ failureNotifiedAt: at })
      .where(
        and(
          eq(integrationConnections.id, c.id),
          sql`${integrationConnections.failureNotifiedAt} is null`,
        ),
      )
      .returning({ id: integrationConnections.id });
    if (claimed)
      await this.notifications
        .notify({
          organizationId: c.organizationId,
          recipientUserIds: [c.ownerUserId],
          type: 'integration.failed',
          data: { connectionId: c.id, provider: c.provider, name: c.name, code },
          link: '/dashboard/integrations',
        })
        .catch(() => 0); // the owner may no longer be a member
  }

  async notifyConflict(c: ConnectionRow, meetingId: string, title: string, fields: string[]) {
    await this.notifications
      .notify({
        organizationId: c.organizationId,
        recipientUserIds: [c.ownerUserId],
        type: 'integration.conflict',
        data: {
          connectionId: c.id,
          provider: c.provider,
          name: c.name,
          meetingId,
          title,
          fields: fields.join(', '),
        },
        link: `/dashboard/meetings/${meetingId}`,
      })
      .catch(() => 0);
  }

  // ---------------------------------------------------------------- DTO

  async toDto(c: ConnectionRow): Promise<IntegrationDto> {
    const [[owner], [team], [links], pending] = await Promise.all([
      this.db
        .select({ id: users.id, displayName: users.displayName })
        .from(users)
        .where(eq(users.id, c.ownerUserId)),
      c.teamId
        ? this.db.select({ name: teams.name }).from(teams).where(eq(teams.id, c.teamId))
        : Promise.resolve([]),
      this.db
        .select({ n: count() })
        .from(integrationLinks)
        .where(and(eq(integrationLinks.connectionId, c.id), eq(integrationLinks.state, 'active'))),
      this.jobs.pendingCount(c.id),
    ]);
    const cfg = c.config as Record<string, unknown>;
    const settings: IntegrationDto['settings'] = {};
    if (c.provider === 'google_calendar') settings.calendarId = String(cfg.calendarId ?? 'primary');
    if (c.provider === 'notion') {
      settings.databaseTitle = (cfg.databaseTitle as string | null) ?? null;
      settings.endpointUrl = `${this.env.publicApiUrl}/integrations/hooks/notion/${c.id}`;
      const s = this.secrets<{ verificationToken?: string }>(c);
      settings.verificationToken = s.verificationToken ?? null;
    }
    if (c.provider === 'webhook_outgoing') {
      settings.url = String(cfg.url ?? '');
      settings.events = (cfg.events as IntegrationDto['settings']['events']) ?? [];
    }
    if (c.provider === 'webhook_incoming') {
      settings.actions = (cfg.actions as IntegrationDto['settings']['actions']) ?? [];
      settings.endpointUrl = `${this.env.publicApiUrl}/integrations/hooks/in/${c.id}`;
    }
    return {
      id: c.id,
      provider: c.provider as IntegrationProvider,
      name: c.name,
      personal: c.personal,
      owner: owner ?? null,
      direction: (c.direction as SyncDirection | null) ?? null,
      status: c.status as IntegrationDto['status'],
      paused: c.paused,
      teamId: c.teamId,
      teamName: (team as { name: string } | undefined)?.name ?? null,
      settings,
      lastSyncAt: c.lastSyncAt?.toISOString() ?? null,
      lastError:
        c.lastErrorCode && c.lastErrorAt
          ? {
              code: c.lastErrorCode,
              message: c.lastErrorMessage ?? '',
              at: c.lastErrorAt.toISOString(),
            }
          : null,
      linkedMeetings: links?.n ?? 0,
      pendingJobs: pending,
      createdAt: c.createdAt.toISOString(),
    };
  }
}
