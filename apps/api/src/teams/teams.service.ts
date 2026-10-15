/**
 * Teams — the first scopable resource, and the reference implementation for every later one:
 *
 *   list   → permission gate (guard) + scopeCondition() in the WHERE clause
 *   read   → not covered by `teams.view`  ⇒ 404 (don't reveal it exists)
 *   write  → visible but not covered by the write permission ⇒ 403
 *   create/move into a department ⇒ the department must be covered by the permission's scope
 */
import { Inject, Injectable } from '@nestjs/common';
import type { PermissionKey, TeamCreateInput, TeamDto } from '@esports/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { teamUpdateSchema } from '@esports/shared';
import { AccessService } from '../authz/access.service';
import type { TenantContext } from '../authz/context';
import { scopeCondition } from '../authz/scope-filter';
import { AuditService } from '../audit/audit.service';
import { Errors } from '../common/errors';
import { DB, type Database } from '../db/client';
import { departments, games, teams } from '../db/schema';

type TeamUpdateInput = z.infer<typeof teamUpdateSchema>;

@Injectable()
export class TeamsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly access: AccessService,
  ) {}

  private baseQuery() {
    return this.db
      .select({ t: teams, departmentName: departments.name, gameName: games.name })
      .from(teams)
      .leftJoin(departments, eq(departments.id, teams.departmentId))
      .leftJoin(games, eq(games.id, teams.gameId));
  }

  private toDto(r: {
    t: typeof teams.$inferSelect;
    departmentName: string | null;
    gameName: string | null;
  }): TeamDto {
    return {
      id: r.t.id,
      name: r.t.name,
      departmentId: r.t.departmentId,
      departmentName: r.departmentName,
      gameId: r.t.gameId,
      gameName: r.gameName,
      region: r.t.region,
      status: r.t.status,
      createdAt: r.t.createdAt.toISOString(),
      updatedAt: r.t.updatedAt.toISOString(),
    };
  }

  async list(ctx: TenantContext, perm: PermissionKey = 'teams.view'): Promise<TeamDto[]> {
    const rows = await this.baseQuery()
      .where(
        and(
          eq(teams.organizationId, ctx.organizationId),
          scopeCondition(ctx.access.scope(perm), {
            teamId: teams.id,
            departmentId: teams.departmentId,
          }),
        ),
      )
      .orderBy(asc(teams.name));
    return rows.map((r) => this.toDto(r));
  }

  /** Loads a team the caller can SEE (teams.view), else 404. */
  async getVisible(ctx: TenantContext, id: string): Promise<TeamDto> {
    const [row] = await this.baseQuery().where(
      and(eq(teams.id, id), eq(teams.organizationId, ctx.organizationId)),
    );
    if (
      !row ||
      !ctx.access.coversTeam('teams.view', { id: row.t.id, departmentId: row.t.departmentId })
    ) {
      throw Errors.notFound('Team');
    }
    return this.toDto(row);
  }

  private async assertRefs(
    organizationId: string,
    departmentId?: string | null,
    gameId?: string | null,
  ) {
    if (departmentId) {
      const [d] = await this.db
        .select({ id: departments.id })
        .from(departments)
        .where(
          and(eq(departments.id, departmentId), eq(departments.organizationId, organizationId)),
        );
      if (!d) throw Errors.badRequest('invalid_scope', 'Unknown department');
    }
    if (gameId) {
      const [g] = await this.db
        .select({ id: games.id })
        .from(games)
        .where(and(eq(games.id, gameId), eq(games.organizationId, organizationId)));
      if (!g) throw Errors.badRequest('validation_failed', 'Unknown game');
    }
  }

  private async assertNameFree(organizationId: string, name: string, exceptId?: string) {
    const [clash] = await this.db
      .select({ id: teams.id })
      .from(teams)
      .where(
        and(eq(teams.organizationId, organizationId), sql`lower(${teams.name}) = lower(${name})`),
      );
    if (clash && clash.id !== exceptId)
      throw Errors.conflict('conflict', 'A team with this name exists');
  }

  async create(ctx: TenantContext, input: TeamCreateInput): Promise<TeamDto> {
    const departmentId = input.departmentId ?? null;
    if (!ctx.access.coversDepartment('teams.create', departmentId)) throw Errors.forbidden();
    await this.assertRefs(ctx.organizationId, departmentId, input.gameId);
    await this.assertNameFree(ctx.organizationId, input.name);
    const id = await this.db.transaction(async (tx) => {
      const [t] = await tx
        .insert(teams)
        .values({
          organizationId: ctx.organizationId,
          name: input.name,
          departmentId,
          gameId: input.gameId ?? null,
          region: input.region ?? null,
          status: input.status,
        })
        .returning({ id: teams.id });
      await this.audit.fromCtx(
        ctx,
        'team.created',
        { type: 'team', id: t!.id },
        { name: input.name, departmentId },
        tx,
      );
      return t!.id;
    });
    return this.getVisibleOrRaw(ctx, id);
  }

  /** After create, the creator may lack teams.view on it; return the row regardless. */
  private async getVisibleOrRaw(ctx: TenantContext, id: string): Promise<TeamDto> {
    const [row] = await this.baseQuery().where(
      and(eq(teams.id, id), eq(teams.organizationId, ctx.organizationId)),
    );
    return this.toDto(row!);
  }

  async update(ctx: TenantContext, id: string, input: TeamUpdateInput): Promise<TeamDto> {
    const before = await this.getVisible(ctx, id);
    if (!ctx.access.coversTeam('teams.edit', { id, departmentId: before.departmentId }))
      throw Errors.forbidden();
    if (input.departmentId !== undefined && input.departmentId !== before.departmentId) {
      // Moving a team requires edit coverage of the destination as well.
      if (!ctx.access.coversDepartment('teams.edit', input.departmentId)) throw Errors.forbidden();
    }
    await this.assertRefs(ctx.organizationId, input.departmentId, input.gameId);
    if (input.name) await this.assertNameFree(ctx.organizationId, input.name, id);

    await this.db.transaction(async (tx) => {
      await tx
        .update(teams)
        .set({ ...input, updatedAt: new Date() })
        .where(and(eq(teams.id, id), eq(teams.organizationId, ctx.organizationId)));
      await this.audit.fromCtx(
        ctx,
        'team.updated',
        { type: 'team', id },
        {
          changes: input,
          before: {
            name: before.name,
            departmentId: before.departmentId,
            gameId: before.gameId,
            status: before.status,
          },
        },
        tx,
      );
    });
    return this.getVisibleOrRaw(ctx, id);
  }

  async remove(ctx: TenantContext, id: string): Promise<void> {
    const team = await this.getVisible(ctx, id);
    if (!ctx.access.coversTeam('teams.delete', { id, departmentId: team.departmentId }))
      throw Errors.forbidden();
    await this.db.transaction(async (tx) => {
      // Team-scoped role assignments cascade with the team.
      await tx
        .delete(teams)
        .where(and(eq(teams.id, id), eq(teams.organizationId, ctx.organizationId)));
      await this.audit.fromCtx(ctx, 'team.deleted', { type: 'team', id }, { name: team.name }, tx);
    });
    await this.access.invalidate(ctx.organizationId);
  }
}
