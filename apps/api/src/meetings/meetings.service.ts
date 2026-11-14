/**
 * Meetings (spec §14, Phase 6): any manager who may create a meeting creates it directly — no
 * approval — and invites people, who confirm or decline (calendar-invite model). The Owner can
 * call organization-wide administrative meetings. A meeting is a series: one occurrence, or a
 * recurrence rule with an end condition; single occurrences can be cancelled or moved.
 *
 * Built on the shared services: every change is audited in the same transaction, invitees and
 * organizers are notified through the NotificationService, and committed changes are announced
 * on MeetingEvents (integrations queue their pushes from there).
 *
 * Integrations act through the same methods, with the connection owner's own permissions
 * (`opts.via` records which integration made the change, in the audit log too).
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  isoWithOffset,
  localToUtc,
  type MeetingCreateInput,
  type MeetingDto,
  type MeetingKind,
  type MeetingListQuery,
  type MeetingOccurrenceDto,
  type MeetingStatus,
  type MeetingUpdateInput,
  normalizeRule,
  occurrencesBetween,
  parseLocal,
  type RecurrenceRule,
  ruleProblem,
  type RsvpResponse,
  seriesEndUtc,
  seriesOccurrences,
  utcToLocal,
  formatLocal,
} from '@esports/shared';
import { and, eq, gt, inArray, lt, notInArray, sql } from 'drizzle-orm';
import type { TeamRef } from '../authz/access.js';
import type { TenantContext } from '../authz/context.js';
import { AuditService } from '../audit/audit.service.js';
import { AppError, Errors } from '../common/errors.js';
import { NOW, type Now } from '../common/now.js';
import { DB, type Database, type DbOrTx } from '../db/client.js';
import { departments, organizationMembers, teams, users } from '../db/schema.js';
import {
  integrationConnections,
  integrationLinks,
  meetingOverrides,
  meetingParticipants,
  meetings,
} from '../db/schema-meetings.js';
import { loadTeamRef } from '../finance/scope.js';
import { NotificationService } from '../notifications/notification.service.js';
import { canCreateIn, canEdit, canView, type MeetingScope } from './meeting-access.js';
import { MeetingEvents } from './meeting-events.js';

export type MeetingRow = typeof meetings.$inferSelect;
type OverrideRow = typeof meetingOverrides.$inferSelect;
type ParticipantRow = typeof meetingParticipants.$inferSelect & { displayName: string };

export interface ActOpts {
  /** Set when an integration makes the change on its owner's behalf. */
  via?: { provider: string; connectionId: string } | null;
}

export interface LoadedMeeting {
  row: MeetingRow;
  team: (TeamRef & { name: string }) | null;
  departmentName: string | null;
  participants: ParticipantRow[];
  overrides: OverrideRow[];
}

const link = (id: string) => `/dashboard/meetings/${id}`;

/** Equality for JSON values regardless of key order (jsonb reorders object keys). */
function sameJson(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown =>
    v === null || typeof v !== 'object'
      ? v
      : Array.isArray(v)
        ? v.map(norm)
        : Object.fromEntries(
            Object.keys(v as object)
              .sort()
              .map((k) => [k, norm((v as Record<string, unknown>)[k])]),
          );
  return JSON.stringify(norm(a ?? null)) === JSON.stringify(norm(b ?? null));
}

/** Duration and derived instants for a start/end pair in a zone. */
function timing(startLocal: string, endLocal: string, tz: string, rule: RecurrenceRule | null) {
  const s = localToUtc(parseLocal(startLocal)!, tz);
  const e = localToUtc(parseLocal(endLocal)!, tz);
  const durationMinutes = Math.round((e - s) / 60000);
  if (durationMinutes < 5 || durationMinutes > 1440)
    throw Errors.validation([{ path: 'end', message: 'duration_range', code: 'custom' }]);
  const recurrence = rule ? normalizeRule(rule, startLocal) : null;
  if (recurrence) {
    const problem = ruleProblem(recurrence, startLocal);
    if (problem)
      throw Errors.validation([{ path: 'recurrence', message: problem, code: 'custom' }]);
  }
  return {
    startLocal,
    durationMinutes,
    recurrence,
    startsAt: new Date(s),
    seriesEndsAt: new Date(seriesEndUtc(startLocal, durationMinutes, tz, recurrence)),
  };
}

