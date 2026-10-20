/**
 * Two-way sync for providers whose records live behind an API (Google Calendar, Notion).
 * The rules themselves are in sync-engine.ts; this applies them:
 *
 * PUSH (a meeting changed on the platform)
 *   - not linked yet → look for an existing record first (dedupe), else create; link it;
 *   - linked, two-way → read the record; if it changed since the last sync too, merge;
 *     otherwise write the platform's values;
 *   - no longer carried (uninvited, declined on a personal calendar, outside the team filter)
 *     → remove the record and unlink.
 * PULL (the provider changed)
 *   - an unknown record that says it's ours → relink (no duplicate);
 *   - an unknown new record → import as a meeting (if the provider imports and the owner may
 *     create meetings), then write the meeting id back to it;
 *   - a linked record whose version is the one we last wrote → our own echo, skipped;
 *   - otherwise → merge with the platform, apply provider-only changes through the meetings
 *     service as the connection's owner (permission-checked and audited), push back the
 *     platform's side of any conflict.
 * Push-only connections never read the provider.
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  localToUtc,
  meetingCreateSchema,
  type MeetingUpdateInput,
  normalizeRule,
  parseLocal,
  type RsvpResponse,
} from '@esports/shared';
import { and, eq, gt, ne } from 'drizzle-orm';
import type { TenantContext } from '../authz/context';
import { AppError } from '../common/errors';
import { NOW, type Now } from '../common/now';
import { DB, type Database } from '../db/client';
import { integrationLinks, meetings } from '../db/schema-meetings';
import { endLocalOf, type LoadedMeeting, MeetingsService } from '../meetings/meetings.service';
import { type ConnectionRow, ConnectionsService } from './connections.service';
import { IntegrationError } from './errors';
import { JobsService } from './jobs.service';
import { GoogleCalendarProvider } from './providers/google-calendar';
import { NotionProvider } from './providers/notion';
import type { LinkRow, MeetingView, RemoteProvider, RemoteRecord } from './providers/types';
import { ALL_KEYS, same, type Snapshot, threeWayMerge } from './sync-engine';

const short = (v: unknown) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > 200 ? `${s.slice(0, 200)}…` : s;
};

@Injectable()
export class RemoteSyncService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(NOW) private readonly now: Now,
    private readonly connections: ConnectionsService,
    private readonly meetings: MeetingsService,
    private readonly jobs: JobsService,
    private readonly google: GoogleCalendarProvider,
    private readonly notion: NotionProvider,
  ) {}

  provider(c: ConnectionRow): RemoteProvider {
    if (c.provider === 'google_calendar') return this.google;
    if (c.provider === 'notion') return this.notion;
    throw new Error(`No remote provider for ${c.provider}`);
  }

  // ---------------------------------------------------------------- snapshots and views

  localSnapshot(c: ConnectionRow, l: LoadedMeeting, owner: TenantContext): Snapshot {
    const m = l.row;
    return {
      title: m.title,
      description: m.description,
      notes: m.notes,
      time: { startLocal: m.startLocal, endLocal: endLocalOf(m), timeZone: m.timeZone },
      recurrence: m.recurrence ? normalizeRule(m.recurrence, m.startLocal) : null,
      exdates: l.overrides
        .filter((o) => o.status === 'cancelled')
        .map((o) => o.originalStart.toISOString())
        .sort(),
      status: m.status as Snapshot['status'],
      ...(c.personal ? { response: this.ownerResponse(l, owner) } : {}),
    };
  }

  private ownerResponse(l: LoadedMeeting, owner: TenantContext): RsvpResponse | null {
    return (
      (l.participants.find((p) => p.userId === owner.user.id)?.response as
        RsvpResponse | undefined) ?? null
    );
  }

  view(c: ConnectionRow, l: LoadedMeeting, owner: TenantContext, snapshot?: Snapshot): MeetingView {
    return {
      loaded: l,
      snapshot: snapshot ?? this.localSnapshot(c, l, owner),
      ownerResponse: this.ownerResponse(l, owner),
      locale: owner.user.locale === 'ar' ? 'ar' : 'en',
    };
  }

  /** The provider's values, completed with the base (or platform) for what it can't represent. */
  private remoteSnapshot(
    p: RemoteProvider,
    rec: RemoteRecord,
    base: Snapshot | null,
    local: Snapshot,
  ): Snapshot {
    const out = structuredClone(base ?? local) as Snapshot;
    for (const k of p.inboundKeys) {
      const v = (rec.snapshot as Record<string, unknown> | null)?.[k];
      if (v !== undefined) (out as unknown as Record<string, unknown>)[k] = structuredClone(v);
    }
    return out;
  }

  /** Should this connection hold a record for the meeting right now? */
  private carries(c: ConnectionRow, l: LoadedMeeting | null, owner: TenantContext) {
    if (!l || !this.connections.carries(c, l, owner, this.meetings)) return false;
    if (c.provider === 'google_calendar') {
      // A member's calendar shows live meetings they haven't declined.
      if (l.row.status === 'cancelled') return false;
      if (this.ownerResponse(l, owner) === 'declined') return false;
    }
    return true;
  }

  private async link(c: ConnectionRow, meetingId: string): Promise<LinkRow | null> {
    const [link] = await this.db
      .select()
      .from(integrationLinks)
      .where(
        and(eq(integrationLinks.connectionId, c.id), eq(integrationLinks.meetingId, meetingId)),
      );
    return link ?? null;
  }

  private async saveLink(
    link: Pick<LinkRow, 'id'>,
    rec: RemoteRecord,
    snapshot: Snapshot | null,
    localVersion: number,
  ) {
    await this.db
      .update(integrationLinks)
      .set({
        state: 'active',
        remoteId: rec.id,
        remoteVersion: rec.version,
        remoteUrl: rec.url,
        syncedSnapshot: snapshot as unknown as Record<string, unknown>,
        localVersion,
        lastSyncedAt: new Date(this.now()),
        updatedAt: new Date(this.now()),
      })
      .where(eq(integrationLinks.id, link.id));
  }

  private async unlink(link: LinkRow) {
    await this.db
      .update(integrationLinks)
      .set({ state: 'unlinked', syncedSnapshot: null, updatedAt: new Date(this.now()) })
      .where(eq(integrationLinks.id, link.id));
  }

  private async owner(c: ConnectionRow): Promise<TenantContext> {
    const owner = await this.connections.ownerCtx(c);
    if (!owner)
      throw new IntegrationError(
        'auth',
        'owner_inactive',
        'The member who set up this integration no longer has access',
      );
    return owner;
  }

  private via(c: ConnectionRow) {
    return { via: { provider: c.provider, connectionId: c.id } };
  }

  // ---------------------------------------------------------------- push

  async pushMeeting(c: ConnectionRow, meetingId: string): Promise<void> {
    const p = this.provider(c);
    const owner = await this.owner(c);
    const l = await this.meetings.load(c.organizationId, meetingId);
    let link = await this.link(c, meetingId);

    if (!this.carries(c, l, owner)) {
      if (link?.state === 'active') {
        await p.remove(c, link);
        await this.unlink(link);
        await this.connections.log(
          c,
          'info',
          'pushed',
          'Removed from the provider (no longer included).',
          { meetingId },
        );
      }
      return;
    }
    const local = this.localSnapshot(c, l!, owner);

    if (!link || link.state !== 'active') {
      if (!link) {
        await this.db
          .insert(integrationLinks)
          .values({
            organizationId: c.organizationId,
            connectionId: c.id,
            meetingId,
            state: 'pending_create',
          })
          .onConflictDoNothing();
        link = (await this.link(c, meetingId))!;
      }
      // An earlier attempt may have created the record before failing to record it.
      const existing = await p.find(c, meetingId);
      const rec = existing
        ? await p.update(
            c,
            { ...link, remoteId: existing.id, remoteVersion: null },
            this.view(c, l!, owner, local),
          )
        : await p.create(c, this.view(c, l!, owner, local));
      await this.saveLink(link, rec, local, l!.row.version);
      await this.connections.log(
        c,
        'info',
        'pushed',
        existing ? 'Re-linked to the existing record.' : 'Created at the provider.',
        {
          meetingId,
        },
      );
      return;
    }

    const base = link.syncedSnapshot as Snapshot | null;
    if (base && same(base, local)) return; // nothing the provider shows has changed

    if (c.direction === 'two_way') {
      for (let attempt = 0; ; attempt++) {
        const rec = await p.get(c, link.remoteId!);
        if (!rec) return this.recreate(c, link, meetingId);
        if (rec.deleted) return this.remoteDeleted(c, owner, link, l!);
        if (rec.version !== link.remoteVersion) return this.reconcile(c, owner, link, l!, rec);
        try {
          const written = await p.update(c, link, this.view(c, l!, owner, local));
          await this.saveLink(link, written, local, l!.row.version);
          await this.connections.log(c, 'info', 'pushed', 'Updated at the provider.', {
            meetingId,
          });
          return;
        } catch (e) {
          // Changed at the provider between our read and our write: read again and merge.
          if (e instanceof IntegrationError && e.code === 'precondition_failed' && attempt === 0)
            continue;
          throw e;
        }
      }
    }
    // Push-only writes unconditionally: the platform's version replaces whatever is there.
    let rec: RemoteRecord;
    try {
      rec = await p.update(c, { ...link, remoteVersion: null }, this.view(c, l!, owner, local));
    } catch (e) {
      if (e instanceof IntegrationError && e.code === 'remote_gone')
        return this.recreate(c, link, meetingId);
      throw e;
    }
    await this.saveLink(link, rec, local, l!.row.version);
    await this.connections.log(c, 'info', 'pushed', 'Updated at the provider.', { meetingId });
  }

  /**
   * The record is missing at the provider (not "deleted": Google keeps deleted events with a
   * cancelled status, Notion keeps trashed pages). A missing record is never read as a
   * cancellation; it is created again from the platform's version.
   */
  private async recreate(c: ConnectionRow, link: LinkRow, meetingId: string): Promise<void> {
    await this.unlink(link);
    await this.connections.log(
      c,
      'warn',
      'pushed',
      'The record was missing at the provider; it was created again.',
      { meetingId },
    );
    return this.pushMeeting(c, meetingId);
  }

  // ---------------------------------------------------------------- pull

  async pull(c: ConnectionRow, opts: { full?: boolean; pageIds?: string[] } = {}): Promise<number> {
    if (c.direction !== 'two_way') return 0;
    const p = this.provider(c);
    const owner = await this.owner(c);
    const changes = await p.changes(c, { full: !!opts.full, pageIds: opts.pageIds });
    if (changes.fullResync)
      await this.connections.log(
        c,
        'info',
        'full_resync',
        'The provider asked for a full re-sync; existing links kept everything matched.',
      );
    let changed = 0;
    for (const rec of changes.records) {
      try {
        if (await this.processRecord(c, owner, p, rec)) changed += 1;
      } catch (e) {
        // Transient problems retry the whole pull (the position isn't saved); others are logged.
        if (
          e instanceof IntegrationError &&
          (e.kind === 'retryable' || e.kind === 'rate_limited' || e.kind === 'auth')
        )
          throw e;
        await this.connections.log(
          c,
          'warn',
          'failed',
          `Could not process a change: ${(e as Error).message}`,
          {
            detail: { remoteId: rec.id },
          },
        );
      }
    }
    await changes.commit();
    if (changed)
      await this.connections.log(
        c,
        'info',
        'synced',
        `Processed ${changed} change(s) from the provider.`,
        {
          detail: { changed },
        },
      );
    return changed;
  }

  /** Returns true if anything changed on the platform. */
  private async processRecord(
    c: ConnectionRow,
    owner: TenantContext,
    p: RemoteProvider,
    rec: RemoteRecord,
  ): Promise<boolean> {
    if (rec.instanceOf) return this.instanceChanged(c, owner, rec);
    const [link] = await this.db
      .select()
      .from(integrationLinks)
      .where(and(eq(integrationLinks.connectionId, c.id), eq(integrationLinks.remoteId, rec.id)));
    if (!link) {
      if (rec.platformMeetingId) return this.relink(c, owner, rec);
      if (rec.deleted || !p.importsNew(c)) return false;
      return this.importRecord(c, owner, p, rec);
    }
    if (link.state !== 'active') return false;
    const l = await this.meetings.load(c.organizationId, link.meetingId);
    if (!l) return false;
    if (rec.deleted) {
      await this.remoteDeleted(c, owner, link, l);
      return true;
    }
    if (rec.version === link.remoteVersion) return false; // our own write coming back
    await this.reconcile(c, owner, link, l, rec);
    return true;
  }

  /** A record that says it mirrors one of our meetings but has no link: link it, platform wins. */
  private async relink(
    c: ConnectionRow,
    owner: TenantContext,
    rec: RemoteRecord,
  ): Promise<boolean> {
    const l = await this.meetings.load(c.organizationId, rec.platformMeetingId!);
    if (!l || rec.deleted || !this.carries(c, l, owner)) return false;
    const existing = await this.link(c, l.row.id);
    if (existing?.state === 'active') return false; // linked to another record already
    await this.db
      .insert(integrationLinks)
      .values({
        organizationId: c.organizationId,
        connectionId: c.id,
        meetingId: l.row.id,
        state: 'pending_create',
      })
      .onConflictDoNothing();
    const link = (await this.link(c, l.row.id))!;
    const local = this.localSnapshot(c, l, owner);
    const written = await this.provider(c).update(
      c,
      { ...link, remoteId: rec.id },
      this.view(c, l, owner, local),
    );
    await this.saveLink(link, written, local, l.row.version);
    await this.connections.log(
      c,
      'info',
      'pushed',
      'Re-linked a record that already mirrored this meeting.',
      {
        meetingId: l.row.id,
      },
    );
    return false;
  }

  private async importRecord(
    c: ConnectionRow,
    owner: TenantContext,
    p: RemoteProvider,
    rec: RemoteRecord,
  ): Promise<boolean> {
    if (!rec.snapshot) {
      await this.connections.log(
        c,
        'warn',
        rec.unsupported?.startsWith('recurrence') ? 'unsupported_recurrence' : 'import_skipped',
        `Not imported: ${rec.unsupported ?? 'unreadable'}.`,
        {
          detail: { remoteId: rec.id, reason: rec.unsupported ?? null },
        },
      );
      return false;
    }
    const s = rec.snapshot;
    if (s.status === 'cancelled' || !s.time) return false;
    // An import interrupted before its link was saved left a meeting carrying this record's id
    // (unique per connection): link that one instead of importing the record twice.
    const [earlier] = await this.db
      .select({ id: meetings.id })
      .from(meetings)
      .where(and(eq(meetings.sourceConnectionId, c.id), eq(meetings.externalId, rec.id)));
    if (earlier) return this.linkImported(c, owner, p, rec, earlier.id);
    const parsed = meetingCreateSchema.safeParse({
      kind: 'standard',
      title: s.title?.trim() || 'Untitled meeting',
      description: s.description ?? null,
      notes: s.notes ?? null,
      teamId: c.teamId,
      start: s.time.startLocal,
      end: s.time.endLocal,
      timeZone: s.time.timeZone,
      recurrence: s.recurrence ?? null,
      participantUserIds: [],
      reminderMinutes: [15],
    });
    if (!parsed.success) {
      await this.connections.log(
        c,
        'warn',
        'import_skipped',
        'Not imported: the record is not a valid meeting.',
        {
          detail: { remoteId: rec.id, issues: parsed.error.issues.map((i) => i.message) },
        },
      );
      return false;
    }
    let meetingId: string;
    try {
      const dto = await this.meetings.create(owner, parsed.data, {
        ...this.via(c),
        source: c.provider as 'google_calendar' | 'notion',
        sourceConnectionId: c.id,
        externalId: rec.id,
      });
      meetingId = dto.id;
      for (const x of s.exdates ?? [])
        await this.meetings.cancelOccurrence(owner, meetingId, x, this.via(c)).catch(() => null);
    } catch (e) {
      if (e instanceof AppError) {
        await this.connections.log(c, 'warn', 'import_skipped', `Not imported: ${e.code}.`, {
          detail: { remoteId: rec.id, code: e.code },
        });
        return false;
      }
      throw e;
    }
    return this.linkImported(c, owner, p, rec, meetingId);
  }

  /** Links an imported meeting to its record and writes the meeting's id back to it. */
  private async linkImported(
    c: ConnectionRow,
    owner: TenantContext,
    p: RemoteProvider,
    rec: RemoteRecord,
    meetingId: string,
  ): Promise<boolean> {
    const l = (await this.meetings.load(c.organizationId, meetingId))!;
    await this.db
      .insert(integrationLinks)
      .values({
        organizationId: c.organizationId,
        connectionId: c.id,
        meetingId,
        state: 'pending_create',
      })
      .onConflictDoNothing();
    const link = (await this.link(c, meetingId))!;
    // Write back so the record carries the meeting's id from now on.
    const local = this.localSnapshot(c, l, owner);
    const written = await p.update(c, { ...link, remoteId: rec.id }, this.view(c, l, owner, local));
    await this.saveLink(link, written, local, l.row.version);
    await this.connections.log(c, 'info', 'imported', `Imported "${l.row.title}" as a meeting.`, {
      meetingId,
    });
    return true;
  }

  /** Merge a provider change into a linked meeting (see sync-engine.ts for the rules). */
  private async reconcile(
    c: ConnectionRow,
    owner: TenantContext,
    link: LinkRow,
    l: LoadedMeeting,
    rec: RemoteRecord,
  ): Promise<void> {
    const p = this.provider(c);
    const local = this.localSnapshot(c, l, owner);
    const base = link.syncedSnapshot as Snapshot | null;
    if (!rec.snapshot) {
      // The provider's version can't be read as a meeting (e.g. a repeat rule the platform
      // can't express): the platform's version is written back.
      await this.connections.log(
        c,
        'warn',
        rec.unsupported?.startsWith('recurrence')
          ? 'unsupported_recurrence'
          : 'remote_change_rejected',
        `A change at the provider could not be applied (${rec.unsupported ?? 'unreadable'}); the platform's version was restored.`,
        { meetingId: l.row.id, detail: { reason: rec.unsupported ?? null } },
      );
      const written = await p.update(
        c,
        { ...link, remoteVersion: rec.version },
        this.view(c, l, owner, local),
      );
      await this.saveLink(link, written, local, l.row.version);
      return;
    }
    const remote = this.remoteSnapshot(p, rec, base, local);
    const merge = threeWayMerge(base, local, remote, ALL_KEYS);
    let current = l;
    const changedFields = Object.keys(merge.applyLocally);
    if (changedFields.length) {
      const result = await this.applyLocally(c, owner, l, merge.applyLocally);
      if (result.ok) {
        current = (await this.meetings.load(c.organizationId, l.row.id))!;
        await this.connections.log(
          c,
          'info',
          'pulled',
          `Applied a change from the provider: ${changedFields.join(', ')}.`,
          {
            meetingId: l.row.id,
            detail: { fields: changedFields },
          },
        );
      } else {
        await this.connections.log(
          c,
          'warn',
          'remote_change_rejected',
          `A change at the provider was not applied (${result.reason}); the platform's version was restored.`,
          { meetingId: l.row.id, detail: { fields: changedFields, reason: result.reason } },
        );
      }
    }
    if (merge.conflicts.length) {
      await this.connections.log(
        c,
        'warn',
        'conflict_resolved',
        `Changed on both sides: ${merge.conflicts.map((x) => x.field).join(', ')}. The platform's version was kept and written back.`,
        {
          meetingId: l.row.id,
          detail: {
            rule: 'platform_wins',
            conflicts: merge.conflicts.map((x) => ({
              field: x.field,
              platform: short(x.platform),
              provider: short(x.provider),
            })),
          },
        },
      );
      await this.connections.notifyConflict(
        c,
        l.row.id,
        l.row.title,
        merge.conflicts.map((x) => x.field),
      );
    }
    const final = this.localSnapshot(c, current, owner);
    let latest = rec;
    // Conditional on the version we just read (a change in between → 412 → merged again).
    if (!same(final, remote))
      latest = await p.update(
        c,
        { ...link, remoteVersion: rec.version },
        this.view(c, current, owner, final),
      );
    await this.saveLink(link, latest, final, current.row.version);
  }

  /** Applies provider-only changes as the connection's owner (their permissions, audited). */
  private async applyLocally(
    c: ConnectionRow,
    owner: TenantContext,
    l: LoadedMeeting,
    changes: Partial<Snapshot>,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const id = l.row.id;
    try {
      if (changes.status === 'cancelled') {
        await this.meetings.cancel(owner, id, null, this.via(c));
        return { ok: true };
      }
      if (changes.status === 'scheduled')
        return { ok: false, reason: 'cancelled_meetings_are_final' };
      const input: MeetingUpdateInput = {};
      if (changes.title !== undefined) input.title = changes.title || l.row.title;
      if (changes.description !== undefined) input.description = changes.description;
      if (changes.notes !== undefined) input.notes = changes.notes;
      if (changes.time) {
        input.start = changes.time.startLocal;
        input.end = changes.time.endLocal;
        input.timeZone = changes.time.timeZone;
      }
      if (changes.recurrence !== undefined) input.recurrence = changes.recurrence;
      if (Object.keys(input).length) await this.meetings.update(owner, id, input, this.via(c));
      if (changes.exdates) {
        const had = new Set(
          l.overrides
            .filter((o) => o.status === 'cancelled')
            .map((o) => o.originalStart.toISOString()),
        );
        for (const x of changes.exdates.filter((d) => !had.has(d)))
          await this.meetings.cancelOccurrence(owner, id, x, this.via(c));
      }
      return { ok: true };
    } catch (e) {
      if (e instanceof AppError) return { ok: false, reason: e.code };
      throw e;
    }
  }

  /** The record was deleted at the provider. */
  private async remoteDeleted(
    c: ConnectionRow,
    owner: TenantContext,
    link: LinkRow,
    l: LoadedMeeting,
  ) {
    const p = this.provider(c);
    const isOrganizer = l.row.organizerUserId === owner.user.id;
    const isInvited = l.participants.some((x) => x.userId === owner.user.id);
    if (l.row.status === 'cancelled') {
      await this.unlink(link);
      return;
    }
    // Deleting a meeting you organize cancels it (as calendar apps do), if you may change it.
    if (isOrganizer || !c.personal) {
      const r = await this.applyLocally(c, owner, l, { status: 'cancelled' });
      if (r.ok) {
        await this.unlink(link);
        await this.connections.log(
          c,
          'info',
          'pulled',
          'Deleted at the provider: the meeting was cancelled.',
          { meetingId: l.row.id },
        );
        return;
      }
    }
    if (c.personal && isInvited && !isOrganizer) {
      // Removing an invitation from your own calendar declines it.
      try {
        await this.meetings.respond(owner, l.row.id, { response: 'declined' }, this.via(c));
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
      }
      await this.unlink(link);
      await this.connections.log(
        c,
        'info',
        'pulled',
        'Removed from the calendar: the invitation was declined.',
        { meetingId: l.row.id },
      );
      return;
    }
    // Not allowed to cancel it: restore the record (the platform wins).
    await this.unlink(link);
    await this.connections.log(
      c,
      'warn',
      'remote_change_rejected',
      'Deleted at the provider without permission to cancel the meeting; it was restored.',
      {
        meetingId: l.row.id,
      },
    );
    const fresh = (await this.link(c, l.row.id))!;
    const local = this.localSnapshot(c, l, owner);
    const rec = await p.create(c, this.view(c, l, owner, local));
    await this.saveLink(fresh, rec, local, l.row.version);
  }

  /** Google: one occurrence of a recurring event was cancelled or moved there. */
  private async instanceChanged(
    c: ConnectionRow,
    owner: TenantContext,
    rec: RemoteRecord,
  ): Promise<boolean> {
    const inst = rec.instanceOf!;
    const [link] = await this.db
      .select()
      .from(integrationLinks)
      .where(
        and(eq(integrationLinks.connectionId, c.id), eq(integrationLinks.remoteId, inst.remoteId)),
      );
    if (!link || link.state !== 'active') return false;
    const l = await this.meetings.load(c.organizationId, link.meetingId);
    if (!l || l.row.status === 'cancelled') return false;
    const override = l.overrides.find((o) => o.originalStart.toISOString() === inst.originalStart);
    try {
      if (inst.cancelled) {
        if (override?.status === 'cancelled') return false;
        await this.meetings.cancelOccurrence(owner, l.row.id, inst.originalStart, this.via(c));
        await this.connections.log(
          c,
          'info',
          'pulled',
          'One occurrence was cancelled at the provider.',
          { meetingId: l.row.id },
        );
        return true;
      }
      if (!inst.startLocal || !inst.endLocal) return false;
      const start = localToUtc(parseLocal(inst.startLocal)!, l.row.timeZone);
      const end = localToUtc(parseLocal(inst.endLocal)!, l.row.timeZone);
      const currentStart =
        override?.status === 'moved' ? override.startAt!.getTime() : Date.parse(inst.originalStart);
      const currentEnd =
        override?.status === 'moved'
          ? override.endAt!.getTime()
          : Date.parse(inst.originalStart) + l.row.durationMinutes * 60000;
      if (start === currentStart && end === currentEnd) return false;
      await this.meetings.moveOccurrence(
        owner,
        l.row.id,
        { originalStart: inst.originalStart, start: inst.startLocal, end: inst.endLocal },
        this.via(c),
      );
      await this.connections.log(c, 'info', 'pulled', 'One occurrence was moved at the provider.', {
        meetingId: l.row.id,
      });
      return true;
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      await this.connections.log(
        c,
        'warn',
        'remote_change_ignored',
        `A change to one occurrence was not applied (${e.code}).`,
        {
          meetingId: l.row.id,
        },
      );
      return false;
    }
  }

  // ---------------------------------------------------------------- full sync

  /** Queues a push for every meeting the connection carries or holds, then pulls everything. */
  async fullSync(c: ConnectionRow): Promise<void> {
    const owner = await this.owner(c);
    const candidates = await this.db
      .select({ id: meetings.id })
      .from(meetings)
      .where(
        and(
          eq(meetings.organizationId, c.organizationId),
          ne(meetings.status, 'cancelled'),
          gt(meetings.seriesEndsAt, new Date(this.now() - 30 * 86_400_000)),
        ),
      );
    const linked = await this.db
      .select({ id: integrationLinks.meetingId })
      .from(integrationLinks)
      .where(and(eq(integrationLinks.connectionId, c.id), eq(integrationLinks.state, 'active')));
    const ids = new Set(linked.map((x) => x.id));
    for (const { id } of candidates) {
      const l = await this.meetings.load(c.organizationId, id);
      if (l && this.carries(c, l, owner)) ids.add(id);
    }
    for (const id of ids)
      await this.jobs.enqueue({
        organizationId: c.organizationId,
        connectionId: c.id,
        kind: 'push_meeting',
        meetingId: id,
        dedupeKey: `push:${id}`,
      });
    if (c.direction === 'two_way') await this.pull(c, { full: true });
  }
}
