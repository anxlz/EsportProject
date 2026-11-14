/**
 * Obsidian vault sync (see obsidian-note.ts for why it's file-based). Per member:
 *
 * - The member creates a vault-sync token in Settings → Integrations (shown once, stored as a
 *   SHA-256 hash) and runs `scripts/obsidian-vault-sync.mjs` on their computer, pointed at their
 *   vault. The platform never reaches into their computer; the script calls us.
 * - GET feed: every meeting the member is invited to (within the team filter), with the note's
 *   content when it changed since the script's cursor, and removals.
 * - POST push (two-way only): notes the member edited. The editable fields are merged with the
 *   same three-way rules as the other integrations, using the note as last served as the base.
 *   If the note was written from an older version than the platform last sent, there's no
 *   reliable base, so differing fields count as conflicts and the platform's version is kept —
 *   the script then keeps the member's text in a conflict copy, so nothing they wrote is lost.
 */
import { Inject, Injectable } from '@nestjs/common';
import type {
  ObsidianConnectInput,
  ObsidianFeedDto,
  ObsidianPushInput,
  ObsidianPushResultDto,
  SyncDirection,
} from '@esports/shared';
import { occurrencesBetween } from '@esports/shared';
import { and, eq, gt, inArray } from 'drizzle-orm';
import type { TenantContext } from '../authz/context';
import { AuditService } from '../audit/audit.service';
import { randomToken, sha256 } from '../common/crypto';
import { AppError } from '../common/errors';
import { NOW, type Now } from '../common/now';
import { DB, type Database } from '../db/client';
import {
  integrationConnections,
  integrationLinks,
  meetingParticipants,
  meetings,
} from '../db/schema-meetings';
import { type LoadedMeeting, MeetingsService } from '../meetings/meetings.service';
import { type ConnectionRow, ConnectionsService } from './connections.service';
import { notePath, parseNote, renderNote } from './obsidian-note';
import { RemoteSyncService } from './remote-sync.service';
import { parseSnapshot, type Snapshot, threeWayMerge } from './sync-engine';

const TOKEN_PREFIX = 'obs_';
const HORIZON_MS = 90 * 86_400_000;

