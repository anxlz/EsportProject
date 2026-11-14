/**
 * Tournament research — manual entry only (brief §6.5: no scraping, no paid API). Every record
 * carries a source link and a "last verified" date so users can judge how fresh it is.
 */
import { Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type TournamentDto, type TournamentInput, tournamentInputSchema } from '@esports/shared';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import { RequirePermission, type TenantContext, TenantCtx } from '../authz/context.js';
import { Errors } from '../common/errors.js';
import { UuidPipe, ZodBody } from '../common/zod.js';
import { DB, type Database, type DbOrTx } from '../db/client.js';
import { games, teams } from '../db/schema.js';
import { tournaments, tournamentTeams } from '../db/schema-finance.js';

const strip = (v: string | null) =>
  v === null ? null : v.includes('.') ? v.replace(/\.?0+$/, '') : v;

/** Tournament records of an organization (callers check `tournaments.view` first). */
export async function listTournaments(
  db: DbOrTx,
  organizationId: string,
  id?: string,
): Promise<TournamentDto[]> {
  const rows = await db
    .select({ t: tournaments, gameName: games.name })
    .from(tournaments)
    .leftJoin(games, eq(games.id, tournaments.gameId))
    .where(
      and(eq(tournaments.organizationId, organizationId), id ? eq(tournaments.id, id) : undefined),
    )
    .orderBy(sql`${tournaments.startDate} desc nulls last`, desc(tournaments.createdAt));
  const ids = rows.map((r) => r.t.id);
  const links = ids.length
    ? await db
        .select({ tournamentId: tournamentTeams.tournamentId, id: teams.id, name: teams.name })
        .from(tournamentTeams)
        .innerJoin(teams, eq(teams.id, tournamentTeams.teamId))
        .where(inArray(tournamentTeams.tournamentId, ids))
        .orderBy(asc(teams.name))
    : [];
  return rows.map(({ t, gameName }) => ({
    id: t.id,
    name: t.name,
    organizer: t.organizer,
    gameId: t.gameId,
    gameName,
    region: t.region,
    startDate: t.startDate,
    endDate: t.endDate,
    status: t.status as TournamentDto['status'],
    eligibility: t.eligibility,
    qualification: t.qualification,
    entryFeeAmount: strip(t.entryFeeAmount),
    entryFeeCurrency: t.entryFeeCurrency,
    prizePoolAmount: strip(t.prizePoolAmount),
    prizePoolCurrency: t.prizePoolCurrency,
    placementRewards: t.placementRewards,
    travelRequirements: t.travelRequirements,
    historicalResults: t.historicalResults,
    sponsorCoverage: t.sponsorCoverage,
    sourceUrl: t.sourceUrl,
    lastVerifiedOn: t.lastVerifiedOn,
    notes: t.notes,
    teams: links
      .filter((l) => l.tournamentId === t.id)
      .map(({ id: tid, name }) => ({ id: tid, name })),
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  }));
}