export function endLocalOf(row: { startLocal: string; durationMinutes: number; timeZone: string }) {
  const s = localToUtc(parseLocal(row.startLocal)!, row.timeZone);
  return formatLocal(utcToLocal(s + row.durationMinutes * 60000, row.timeZone));
}

@Injectable()
export class MeetingsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(NOW) private readonly now: Now,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly events: MeetingEvents,
  ) {}

  // ---------------------------------------------------------------- loading

  async load(
    organizationId: string,
    id: string,
    tx: DbOrTx = this.db,
  ): Promise<LoadedMeeting | null> {
    const [r] = await tx
      .select({
        m: meetings,
        teamDept: teams.departmentId,
        teamName: teams.name,
        departmentName: departments.name,
      })
      .from(meetings)
      .leftJoin(teams, eq(teams.id, meetings.teamId))
      .leftJoin(departments, eq(departments.id, meetings.departmentId))
      .where(and(eq(meetings.id, id), eq(meetings.organizationId, organizationId)));
    if (!r) return null;
    const [participants, overrides] = await Promise.all([
      tx
        .select({ p: meetingParticipants, displayName: users.displayName })
        .from(meetingParticipants)
        .innerJoin(users, eq(users.id, meetingParticipants.userId))
        .where(eq(meetingParticipants.meetingId, id)),
      tx.select().from(meetingOverrides).where(eq(meetingOverrides.meetingId, id)),
    ]);
    return {
      row: r.m,
      team: r.m.teamId
        ? { id: r.m.teamId, departmentId: r.teamDept, name: r.teamName ?? '' }
        : null,
      departmentName: r.departmentName,
      participants: participants
        .map(({ p, displayName }) => ({ ...p, displayName }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
      overrides,
    };
  }

  scopeOf(l: { row: MeetingRow; team: TeamRef | null }): MeetingScope {
    return { kind: l.row.kind, team: l.team, departmentId: l.row.departmentId };
  }

  isParticipant(l: LoadedMeeting, userId: string) {
    return l.row.organizerUserId === userId || l.participants.some((p) => p.userId === userId);
  }

  /** The meeting if `ctx` may see it; otherwise 404 (existence isn't revealed). */
  async visible(ctx: TenantContext, id: string): Promise<LoadedMeeting> {
    const l = await this.load(ctx.organizationId, id);
    if (!l || !canView(ctx.access, this.scopeOf(l), this.isParticipant(l, ctx.user.id)))
      throw Errors.notFound('Meeting');
    return l;
  }

  private async editable(ctx: TenantContext, id: string, tx: DbOrTx): Promise<LoadedMeeting> {
    // Row lock: concurrent edits to one meeting are serialized (versions stay sequential).
    await tx.execute(
      sql`select 1 from app.meetings where id = ${id} and organization_id = ${ctx.organizationId} for update`,
    );
    const l = await this.load(ctx.organizationId, id, tx);
    if (!l || !canView(ctx.access, this.scopeOf(l), this.isParticipant(l, ctx.user.id)))
      throw Errors.notFound('Meeting');
    if (!canEdit(ctx.access, this.scopeOf(l), l.row.organizerUserId === ctx.user.id))
      throw Errors.forbidden();
    if (l.row.status === 'cancelled')
      throw Errors.conflict('meeting_not_editable', 'This meeting has been cancelled.');
    return l;
  }

  private async scopeFor(
    ctx: TenantContext,
    kind: MeetingKind,
    teamId?: string | null,
    departmentId?: string | null,
  ) {
    let team: (TeamRef & { name: string }) | null = null;
    if (teamId) team = await loadTeamRef(this.db, ctx.organizationId, teamId);
    if (departmentId) {
      const [d] = await this.db
        .select({ id: departments.id })
        .from(departments)
        .where(
          and(eq(departments.id, departmentId), eq(departments.organizationId, ctx.organizationId)),
        );
      if (!d) throw Errors.badRequest('invalid_scope', 'Unknown department');
    }
    return { kind, team, departmentId: departmentId ?? null } satisfies MeetingScope;
  }

  private async checkParticipants(organizationId: string, ids: string[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) return unique;
    const found = await this.db
      .select({ id: organizationMembers.userId })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, organizationId),
          eq(organizationMembers.status, 'active'),
          inArray(organizationMembers.userId, unique),
        ),
      );
    if (found.length !== unique.length)
      throw Errors.validation([
        { path: 'participantUserIds', message: 'unknown_participant', code: 'custom' },
      ]);
    return unique;
  }

  // ---------------------------------------------------------------- writes

  async create(
    ctx: TenantContext,
    input: MeetingCreateInput,
    opts: ActOpts & {
      source?: MeetingDto['source'];
      sourceConnectionId?: string | null;
      externalId?: string | null;
    } = {},
  ): Promise<MeetingDto> {
    const scope = await this.scopeFor(ctx, input.kind, input.teamId, input.departmentId);
    if (!canCreateIn(ctx.access, scope)) throw Errors.forbidden();
    const participantIds = await this.checkParticipants(
      ctx.organizationId,
      input.participantUserIds,
    );
    const t = timing(input.start, input.end, input.timeZone, input.recurrence ?? null);

    const id = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(meetings)
        .values({
          organizationId: ctx.organizationId,
          kind: input.kind,
          title: input.title,
          description: input.description ?? null,
          notes: input.notes ?? null,
          teamId: scope.team?.id ?? null,
          departmentId: scope.departmentId,
          timeZone: input.timeZone,
          ...t,
          organizerUserId: ctx.user.id,
          reminderMinutes: [...new Set(input.reminderMinutes)].sort((a, b) => b - a),
          source: opts.source ?? 'platform',
          sourceConnectionId: opts.sourceConnectionId ?? null,
          externalId: opts.externalId ?? null,
        })
        .returning({ id: meetings.id });
      const meetingId = row!.id;
      const invitees = participantIds.filter((u) => u !== ctx.user.id);
      await tx.insert(meetingParticipants).values([
        {
          organizationId: ctx.organizationId,
          meetingId,
          userId: ctx.user.id,
          response: 'accepted',
          respondedAt: new Date(this.now()),
        },
        ...invitees.map((userId) => ({ organizationId: ctx.organizationId, meetingId, userId })),
      ]);
      await this.audit.fromCtx(
        ctx,
        'meeting.created',
        { type: 'meeting', id: meetingId },
        {
          title: input.title,
          kind: input.kind,
          teamId: scope.team?.id ?? null,
          departmentId: scope.departmentId,
          recurring: !!t.recurrence,
          invited: invitees.length,
          ...(opts.via ? { via: opts.via.provider, connectionId: opts.via.connectionId } : {}),
        },
        tx,
      );
      await this.notifications.notify(
        {
          organizationId: ctx.organizationId,
          recipientUserIds: invitees,
          type: 'meeting.invited',
          data: {
            meetingId,
            title: input.title,
            start: t.startsAt.toISOString(),
            timeZone: input.timeZone,
            byName: ctx.user.displayName,
            recurring: !!t.recurrence,
          },
          link: link(meetingId),
        },
        tx,
      );
      return meetingId;
    });
    await this.events.emit({
      organizationId: ctx.organizationId,
      meetingId: id,
      change: { type: 'created' },
      originConnectionId: opts.via?.connectionId ?? null,
    });
    return this.get(ctx, id);
  }

  async update(
    ctx: TenantContext,
    id: string,
    input: MeetingUpdateInput,
    opts: ActOpts = {},
  ): Promise<MeetingDto> {
    const result = await this.db.transaction(async (tx) => {
      const l = await this.editable(ctx, id, tx);
      const m = l.row;
      if (input.expectedVersion !== undefined && input.expectedVersion !== m.version)
        throw new AppError('version_conflict', 409, 'The meeting changed since you opened it.', {
          currentVersion: m.version,
        });

      // Destination scope (moving to another team or department needs cover there too).
      const scopeChanged = input.teamId !== undefined || input.departmentId !== undefined;
      let scope = this.scopeOf(l);
      if (scopeChanged) {
        if (m.kind === 'administrative' && (input.teamId || input.departmentId))
          throw Errors.validation([
            { path: 'teamId', message: 'administrative_is_org_wide', code: 'custom' },
          ]);
        const teamId =
          input.teamId !== undefined
            ? input.teamId
            : input.departmentId !== undefined
              ? null
              : m.teamId;
        const departmentId =
          input.departmentId !== undefined
            ? input.departmentId
            : input.teamId !== undefined
              ? null
              : m.departmentId;
        scope = await this.scopeFor(ctx, m.kind as MeetingKind, teamId, departmentId);
        if (!canEdit(ctx.access, scope, m.organizerUserId === ctx.user.id))
          throw Errors.forbidden();
      }

      const tz = input.timeZone ?? m.timeZone;
      const startLocal = input.start ?? m.startLocal;
      const endLocal = input.end ?? endLocalOf(m);
      const rule = input.recurrence !== undefined ? input.recurrence : m.recurrence;
      const t = timing(startLocal, endLocal, tz, rule ?? null);

      const changed: string[] = [];
      const set: Partial<typeof meetings.$inferInsert> = {};
      const field = <K extends 'title' | 'description' | 'notes'>(k: K) => {
        const v = input[k];
        if (v !== undefined && (v ?? null) !== m[k]) {
          set[k] = (v ?? null) as never;
          changed.push(k);
        }
      };
      field('title');
      field('description');
      field('notes');
      if (
        scopeChanged &&
        ((scope.team?.id ?? null) !== m.teamId || scope.departmentId !== m.departmentId)
      ) {
        set.teamId = scope.team?.id ?? null;
        set.departmentId = scope.departmentId;
        changed.push('team');
      }
      const timingChanged =
        t.startLocal !== m.startLocal ||
        t.durationMinutes !== m.durationMinutes ||
        tz !== m.timeZone ||
        !sameJson(t.recurrence, m.recurrence ? normalizeRule(m.recurrence, m.startLocal) : null);
      if (timingChanged) {
        Object.assign(set, t, { timeZone: tz });
        changed.push('time');
        if (
          !sameJson(t.recurrence, m.recurrence ? normalizeRule(m.recurrence, m.startLocal) : null)
        )
          changed.push('recurrence');
      }
      if (input.reminderMinutes !== undefined) {
        const next = [...new Set(input.reminderMinutes)].sort((a, b) => b - a);
        if (JSON.stringify(next) !== JSON.stringify(m.reminderMinutes)) {
          set.reminderMinutes = next;
          changed.push('reminders');
        }
      }
      let added: string[] = [];
      let removed: string[] = [];
      if (input.participantUserIds !== undefined) {
        const wanted = new Set(
          await this.checkParticipants(ctx.organizationId, input.participantUserIds),
        );
        if (m.organizerUserId) wanted.add(m.organizerUserId);
        const current = new Set(l.participants.map((p) => p.userId));
        added = [...wanted].filter((u) => !current.has(u));
        removed = [...current].filter((u) => !wanted.has(u));
        if (added.length || removed.length) changed.push('participants');
      }
      if (!changed.length) return { l, changed, notifyChanged: [] as string[], added };

      await tx
        .update(meetings)
        .set({ ...set, version: m.version + 1, updatedAt: new Date(this.now()) })
        .where(eq(meetings.id, id));
      if (removed.length)
        await tx
          .delete(meetingParticipants)
          .where(
            and(
              eq(meetingParticipants.meetingId, id),
              inArray(meetingParticipants.userId, removed),
            ),
          );
      if (added.length)
        await tx
          .insert(meetingParticipants)
          .values(
            added.map((userId) => ({ organizationId: ctx.organizationId, meetingId: id, userId })),
          );
      if (timingChanged) {
        // Occurrence changes only survive for occurrences the new series still has.
        const keys = seriesOccurrences(t.startLocal, t.durationMinutes, tz, t.recurrence).map(
          (o) => new Date(o.key),
        );
        await tx
          .delete(meetingOverrides)
          .where(
            and(
              eq(meetingOverrides.meetingId, id),
              keys.length ? notInArray(meetingOverrides.originalStart, keys) : undefined,
            ),
          );
      }
      await this.audit.fromCtx(
        ctx,
        'meeting.updated',
        { type: 'meeting', id },
        {
          changed,
          version: m.version + 1,
          ...(added.length ? { invited: added.length } : {}),
          ...(removed.length ? { uninvited: removed.length } : {}),
          ...(opts.via ? { via: opts.via.provider, connectionId: opts.via.connectionId } : {}),
        },
        tx,
      );
      const title = set.title ?? m.title;
      if (added.length)
        await this.notifications.notify(
          {
            organizationId: ctx.organizationId,
            recipientUserIds: added.filter((u) => u !== ctx.user.id),
            type: 'meeting.invited',
            data: {
              meetingId: id,
              title,
              start: t.startsAt.toISOString(),
              timeZone: tz,
              byName: ctx.user.displayName,
              recurring: !!t.recurrence,
            },
            link: link(id),
          },
          tx,
        );
      const notifyChanged = changed.filter((c) => c === 'time' || c === 'title');
      if (notifyChanged.length) {
        const stay = l.participants
          .map((p) => p.userId)
          .filter((u) => !removed.includes(u) && u !== ctx.user.id);
        await this.notifications.notify(
          {
            organizationId: ctx.organizationId,
            recipientUserIds: stay,
            type: 'meeting.updated',
            data: {
              meetingId: id,
              title,
              start: t.startsAt.toISOString(),
              timeZone: tz,
              byName: ctx.user.displayName,
              changed: notifyChanged,
            },
            link: link(id),
          },
          tx,
        );
      }
      return { l, changed, notifyChanged, added };
    });
    if (result.changed.length)
      await this.events.emit({
        organizationId: ctx.organizationId,
        meetingId: id,
        change: { type: 'updated', fields: result.changed },
        originConnectionId: opts.via?.connectionId ?? null,
      });
    return this.get(ctx, id);
  }

  async cancel(
    ctx: TenantContext,
    id: string,
    reason: string | null | undefined,
    opts: ActOpts = {},
  ): Promise<MeetingDto> {
    let changed = false;
    await this.db.transaction(async (tx) => {
      const l = await this.load(ctx.organizationId, id, tx);
      if (l?.row.status === 'cancelled') return; // idempotent
      const { row: m, participants } = await this.editable(ctx, id, tx);
      const at = new Date(this.now());
      await tx
        .update(meetings)
        .set({
          status: 'cancelled',
          cancelledAt: at,
          cancelReason: reason ?? null,
          version: m.version + 1,
          updatedAt: at,
        })
        .where(eq(meetings.id, id));
      await this.audit.fromCtx(
        ctx,
        'meeting.cancelled',
        { type: 'meeting', id },
        {
          title: m.title,
          reason: reason ?? null,
          ...(opts.via ? { via: opts.via.provider, connectionId: opts.via.connectionId } : {}),
        },
        tx,
      );
      await this.notifications.notify(
        {
          organizationId: ctx.organizationId,
          recipientUserIds: participants.map((p) => p.userId).filter((u) => u !== ctx.user.id),
          type: 'meeting.cancelled',
          data: {
            meetingId: id,
            title: m.title,
            start: m.startsAt.toISOString(),
            timeZone: m.timeZone,
            byName: ctx.user.displayName,
            reason: reason ?? '',
          },
          link: link(id),
        },
        tx,
      );
      changed = true;
    });
    if (changed)
      await this.events.emit({
        organizationId: ctx.organizationId,
        meetingId: id,
        change: { type: 'cancelled' },
        originConnectionId: opts.via?.connectionId ?? null,
      });
    return this.get(ctx, id);
  }

  /** The occurrence of this series that started (originally) at `originalStart`, or 400. */
  private occurrenceKey(m: MeetingRow, originalStart: string): string {
    const key = new Date(originalStart).toISOString();
    const all = seriesOccurrences(m.startLocal, m.durationMinutes, m.timeZone, m.recurrence);
    if (!all.some((o) => o.key === key))
      throw Errors.validation([
        { path: 'originalStart', message: 'not_an_occurrence', code: 'custom' },
      ]);
    return key;
  }

  async cancelOccurrence(
    ctx: TenantContext,
    id: string,
    originalStart: string,
    opts: ActOpts = {},
  ): Promise<MeetingDto> {
    let key = '';
    let changed = false;
    await this.db.transaction(async (tx) => {
      const { row: m, participants, overrides } = await this.editable(ctx, id, tx);
      key = this.occurrenceKey(m, originalStart);
      const existing = overrides.find((o) => o.originalStart.toISOString() === key);
      if (existing?.status === 'cancelled') return;
      await tx
        .insert(meetingOverrides)
        .values({
          organizationId: ctx.organizationId,
          meetingId: id,
          originalStart: new Date(key),
          status: 'cancelled',
        })
        .onConflictDoUpdate({
          target: [meetingOverrides.meetingId, meetingOverrides.originalStart],
          set: { status: 'cancelled', startAt: null, endAt: null, updatedAt: new Date(this.now()) },
        });
      await tx
        .update(meetings)
        .set({ version: m.version + 1, updatedAt: new Date(this.now()) })
        .where(eq(meetings.id, id));
      await this.audit.fromCtx(
        ctx,
        'meeting.occurrence_cancelled',
        { type: 'meeting', id },
        {
          originalStart: key,
          ...(opts.via ? { via: opts.via.provider, connectionId: opts.via.connectionId } : {}),
        },
        tx,
      );
      await this.notifications.notify(
        {
          organizationId: ctx.organizationId,
          recipientUserIds: participants.map((p) => p.userId).filter((u) => u !== ctx.user.id),
          type: 'meeting.occurrence_cancelled',
          data: {
            meetingId: id,
            title: m.title,
            start: existing?.startAt?.toISOString() ?? key,
            timeZone: m.timeZone,
            byName: ctx.user.displayName,
          },
          link: link(id),
        },
        tx,
      );
      changed = true;
    });
    if (changed)
      await this.events.emit({
        organizationId: ctx.organizationId,
        meetingId: id,
        change: { type: 'occurrence_cancelled', originalStart: key },
        originConnectionId: opts.via?.connectionId ?? null,
      });
    return this.get(ctx, id);
  }

  async moveOccurrence(
    ctx: TenantContext,
    id: string,
    input: { originalStart: string; start: string; end: string },
    opts: ActOpts = {},
  ): Promise<MeetingDto> {
    let key = '';
    let changed = false;
    await this.db.transaction(async (tx) => {
      const { row: m, participants, overrides } = await this.editable(ctx, id, tx);
      key = this.occurrenceKey(m, input.originalStart);
      const s = localToUtc(parseLocal(input.start)!, m.timeZone);
      const e = localToUtc(parseLocal(input.end)!, m.timeZone);
      if ((e - s) / 60000 < 5 || (e - s) / 60000 > 1440)
        throw Errors.validation([{ path: 'end', message: 'duration_range', code: 'custom' }]);
      const existing = overrides.find((o) => o.originalStart.toISOString() === key);
      if (
        existing?.status === 'moved' &&
        existing.startAt?.getTime() === s &&
        existing.endAt?.getTime() === e
      )
        return;
      await tx
        .insert(meetingOverrides)
        .values({
          organizationId: ctx.organizationId,
          meetingId: id,
          originalStart: new Date(key),
          status: 'moved',
          startAt: new Date(s),
          endAt: new Date(e),
        })
        .onConflictDoUpdate({
          target: [meetingOverrides.meetingId, meetingOverrides.originalStart],
          set: {
            status: 'moved',
            startAt: new Date(s),
            endAt: new Date(e),
            updatedAt: new Date(this.now()),
          },
        });
      await tx
        .update(meetings)
        .set({ version: m.version + 1, updatedAt: new Date(this.now()) })
        .where(eq(meetings.id, id));
      await this.audit.fromCtx(
        ctx,
        'meeting.occurrence_moved',
        { type: 'meeting', id },
        {
          originalStart: key,
          start: new Date(s).toISOString(),
          ...(opts.via ? { via: opts.via.provider, connectionId: opts.via.connectionId } : {}),
        },
        tx,
      );
      await this.notifications.notify(
        {
          organizationId: ctx.organizationId,
          recipientUserIds: participants.map((p) => p.userId).filter((u) => u !== ctx.user.id),
          type: 'meeting.updated',
          data: {
            meetingId: id,
            title: m.title,
            start: new Date(s).toISOString(),
            timeZone: m.timeZone,
            byName: ctx.user.displayName,
            changed: ['time'],
          },
          link: link(id),
        },
        tx,
      );
      changed = true;
    });
    if (changed)
      await this.events.emit({
        organizationId: ctx.organizationId,
        meetingId: id,
        change: { type: 'occurrence_moved', originalStart: key },
        originConnectionId: opts.via?.connectionId ?? null,
      });
    return this.get(ctx, id);
  }

  async respond(
    ctx: TenantContext,
    id: string,
    input: { response: 'accepted' | 'declined'; note?: string | null },
    opts: ActOpts = {},
  ): Promise<MeetingDto> {
    const l = await this.visible(ctx, id);
    const me = l.participants.find((p) => p.userId === ctx.user.id);
    if (!me) throw new AppError('not_a_participant', 403, 'Only invited people can respond.');
    if (l.row.status === 'cancelled')
      throw Errors.conflict('meeting_not_editable', 'This meeting has been cancelled.');
    const note = input.note === undefined ? me.note : (input.note ?? null);
    if (me.response === input.response && note === me.note) return this.get(ctx, id);
    await this.db.transaction(async (tx) => {
      await tx
        .update(meetingParticipants)
        .set({ response: input.response, respondedAt: new Date(this.now()), note })
        .where(
          and(eq(meetingParticipants.meetingId, id), eq(meetingParticipants.userId, ctx.user.id)),
        );
      await this.audit.fromCtx(
        ctx,
        'meeting.responded',
        { type: 'meeting', id },
        {
          response: input.response,
          ...(opts.via ? { via: opts.via.provider, connectionId: opts.via.connectionId } : {}),
        },
        tx,
      );
      if (
        l.row.organizerUserId &&
        l.row.organizerUserId !== ctx.user.id &&
        me.response !== input.response
      )
        await this.notifications.notify(
          {
            organizationId: ctx.organizationId,
            recipientUserIds: [l.row.organizerUserId],
            type: 'meeting.response',
            data: {
              meetingId: id,
              title: l.row.title,
              participantName: ctx.user.displayName,
              response: input.response,
              note: note ?? '',
            },
            link: link(id),
          },
          tx,
        );
    });
    await this.events.emit({
      organizationId: ctx.organizationId,
      meetingId: id,
      change: { type: 'response', userId: ctx.user.id, response: input.response },
      originConnectionId: opts.via?.connectionId ?? null,
    });
    return this.get(ctx, id);
  }

  // ---------------------------------------------------------------- reads

  async get(ctx: TenantContext, id: string): Promise<MeetingDto> {
    const l = await this.visible(ctx, id);
    const links = await this.db
      .select({
        connectionId: integrationLinks.connectionId,
        provider: integrationConnections.provider,
        remoteUrl: integrationLinks.remoteUrl,
        lastSyncedAt: integrationLinks.lastSyncedAt,
        ownerUserId: integrationConnections.ownerUserId,
        personal: integrationConnections.personal,
      })
      .from(integrationLinks)
      .innerJoin(
        integrationConnections,
        eq(integrationConnections.id, integrationLinks.connectionId),
      )
      .where(
        and(
          eq(integrationLinks.meetingId, id),
          eq(integrationLinks.state, 'active'),
          sql`${integrationConnections.status} <> 'disconnected'`,
        ),
      );
    return this.toDto(
      ctx,
      l,
      links.filter((x) =>
        x.personal ? x.ownerUserId === ctx.user.id : ctx.access.has('integrations.manage'),
      ),
    );
  }

  toDto(
    ctx: TenantContext,
    l: LoadedMeeting,
    links: {
      connectionId: string;
      provider: string;
      remoteUrl: string | null;
      lastSyncedAt: Date | null;
    }[] = [],
  ): MeetingDto {
    const m = l.row;
    const organizer = l.participants.find((p) => p.userId === m.organizerUserId);
    const me = l.participants.find((p) => p.userId === ctx.user.id);
    const now = this.now();
    const upcoming = occurrencesBetween(
      {
        startLocal: m.startLocal,
        durationMinutes: m.durationMinutes,
        timeZone: m.timeZone,
        recurrence: m.recurrence,
      },
      l.overrides.map((o) => ({
        originalStart: o.originalStart.toISOString(),
        status: o.status as 'cancelled' | 'moved',
        start: o.startAt?.toISOString() ?? null,
        end: o.endAt?.toISOString() ?? null,
      })),
      now,
      Number.MAX_SAFE_INTEGER,
    )
      .slice(0, 10)
      .map((o) => this.occurrenceDto(l, o, ctx.user.id));
    return {
      id: m.id,
      kind: m.kind as MeetingKind,
      title: m.title,
      description: m.description,
      notes: m.notes,
      teamId: m.teamId,
      teamName: l.team?.name ?? null,
      departmentId: m.departmentId,
      departmentName: l.departmentName,
      timeZone: m.timeZone,
      startLocal: m.startLocal,
      endLocal: endLocalOf(m),
      start: isoWithOffset(m.startsAt.getTime(), m.timeZone),
      end: isoWithOffset(m.startsAt.getTime() + m.durationMinutes * 60000, m.timeZone),
      durationMinutes: m.durationMinutes,
      recurrence: m.recurrence,
      seriesEnd: m.seriesEndsAt.toISOString(),
      status: m.status as MeetingStatus,
      cancelReason: m.cancelReason,
      organizer: organizer ? { id: organizer.userId, displayName: organizer.displayName } : null,
      participants: l.participants.map((p) => ({
        userId: p.userId,
        displayName: p.displayName,
        response: p.response as RsvpResponse,
        respondedAt: p.respondedAt?.toISOString() ?? null,
        note: p.note,
        isOrganizer: p.userId === m.organizerUserId,
      })),
      myResponse: (me?.response as RsvpResponse | undefined) ?? null,
      reminderMinutes: m.reminderMinutes,
      overrides: l.overrides.map((o) => ({
        originalStart: o.originalStart.toISOString(),
        status: o.status as 'cancelled' | 'moved',
        start: o.startAt?.toISOString() ?? null,
        end: o.endAt?.toISOString() ?? null,
      })),
      upcoming,
      version: m.version,
      canEdit:
        m.status !== 'cancelled' &&
        canEdit(ctx.access, this.scopeOf(l), m.organizerUserId === ctx.user.id),
      canRespond: m.status !== 'cancelled' && !!me,
      syncLinks: links.map((x) => ({
        connectionId: x.connectionId,
        provider: x.provider as MeetingDto['syncLinks'][number]['provider'],
        remoteUrl: x.remoteUrl,
        lastSyncedAt: x.lastSyncedAt?.toISOString() ?? null,
      })),
      source: m.source as MeetingDto['source'],
      createdAt: m.createdAt.toISOString(),
      updatedAt: m.updatedAt.toISOString(),
    };
  }

  private occurrenceDto(
    l: LoadedMeeting,
    o: { key: string; startUtc: number; endUtc: number; cancelled: boolean; moved: boolean },
    userId: string,
  ): MeetingOccurrenceDto {
    const m = l.row;
    return {
      meetingId: m.id,
      key: o.key,
      start: isoWithOffset(o.startUtc, m.timeZone),
      end: isoWithOffset(o.endUtc, m.timeZone),
      title: m.title,
      kind: m.kind as MeetingKind,
      teamName: l.team?.name ?? null,
      departmentName: l.departmentName,
      timeZone: m.timeZone,
      status: m.status as MeetingStatus,
      cancelled: o.cancelled || m.status === 'cancelled',
      moved: o.moved,
      recurring: !!m.recurrence,
      myResponse:
        (l.participants.find((p) => p.userId === userId)?.response as RsvpResponse | undefined) ??
        null,
      isOrganizer: m.organizerUserId === userId,
    };
  }

  /** Occurrences of the meetings the user can see, overlapping the window (whole days). */
  async list(ctx: TenantContext, q: MeetingListQuery): Promise<MeetingOccurrenceDto[]> {
    // A day of slack on both sides covers every time zone; the client groups by its local day.
    const from = Date.parse(`${q.from}T00:00:00Z`) - 86_400_000;
    const to = Date.parse(`${q.to}T00:00:00Z`) + 2 * 86_400_000;
    const ids = await this.db
      .select({ id: meetings.id })
      .from(meetings)
      .where(
        and(
          eq(meetings.organizationId, ctx.organizationId),
          gt(meetings.seriesEndsAt, new Date(from)),
          lt(meetings.startsAt, new Date(to)),
          q.teamId ? eq(meetings.teamId, q.teamId) : undefined,
        ),
      );
    const out: MeetingOccurrenceDto[] = [];
    for (const { id } of ids) {
      const l = await this.load(ctx.organizationId, id);
      if (!l) continue;
      const mine = this.isParticipant(l, ctx.user.id);
      if (!canView(ctx.access, this.scopeOf(l), mine)) continue;
      if (q.mine === 'true' && !mine) continue;
      const occ = occurrencesBetween(
        {
          startLocal: l.row.startLocal,
          durationMinutes: l.row.durationMinutes,
          timeZone: l.row.timeZone,
          recurrence: l.row.recurrence,
        },
        l.overrides.map((o) => ({
          originalStart: o.originalStart.toISOString(),
          status: o.status as 'cancelled' | 'moved',
          start: o.startAt?.toISOString() ?? null,
          end: o.endAt?.toISOString() ?? null,
        })),
        from,
        to,
      );
      for (const o of occ) out.push(this.occurrenceDto(l, o, ctx.user.id));
    }
    return out.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  }
}
