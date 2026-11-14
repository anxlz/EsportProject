import { Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type GameDto, gameInputSchema, gameUpdateSchema } from '@esports/shared';
import { and, asc, count, eq, max, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { RequirePermission, type TenantContext, TenantCtx } from '../authz/context.js';
import { Errors } from '../common/errors.js';
import { UuidPipe, ZodBody } from '../common/zod.js';
import { DB, type Database } from '../db/client.js';
import { games, teams } from '../db/schema.js';

/** Games are a configurable per-organization entity (seeded with common titles). */
@ApiTags('games')
@Controller('games')
export class GamesController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  private async listFor(organizationId: string, id?: string): Promise<GameDto[]> {
    const rows = await this.db
      .select({ g: games, teamCount: count(teams.id) })
      .from(games)
      .leftJoin(teams, eq(teams.gameId, games.id))
      .where(and(eq(games.organizationId, organizationId), id ? eq(games.id, id) : undefined))
      .groupBy(games.id)
      .orderBy(asc(games.sortOrder), asc(games.name));
    return rows.map(({ g, teamCount }) => ({
      id: g.id,
      name: g.name,
      shortName: g.shortName,
      isActive: g.isActive,
      teamCount,
    }));
  }

  private async getOne(organizationId: string, id: string): Promise<GameDto> {
    const [g] = await this.listFor(organizationId, id);
    if (!g) throw Errors.notFound('Game');
    return g;
  }

  private async assertNameFree(organizationId: string, name: string, exceptId?: string) {
    const [clash] = await this.db
      .select({ id: games.id })
      .from(games)
      .where(
        and(eq(games.organizationId, organizationId), sql`lower(${games.name}) = lower(${name})`),
      );
    if (clash && clash.id !== exceptId)
      throw Errors.conflict('conflict', 'A game with this name exists');
  }

  @Get()
  @RequirePermission('games.view')
  list(@TenantCtx() ctx: TenantContext) {
    return this.listFor(ctx.organizationId);
  }

  @Post()
  @RequirePermission('games.manage')
  async create(
    @TenantCtx() ctx: TenantContext,
    @ZodBody(gameInputSchema) body: z.infer<typeof gameInputSchema>,
  ) {
    await this.assertNameFree(ctx.organizationId, body.name);
    const id = await this.db.transaction(async (tx) => {
      const [top] = await tx
        .select({ m: max(games.sortOrder) })
        .from(games)
        .where(eq(games.organizationId, ctx.organizationId));
      const [g] = await tx
        .insert(games)
        .values({
          organizationId: ctx.organizationId,
          name: body.name,
          shortName: body.shortName ?? null,
          isActive: body.isActive,
          sortOrder: (top?.m ?? 0) + 1,
        })
        .returning({ id: games.id });
      await this.audit.fromCtx(
        ctx,
        'game.created',
        { type: 'game', id: g!.id },
        { name: body.name },
        tx,
      );
      return g!.id;
    });
    return this.getOne(ctx.organizationId, id);
  }

  @Patch(':id')
  @RequirePermission('games.manage')
  async update(
    @TenantCtx() ctx: TenantContext,
    @Param('id', UuidPipe) id: string,
    @ZodBody(gameUpdateSchema) body: z.infer<typeof gameUpdateSchema>,
  ) {
    const before = await this.getOne(ctx.organizationId, id);
    if (body.name) await this.assertNameFree(ctx.organizationId, body.name, id);
    await this.db.transaction(async (tx) => {
      await tx
        .update(games)
        .set({ ...body, updatedAt: new Date() })
        .where(and(eq(games.id, id), eq(games.organizationId, ctx.organizationId)));
      await this.audit.fromCtx(
        ctx,
        'game.updated',
        { type: 'game', id },
        { before, changes: body },
        tx,
      );
    });
    return this.getOne(ctx.organizationId, id);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('games.manage')
  async remove(@TenantCtx() ctx: TenantContext, @Param('id', UuidPipe) id: string) {
    const g = await this.getOne(ctx.organizationId, id);
    if (g.teamCount > 0)
      throw Errors.conflict('game_in_use', 'Teams use this game; deactivate it instead');
    await this.db.transaction(async (tx) => {
      await tx
        .delete(games)
        .where(and(eq(games.id, id), eq(games.organizationId, ctx.organizationId)));
      await this.audit.fromCtx(ctx, 'game.deleted', { type: 'game', id }, { name: g.name }, tx);
    });
  }
}