@Injectable()
export class ObsidianService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(NOW) private readonly now: Now,
    private readonly connections: ConnectionsService,
    private readonly meetings: MeetingsService,
    private readonly sync: RemoteSyncService,
    private readonly audit: AuditService,
  ) {}

  async connect(ctx: TenantContext, input: ObsidianConnectInput) {
    const token = TOKEN_PREFIX + randomToken(32);
    const [c] = await this.db.transaction(async (tx) => {
      const rows = await tx
        .insert(integrationConnections)
        .values({
          organizationId: ctx.organizationId,
          provider: 'obsidian',
          name: 'Obsidian',
          ownerUserId: ctx.user.id,
          personal: true,
          direction: input.direction,
          teamId: input.teamId ?? null,
          tokenHash: sha256(token),
        })
        .returning();
      await this.audit.fromCtx(
        ctx,
        'integration.connected',
        { type: 'integration', id: rows[0]!.id },
        { provider: 'obsidian', direction: input.direction },
        tx,
      );
      return rows;
    });
    await this.connections.log(c!, 'info', 'connected', 'Vault-sync token created.');
    return { connection: c!, token };
  }

  async rotate(c: ConnectionRow) {
    const token = TOKEN_PREFIX + randomToken(32);
    await this.db
      .update(integrationConnections)
      .set({ tokenHash: sha256(token), updatedAt: new Date(this.now()) })
      .where(eq(integrationConnections.id, c.id));
    return token;
  }

  /** The connection behind a bearer token, or 401 (the same answer for every failure). */
  async authenticate(header: string | undefined): Promise<ConnectionRow> {
    const token = /^Bearer\s+(\S+)$/i.exec(header ?? '')?.[1];
    if (!token || !token.startsWith(TOKEN_PREFIX) || token.length > 200)
      throw new AppError('unauthenticated', 401, 'Invalid or revoked token');
    const [c] = await this.db
      .select()
      .from(integrationConnections)
      .where(
        and(
          eq(integrationConnections.tokenHash, sha256(token)),
          eq(integrationConnections.provider, 'obsidian'),
        ),
      );
    if (!c || c.status !== 'active')
      throw new AppError('unauthenticated', 401, 'Invalid or revoked token');
    if (c.paused) throw new AppError('integration_unavailable', 409, 'This integration is paused');
    return c;
  }

  private async owner(c: ConnectionRow) {
    const owner = await this.connections.ownerCtx(c);
    if (!owner) throw new AppError('unauthenticated', 401, 'Invalid or revoked token');
    return owner;
  }

  private render(l: LoadedMeeting, owner: TenantContext) {
    const upcoming = occurrencesBetween(
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
      this.now(),
      Number.MAX_SAFE_INTEGER,
    )
      .slice(0, 5)
      .map((o) => ({ start: o.startUtc, cancelled: o.cancelled }));
    return renderNote(l, { locale: owner.user.locale === 'ar' ? 'ar' : 'en', upcoming });
  }

  /** A single note, for the "download for Obsidian" button. */
  async note(ctx: TenantContext, meetingId: string) {
    const l = await this.meetings.visible(ctx, meetingId);
    return { path: notePath(l), content: this.render(l, ctx) };
  }

  async feed(c: ConnectionRow, since: string | undefined): Promise<ObsidianFeedDto> {
    const owner = await this.owner(c);
    let sinceMs = 0;
    if (since) {
      try {
        sinceMs =
          Date.parse(
            (JSON.parse(Buffer.from(since, 'base64url').toString('utf8')) as { at: string }).at,
          ) || 0;
      } catch {
        sinceMs = 0;
      }
    }
    // Meetings the member is invited to, still relevant (or already in the vault).
    const invited = await this.db
      .select({ id: meetings.id })
      .from(meetings)
      .innerJoin(meetingParticipants, eq(meetingParticipants.meetingId, meetings.id))
      .where(
        and(
          eq(meetings.organizationId, c.organizationId),
          eq(meetingParticipants.userId, c.ownerUserId),
          gt(meetings.seriesEndsAt, new Date(this.now() - HORIZON_MS)),
        ),
      );
    const links = await this.db
      .select()
      .from(integrationLinks)
      .where(and(eq(integrationLinks.connectionId, c.id), eq(integrationLinks.state, 'active')));
    const ids = new Set([...invited.map((x) => x.id), ...links.map((x) => x.meetingId)]);
    const notes: ObsidianFeedDto['notes'] = [];
    let latest = sinceMs;
    for (const id of ids) {
      const l = await this.meetings.load(c.organizationId, id);
      const link = links.find((x) => x.meetingId === id);
      if (!l || !this.connections.carries(c, l, owner, this.meetings)) {
        if (link) {
          await this.db
            .update(integrationLinks)
            .set({ state: 'unlinked', updatedAt: new Date(this.now()) })
            .where(eq(integrationLinks.id, link.id));
          notes.push({
            meetingId: id,
            path: link.remoteId ?? '',
            version: link.localVersion ?? 0,
            deleted: true,
            content: null,
          });
        }
        continue;
      }
      latest = Math.max(latest, l.row.updatedAt.getTime());
      const path = notePath(l);
      const fresh =
        !link ||
        !since ||
        l.row.updatedAt.getTime() > sinceMs ||
        link.localVersion !== l.row.version ||
        link.remoteId !== path;
      if (!fresh) {
        notes.push({ meetingId: id, path, version: l.row.version, deleted: false, content: null });
        continue;
      }
      const content = this.render(l, owner);
      const snapshot = this.sync.localSnapshot(c, l, owner);
      if (link)
        await this.db
          .update(integrationLinks)
          .set({
            remoteId: path,
            remoteVersion: sha256(content),
            syncedSnapshot: snapshot as never,
            localVersion: l.row.version,
            lastSyncedAt: new Date(this.now()),
            updatedAt: new Date(this.now()),
          })
          .where(eq(integrationLinks.id, link.id));
      else
        await this.db
          .insert(integrationLinks)
          .values({
            organizationId: c.organizationId,
            connectionId: c.id,
            meetingId: id,
            state: 'active',
            remoteId: path,
            remoteVersion: sha256(content),
            syncedSnapshot: snapshot as never,
            localVersion: l.row.version,
            lastSyncedAt: new Date(this.now()),
          })
          .onConflictDoUpdate({
            target: [integrationLinks.connectionId, integrationLinks.meetingId],
            set: {
              state: 'active',
              remoteId: path,
              remoteVersion: sha256(content),
              syncedSnapshot: snapshot as never,
              localVersion: l.row.version,
              lastSyncedAt: new Date(this.now()),
            },
          });
      notes.push({ meetingId: id, path, version: l.row.version, deleted: false, content });
    }
    await this.connections.recordSuccess(c);
    return {
      notes: notes.sort((a, b) => a.path.localeCompare(b.path)),
      cursor: Buffer.from(
        JSON.stringify({ at: new Date(latest || this.now()).toISOString() }),
      ).toString('base64url'),
      direction: c.direction as SyncDirection,
    };
  }

  async push(c: ConnectionRow, input: ObsidianPushInput): Promise<ObsidianPushResultDto> {
    const owner = await this.owner(c);
    const results: ObsidianPushResultDto['results'] = [];
    const ids = [...new Set(input.notes.map((n) => n.meetingId))];
    const links = ids.length
      ? await this.db
          .select()
          .from(integrationLinks)
          .where(
            and(
              eq(integrationLinks.connectionId, c.id),
              inArray(integrationLinks.meetingId, ids),
              eq(integrationLinks.state, 'active'),
            ),
          )
      : [];
    for (const n of input.notes) {
      const l = await this.meetings.load(c.organizationId, n.meetingId);
      if (!l || !this.connections.carries(c, l, owner, this.meetings)) {
        results.push({
          meetingId: n.meetingId,
          outcome: 'not_found',
          content: null,
          version: null,
        });
        continue;
      }
      const render = (x: LoadedMeeting) => ({
        content: this.render(x, owner),
        version: x.row.version,
      });
      if (c.direction !== 'two_way') {
        results.push({
          meetingId: n.meetingId,
          outcome: 'ignored',
          ...render(l),
          message: 'push_only',
        });
        continue;
      }
      const parsed = parseNote(n.content);
      if (parsed.meetingId && parsed.meetingId !== n.meetingId) {
        results.push({
          meetingId: n.meetingId,
          outcome: 'rejected',
          ...render(l),
          message: 'id_mismatch',
        });
        continue;
      }
      const link = links.find((x) => x.meetingId === n.meetingId);
      const local = this.sync.localSnapshot(c, l, owner);
      // The base is the note as last served, but only if this note was written from it.
      const base =
        link && link.localVersion === n.baseVersion ? parseSnapshot(link.syncedSnapshot) : null;
      const remote: Snapshot = {
        ...(base ?? local),
        title: parsed.title ?? (base ?? local).title,
        ...(parsed.description !== undefined ? { description: parsed.description } : {}),
        ...(parsed.notes !== undefined ? { notes: parsed.notes } : {}),
      };
      const merge = threeWayMerge(base, local, remote, ['title', 'description', 'notes']);
      const fields = Object.keys(merge.applyLocally) as ('title' | 'description' | 'notes')[];
      let outcome: ObsidianPushResultDto['results'][number]['outcome'] = merge.conflicts.length
        ? 'conflict'
        : 'unchanged';
      let message: string | undefined;
      let current = l;
      if (fields.length) {
        try {
          await this.meetings.update(
            owner,
            l.row.id,
            Object.fromEntries(
              fields.map((f) => [
                f,
                f === 'title' ? merge.applyLocally[f] || l.row.title : merge.applyLocally[f],
              ]),
            ),
            { via: { provider: 'obsidian', connectionId: c.id } },
          );
          current = (await this.meetings.load(c.organizationId, l.row.id))!;
          if (!merge.conflicts.length) outcome = 'applied';
          await this.connections.log(
            c,
            'info',
            'pulled',
            `Applied an edit from the vault: ${fields.join(', ')}.`,
            { meetingId: l.row.id, detail: { fields } },
          );
        } catch (e) {
          if (!(e instanceof AppError)) throw e;
          outcome = 'rejected';
          message = e.code;
          await this.connections.log(
            c,
            'warn',
            'remote_change_rejected',
            `An edit from the vault was not applied (${e.code}).`,
            { meetingId: l.row.id },
          );
        }
      }
      if (merge.conflicts.length)
        await this.connections.log(
          c,
          'warn',
          'conflict_resolved',
          `Changed in the vault and on the platform: ${merge.conflicts.map((x) => x.field).join(', ')}. The platform's version was kept.`,
          {
            meetingId: l.row.id,
            detail: { rule: 'platform_wins', base: base ? 'served_note' : 'none' },
          },
        );
      const out = render(current);
      const snapshot = this.sync.localSnapshot(c, current, owner);
      await this.db
        .insert(integrationLinks)
        .values({
          organizationId: c.organizationId,
          connectionId: c.id,
          meetingId: current.row.id,
          state: 'active',
          remoteId: notePath(current),
          remoteVersion: sha256(out.content),
          syncedSnapshot: snapshot as never,
          localVersion: current.row.version,
          lastSyncedAt: new Date(this.now()),
        })
        .onConflictDoUpdate({
          target: [integrationLinks.connectionId, integrationLinks.meetingId],
          set: {
            state: 'active',
            remoteId: notePath(current),
            remoteVersion: sha256(out.content),
            syncedSnapshot: snapshot as never,
            localVersion: current.row.version,
            lastSyncedAt: new Date(this.now()),
            updatedAt: new Date(this.now()),
          },
        });
      results.push({ meetingId: n.meetingId, outcome, ...out, ...(message ? { message } : {}) });
    }
    return { results };
  }
}