@ApiTags('tournaments')
@Controller('tournaments')
export class TournamentsController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  private listFor(organizationId: string, id?: string): Promise<TournamentDto[]> {
    return listTournaments(this.db, organizationId, id);
  }

  private async getOne(organizationId: string, id: string) {
    const [t] = await this.listFor(organizationId, id);
    if (!t) throw Errors.notFound('Tournament');
    return t;
  }

  private async validate(tx: DbOrTx, organizationId: string, input: TournamentInput) {
    if (input.gameId) {
      const [g] = await tx
        .select({ id: games.id })
        .from(games)
        .where(and(eq(games.id, input.gameId), eq(games.organizationId, organizationId)));
      if (!g) throw Errors.badRequest('validation_failed', 'Unknown game');
    }
    const teamIds = [...new Set(input.teamIds ?? [])];
    if (teamIds.length) {
      const found = await tx
        .select({ id: teams.id })
        .from(teams)
        .where(and(eq(teams.organizationId, organizationId), inArray(teams.id, teamIds)));
      if (found.length !== teamIds.length) throw Errors.badRequest('invalid_scope', 'Unknown team');
    }
    return teamIds;
  }

  private values(input: TournamentInput) {
    return {
      name: input.name,
      organizer: input.organizer ?? null,
      gameId: input.gameId ?? null,
      region: input.region ?? null,
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
      status: input.status,
      eligibility: input.eligibility ?? null,
      qualification: input.qualification ?? null,
      entryFeeAmount: input.entryFeeAmount ?? null,
      entryFeeCurrency: input.entryFeeAmount ? (input.entryFeeCurrency ?? null) : null,
      prizePoolAmount: input.prizePoolAmount ?? null,
      prizePoolCurrency: input.prizePoolAmount ? (input.prizePoolCurrency ?? null) : null,
      placementRewards: input.placementRewards ?? [],
      travelRequirements: input.travelRequirements ?? null,
      historicalResults: input.historicalResults ?? null,
      sponsorCoverage: input.sponsorCoverage ?? null,
      sourceUrl: input.sourceUrl ?? null,
      lastVerifiedOn: input.lastVerifiedOn ?? null,
      notes: input.notes ?? null,
    };
  }

  @Get()
  @RequirePermission('tournaments.view')
  list(@TenantCtx() ctx: TenantContext) {
    return this.listFor(ctx.organizationId);
  }

  @Get(':id')
  @RequirePermission('tournaments.view')
  get(@TenantCtx() ctx: TenantContext, @Param('id', UuidPipe) id: string) {
    return this.getOne(ctx.organizationId, id);
  }

  @Post()
  @RequirePermission('tournaments.create')
  async create(
    @TenantCtx() ctx: TenantContext,
    @ZodBody(tournamentInputSchema) body: TournamentInput,
  ) {
    const id = await this.db.transaction(async (tx) => {
      const teamIds = await this.validate(tx, ctx.organizationId, body);
      const [t] = await tx
        .insert(tournaments)
        .values({
          organizationId: ctx.organizationId,
          ...this.values(body),
          createdByUserId: ctx.user.id,
        })
        .returning({ id: tournaments.id });
      if (teamIds.length) {
        await tx.insert(tournamentTeams).values(
          teamIds.map((teamId) => ({
            organizationId: ctx.organizationId,
            tournamentId: t!.id,
            teamId,
          })),
        );
      }
      await this.audit.fromCtx(
        ctx,
        'tournament.created',
        { type: 'tournament', id: t!.id },
        { name: body.name, sourceUrl: body.sourceUrl ?? null },
        tx,
      );
      return t!.id;
    });
    return this.getOne(ctx.organizationId, id);
  }

  @Patch(':id')
  @RequirePermission('tournaments.edit')
  async update(
    @TenantCtx() ctx: TenantContext,
    @Param('id', UuidPipe) id: string,
    @ZodBody(tournamentInputSchema) body: TournamentInput,
  ) {
    const before = await this.getOne(ctx.organizationId, id);
    await this.db.transaction(async (tx) => {
      const teamIds = await this.validate(tx, ctx.organizationId, body);
      await tx
        .update(tournaments)
        .set({ ...this.values(body), updatedAt: new Date() })
        .where(eq(tournaments.id, id));
      if (body.teamIds !== undefined) {
        await tx.delete(tournamentTeams).where(eq(tournamentTeams.tournamentId, id));
        if (teamIds.length) {
          await tx.insert(tournamentTeams).values(
            teamIds.map((teamId) => ({
              organizationId: ctx.organizationId,
              tournamentId: id,
              teamId,
            })),
          );
        }
      }
      await this.audit.fromCtx(
        ctx,
        'tournament.updated',
        { type: 'tournament', id },
        {
          before: {
            name: before.name,
            status: before.status,
            lastVerifiedOn: before.lastVerifiedOn,
          },
          after: {
            name: body.name,
            status: body.status,
            lastVerifiedOn: body.lastVerifiedOn ?? null,
          },
        },
        tx,
      );
    });
    return this.getOne(ctx.organizationId, id);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('tournaments.delete')
  async remove(@TenantCtx() ctx: TenantContext, @Param('id', UuidPipe) id: string) {
    const t = await this.getOne(ctx.organizationId, id);
    // Finance entries or budgets linked to it block deletion (FK restrict → 409 in_use).
    await this.db.transaction(async (tx) => {
      await tx
        .delete(tournaments)
        .where(and(eq(tournaments.id, id), eq(tournaments.organizationId, ctx.organizationId)));
      await this.audit.fromCtx(
        ctx,
        'tournament.deleted',
        { type: 'tournament', id },
        { name: t.name },
        tx,
      );
    });
  }
}
