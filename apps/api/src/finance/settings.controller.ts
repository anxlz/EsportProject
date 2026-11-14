import { Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  type FinanceSettingsDto,
  type RateQuoteDto,
  rateLookupSchema,
  type SeasonDto,
  seasonInputSchema,
  updateFinanceSettingsSchema,
} from '@esports/shared';
import { and, asc, count, eq, gt, gte, isNull, lt, lte, ne, or } from 'drizzle-orm';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { RequireOrg, RequirePermission, type TenantContext, TenantCtx } from '../authz/context.js';
import { AppError, Errors } from '../common/errors.js';
import { UuidPipe, ZodBody, ZodQuery } from '../common/zod.js';
import { DB, type Database, type DbOrTx } from '../db/client.js';
import { organizations } from '../db/schema.js';
import { budgets, financeEntries, seasons } from '../db/schema-finance.js';
import { BudgetsService } from './budgets.service.js';
import { FxService } from './fx.service.js';

type SeasonInput = z.infer<typeof seasonInputSchema>;

const toSeason = (s: typeof seasons.$inferSelect): SeasonDto => ({
  id: s.id,
  name: s.name,
  startDate: s.startDate,
  endDate: s.endDate,
});

@ApiTags('finance')
@Controller('finance')
export class FinanceSettingsController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly fx: FxService,
    private readonly audit: AuditService,
    private readonly budgets: BudgetsService,
  ) {}

  private async settings(organizationId: string): Promise<FinanceSettingsDto> {
    const [org] = await this.db
      .select()
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    if (!org) throw Errors.notFound('Organization');
    return {
      baseCurrency: org.baseCurrency,
      enabledCurrencies: org.enabledCurrencies,
      baseCurrencyLocked: await this.baseLocked(this.db, organizationId),
      fxProvider: this.fx.providerName,
      fxAttribution:
        this.fx.providerName === 'frankfurter'
          ? { text: 'Frankfurter', url: 'https://frankfurter.dev' }
          : null,
    };
  }

  /** Changing the reporting currency would invalidate every stored conversion. */
  private async baseLocked(db: DbOrTx, organizationId: string): Promise<boolean> {
    const [e] = await db
      .select({ n: count() })
      .from(financeEntries)
      .where(eq(financeEntries.organizationId, organizationId));
    const [b] = await db
      .select({ n: count() })
      .from(budgets)
      .where(eq(budgets.organizationId, organizationId));
    return (e?.n ?? 0) + (b?.n ?? 0) > 0;
  }

  @Get('settings')
  @RequireOrg()
  get(@TenantCtx() ctx: TenantContext) {
    return this.settings(ctx.organizationId);
  }

  @Patch('settings')
  @RequirePermission('finance.configure')
  async update(
    @TenantCtx() ctx: TenantContext,
    @ZodBody(updateFinanceSettingsSchema) body: z.infer<typeof updateFinanceSettingsSchema>,
  ) {
    const before = await this.settings(ctx.organizationId);
    const base = body.baseCurrency ?? before.baseCurrency;
    const enabled = [...new Set(body.enabledCurrencies ?? before.enabledCurrencies)];
    if (!enabled.includes(base)) enabled.unshift(base);
    await this.db.transaction(async (tx) => {
      if (base !== before.baseCurrency && (await this.baseLocked(tx, ctx.organizationId))) {
        throw new AppError(
          'base_currency_locked',
          409,
          'The reporting currency cannot change once finance records exist',
        );
      }
      await tx
        .update(organizations)
        .set({ baseCurrency: base, enabledCurrencies: enabled, updatedAt: new Date() })
        .where(eq(organizations.id, ctx.organizationId));
      await this.audit.fromCtx(
        ctx,
        'finance.settings_updated',
        { type: 'organization', id: ctx.organizationId },
        {
          before: {
            baseCurrency: before.baseCurrency,
            enabledCurrencies: before.enabledCurrencies,
          },
          after: { baseCurrency: base, enabledCurrencies: enabled },
        },
        tx,
      );
    });
    return this.settings(ctx.organizationId);
  }

  /**
   * Suggested rate for a transaction form. Null rate means none is known for that date and the
   * user must type one. Any finance permission is enough to ask.
   */
  @Get('rates')
  @RequireOrg()
  async rate(
    @TenantCtx() ctx: TenantContext,
    @ZodQuery(rateLookupSchema) q: z.infer<typeof rateLookupSchema>,
  ): Promise<RateQuoteDto> {
    if (
      !['finance.view', 'finance.create', 'finance.edit'].some((p) => ctx.access.has(p as never))
    ) {
      throw Errors.forbidden();
    }
    const { baseCurrency } = await this.settings(ctx.organizationId);
    const quote = await this.fx.quote(q.currency, baseCurrency, q.date);
    return {
      currency: q.currency,
      baseCurrency,
      date: q.date,
      rate: quote?.rate ?? null,
      rateDate: quote?.rateDate ?? null,
      source: quote?.source ?? null,
    };
  }

  // --- Seasons --------------------------------------------------------------------------------

  @Get('seasons')
  @RequireOrg()
  async listSeasons(@TenantCtx() ctx: TenantContext): Promise<SeasonDto[]> {
    const rows = await this.db
      .select()
      .from(seasons)
      .where(eq(seasons.organizationId, ctx.organizationId))
      .orderBy(asc(seasons.startDate));
    return rows.map(toSeason);
  }

  /** Seasons may not overlap, so every date belongs to at most one season. */
  private async assertNoOverlap(
    db: DbOrTx,
    organizationId: string,
    s: SeasonInput,
    exceptId?: string,
  ) {
    const [clash] = await db
      .select({ id: seasons.id })
      .from(seasons)
      .where(
        and(
          eq(seasons.organizationId, organizationId),
          lte(seasons.startDate, s.endDate),
          gte(seasons.endDate, s.startDate),
          exceptId ? ne(seasons.id, exceptId) : undefined,
        ),
      );
    if (clash) throw Errors.conflict('season_overlap', 'Seasons cannot overlap');
  }

  /** Attach unassigned entries in the date range; detach entries now outside it. */
  private async reassignEntries(
    tx: DbOrTx,
    organizationId: string,
    seasonId: string,
    s: SeasonInput,
  ) {
    await tx
      .update(financeEntries)
      .set({ seasonId: null })
      .where(
        and(
          eq(financeEntries.organizationId, organizationId),
          eq(financeEntries.seasonId, seasonId),
          or(lt(financeEntries.entryDate, s.startDate), gt(financeEntries.entryDate, s.endDate)),
        ),
      );
    await tx
      .update(financeEntries)
      .set({ seasonId })
      .where(
        and(
          eq(financeEntries.organizationId, organizationId),
          isNull(financeEntries.seasonId),
          gte(financeEntries.entryDate, s.startDate),
          lte(financeEntries.entryDate, s.endDate),
        ),
      );
  }

  @Post('seasons')
  @RequirePermission('finance.configure')
  async createSeason(
    @TenantCtx() ctx: TenantContext,
    @ZodBody(seasonInputSchema) body: SeasonInput,
  ) {
    const row = await this.db.transaction(async (tx) => {
      await this.assertNoOverlap(tx, ctx.organizationId, body);
      const [s] = await tx
        .insert(seasons)
        .values({ organizationId: ctx.organizationId, ...body })
        .returning();
      await this.reassignEntries(tx, ctx.organizationId, s!.id, body);
      await this.audit.fromCtx(ctx, 'season.created', { type: 'season', id: s!.id }, body, tx);
      return s!;
    });
    // Entries moved between seasons: season budgets may have crossed their plan.
    await this.budgets.evaluate(ctx);
    return toSeason(row);
  }

  @Patch('seasons/:id')
  @RequirePermission('finance.configure')
  async updateSeason(
    @TenantCtx() ctx: TenantContext,
    @Param('id', UuidPipe) id: string,
    @ZodBody(seasonInputSchema) body: SeasonInput,
  ) {
    const row = await this.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(seasons)
        .where(and(eq(seasons.id, id), eq(seasons.organizationId, ctx.organizationId)));
      if (!before) throw Errors.notFound('Season');
      await this.assertNoOverlap(tx, ctx.organizationId, body, id);
      const [s] = await tx
        .update(seasons)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(seasons.id, id))
        .returning();
      await this.reassignEntries(tx, ctx.organizationId, id, body);
      await this.audit.fromCtx(
        ctx,
        'season.updated',
        { type: 'season', id },
        { before: toSeason(before), after: body },
        tx,
      );
      return s!;
    });
    await this.budgets.evaluate(ctx);
    return toSeason(row);
  }

  @Delete('seasons/:id')
  @HttpCode(204)
  @RequirePermission('finance.configure')
  async deleteSeason(@TenantCtx() ctx: TenantContext, @Param('id', UuidPipe) id: string) {
    await this.db.transaction(async (tx) => {
      const [s] = await tx
        .select()
        .from(seasons)
        .where(and(eq(seasons.id, id), eq(seasons.organizationId, ctx.organizationId)));
      if (!s) throw Errors.notFound('Season');
      // Entries were attached automatically; detach them (dates are kept). Budgets block deletion.
      await tx
        .update(financeEntries)
        .set({ seasonId: null })
        .where(
          and(
            eq(financeEntries.organizationId, ctx.organizationId),
            eq(financeEntries.seasonId, id),
          ),
        );
      await tx.delete(seasons).where(eq(seasons.id, id));
      await this.audit.fromCtx(
        ctx,
        'season.deleted',
        { type: 'season', id },
        { ...toSeason(s) },
        tx,
      );
    });
  }
}
