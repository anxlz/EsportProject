/**
 * The finance ledger: costs and revenue.
 *
 * Scope hierarchy (brief §6.2): organization-wide (no team) → team → player (team + roster
 * member). Permission scope follows the team: a team-scoped manager works only with that team's
 * records; organization-wide records need an organization-wide grant.
 *
 * Exchange rates are snapshotted on write (brief §5):
 *   same currency → 1 ("same_currency"); a typed rate → "manual"; otherwise the provider rate for
 *   the entry date ("provider"); no rate known → 400 fx_rate_required (the user must type one).
 * On edit, the stored rate is kept unless the currency or date changes, or a rate is typed.
 *
 * Tax fields are stored as entered and never read by any calculation (§6.7).
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  convertToBase,
  type ExpenseInput,
  type LedgerEntryDto,
  type ledgerQuerySchema,
  money,
  normalizeRate,
  type RevenueInput,
} from '@esports/shared';
import { and, asc, desc, eq, gte, isNull, lte, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import type { TeamRef } from '../authz/access.js';
import type { TenantContext } from '../authz/context.js';
import { scopeCondition } from '../authz/scope-filter.js';
import { AuditService } from '../audit/audit.service.js';
import { AppError, Errors } from '../common/errors.js';
import { DB, type Database, type DbOrTx } from '../db/client.js';
import { organizations, teams, users } from '../db/schema.js';
import { financeEntries, rosterMembers, seasons, tournaments } from '../db/schema-finance.js';
import { BudgetsService } from './budgets.service.js';
import { FxService } from './fx.service.js';
import { coversRecord, loadTeamRef } from './scope.js';

export type LedgerKind = 'expense' | 'revenue';
export type LedgerInput =
  (ExpenseInput & { kind: 'expense' }) | (RevenueInput & { kind: 'revenue' });
export type LedgerQuery = z.infer<typeof ledgerQuerySchema>;

/** NUMERIC(18,4) comes back as "2000.0000"; present it as entered ("2000"). */
export const stripZeros = (v: string | null) =>
  v === null ? null : v.includes('.') ? v.replace(/\.?0+$/, '') : v;

@Injectable()
export class LedgerService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly fx: FxService,
    private readonly audit: AuditService,
    private readonly budgets: BudgetsService,
  ) {}

  async currencies(db: DbOrTx, organizationId: string) {
    const [org] = await db
      .select({ base: organizations.baseCurrency, enabled: organizations.enabledCurrencies })
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    if (!org) throw Errors.notFound('Organization');
    return org;
  }

  selectQuery(db: DbOrTx = this.db) {
    return db
      .select({
        e: financeEntries,
        teamName: teams.name,
        teamDepartmentId: teams.departmentId,
        memberName: rosterMembers.fullName,
        tournamentName: tournaments.name,
        seasonName: seasons.name,
        createdByName: users.displayName,
      })
      .from(financeEntries)
      .leftJoin(teams, eq(teams.id, financeEntries.teamId))
      .leftJoin(rosterMembers, eq(rosterMembers.id, financeEntries.rosterMemberId))
      .leftJoin(tournaments, eq(tournaments.id, financeEntries.tournamentId))
      .leftJoin(seasons, eq(seasons.id, financeEntries.seasonId))
      .leftJoin(users, eq(users.id, financeEntries.createdByUserId));
  }

  toDto(r: LedgerRow): LedgerEntryDto {
    const e = r.e;
    return {
      id: e.id,
      kind: e.kind,
      teamId: e.teamId,
      teamName: r.teamName,
      rosterMemberId: e.rosterMemberId,
      rosterMemberName: r.memberName,
      tournamentId: e.tournamentId,
      tournamentName: r.tournamentName,
      seasonId: e.seasonId,
      seasonName: r.seasonName,
      category: e.category,
      description: e.description,
      date: e.entryDate,
      amount: stripZeros(e.amount)!,
      currency: e.currency,
      rate: e.fxRate,
      rateDate: e.fxRateDate,
      rateSource: e.fxSource,
      baseAmount: money(e.baseAmount, e.baseCurrency),
      baseCurrency: e.baseCurrency,
      recurrence: e.recurrence as LedgerEntryDto['recurrence'],
      ownership: (e.ownership as LedgerEntryDto['ownership']) ?? null,
      realized: e.realized,
      certainty: (e.certainty as LedgerEntryDto['certainty']) ?? null,
      counterparty: e.counterparty,
      taxAmount: stripZeros(e.taxAmount),
      taxJurisdiction: e.taxJurisdiction,
      createdBy: e.createdByUserId
        ? { id: e.createdByUserId, displayName: r.createdByName ?? '' }
        : null,
      createdAt: e.createdAt.toISOString(),
      updatedAt: e.updatedAt.toISOString(),
    };
  }

  async list(ctx: TenantContext, kind: LedgerKind, q: LedgerQuery): Promise<LedgerEntryDto[]> {
    const conds: (SQL | undefined)[] = [
      eq(financeEntries.organizationId, ctx.organizationId),
      eq(financeEntries.kind, kind),
      // Organization-wide rows (no team) only match an organization-wide grant.
      scopeCondition(ctx.access.scope('finance.view'), {
        teamId: financeEntries.teamId,
        departmentId: teams.departmentId,
      }),
    ];
    if (q.teamId === 'none') conds.push(isNull(financeEntries.teamId));
    else if (q.teamId) conds.push(eq(financeEntries.teamId, q.teamId));
    if (q.rosterMemberId) conds.push(eq(financeEntries.rosterMemberId, q.rosterMemberId));
    if (q.tournamentId) conds.push(eq(financeEntries.tournamentId, q.tournamentId));
    if (q.seasonId) conds.push(eq(financeEntries.seasonId, q.seasonId));
    if (q.category) conds.push(eq(financeEntries.category, q.category));
    if (q.from) conds.push(gte(financeEntries.entryDate, q.from));
    if (q.to) conds.push(lte(financeEntries.entryDate, q.to));
    const rows = await this.selectQuery()
      .where(and(...conds))
      .orderBy(desc(financeEntries.entryDate), desc(financeEntries.createdAt))
      .limit(q.limit)
      .offset(q.offset);
    return rows.map((r) => this.toDto(r));
  }

  /** An entry the caller can see (finance.view covers its team / org level), else 404. */
  async getVisible(ctx: TenantContext, kind: LedgerKind, id: string) {
    const [r] = await this.selectQuery().where(
      and(
        eq(financeEntries.id, id),
        eq(financeEntries.organizationId, ctx.organizationId),
        eq(financeEntries.kind, kind),
      ),
    );
    const team: TeamRef | null = r?.e.teamId
      ? { id: r.e.teamId, departmentId: r.teamDepartmentId }
      : null;
    if (!r || !coversRecord(ctx.access, 'finance.view', team)) throw Errors.notFound('Entry');
    return { row: r, team, dto: this.toDto(r) };
  }

  /** Validates references (all must belong to the organization) and resolves the season. */
  private async resolveRefs(tx: DbOrTx, ctx: TenantContext, input: LedgerInput) {
    const team = await loadTeamRef(tx, ctx.organizationId, input.teamId ?? null);
    if (input.rosterMemberId) {
      const [m] = await tx
        .select({ id: rosterMembers.id })
        .from(rosterMembers)
        .where(
          and(
            eq(rosterMembers.id, input.rosterMemberId),
            eq(rosterMembers.organizationId, ctx.organizationId),
            eq(rosterMembers.teamId, input.teamId!),
          ),
        );
      if (!m) throw new AppError('roster_member_mismatch', 400, 'That person is not on this team');
    }
    if (input.tournamentId) {
      const [t] = await tx
        .select({ id: tournaments.id })
        .from(tournaments)
        .where(
          and(
            eq(tournaments.id, input.tournamentId),
            eq(tournaments.organizationId, ctx.organizationId),
          ),
        );
      if (!t) throw Errors.badRequest('validation_failed', 'Unknown tournament');
    }
    let seasonId: string | null = input.seasonId ?? null;
    if (seasonId) {
      const [s] = await tx
        .select({ id: seasons.id })
        .from(seasons)
        .where(and(eq(seasons.id, seasonId), eq(seasons.organizationId, ctx.organizationId)));
      if (!s) throw Errors.badRequest('validation_failed', 'Unknown season');
    } else {
      // Automatic: the season whose dates contain the entry date (seasons never overlap).
      const [s] = await tx
        .select({ id: seasons.id })
        .from(seasons)
        .where(
          and(
            eq(seasons.organizationId, ctx.organizationId),
            lte(seasons.startDate, input.date),
            gte(seasons.endDate, input.date),
          ),
        );
      seasonId = s?.id ?? null;
    }
    return { team, seasonId };
  }

  private async snapshotRate(
    currency: string,
    base: string,
    date: string,
    manualRate: string | null | undefined,
  ) {
    if (currency === base)
      return { rate: normalizeRate(1), rateDate: null, source: 'same_currency' as const };
    if (manualRate)
      return { rate: normalizeRate(manualRate), rateDate: date, source: 'manual' as const };
    const q = await this.fx.quote(currency, base, date);
    if (!q) {
      throw new AppError(
        'fx_rate_required',
        400,
        `No exchange rate is known for ${currency} on ${date}. Enter the rate.`,
        {
          currency,
          baseCurrency: base,
          date,
        },
      );
    }
    return { rate: q.rate, rateDate: q.rateDate, source: q.source };
  }

  private fieldsFor(input: LedgerInput) {
    return {
      kind: input.kind,
      teamId: input.teamId ?? null,
      rosterMemberId: input.rosterMemberId ?? null,
      tournamentId: input.tournamentId ?? null,
      category: input.category,
      description: input.description ?? null,
      entryDate: input.date,
      amount: input.amount,
      currency: input.currency,
      recurrence: input.recurrence,
      ownership: input.kind === 'expense' ? (input.ownership ?? null) : null,
      realized: input.kind === 'revenue' ? input.realized : true,
      certainty: input.kind === 'revenue' ? input.certainty : null,
      counterparty: input.kind === 'revenue' ? (input.counterparty ?? null) : null,
      taxAmount: input.taxAmount ?? null,
      taxJurisdiction: input.taxJurisdiction ?? null,
    };
  }

  private async reload(id: string): Promise<LedgerEntryDto> {
    const [r] = await this.selectQuery().where(eq(financeEntries.id, id));
    return this.toDto(r!);
  }

  async create(ctx: TenantContext, input: LedgerInput): Promise<LedgerEntryDto> {
    const id = await this.db.transaction(async (tx) => {
      const { base, enabled } = await this.currencies(tx, ctx.organizationId);
      if (!enabled.includes(input.currency)) {
        throw new AppError(
          'currency_not_enabled',
          400,
          `${input.currency} is not enabled for this organization`,
        );
      }
      const { team, seasonId } = await this.resolveRefs(tx, ctx, input);
      if (!coversRecord(ctx.access, 'finance.create', team)) throw Errors.forbidden();
      const fx = await this.snapshotRate(input.currency, base, input.date, input.rate);
      const baseAmount = convertToBase(input.amount, fx.rate, base);
      const [row] = await tx
        .insert(financeEntries)
        .values({
          organizationId: ctx.organizationId,
          ...this.fieldsFor(input),
          seasonId,
          fxRate: fx.rate,
          fxRateDate: fx.rateDate,
          fxSource: fx.source,
          baseCurrency: base,
          baseAmount,
          createdByUserId: ctx.user.id,
          updatedByUserId: ctx.user.id,
        })
        .returning({ id: financeEntries.id });
      await this.audit.fromCtx(
        ctx,
        `finance.${input.kind}_created`,
        { type: `finance_${input.kind}`, id: row!.id },
        {
          category: input.category,
          date: input.date,
          amount: input.amount,
          currency: input.currency,
          rate: fx.rate,
          rateSource: fx.source,
          baseAmount,
          teamId: input.teamId ?? null,
          rosterMemberId: input.rosterMemberId ?? null,
        },
        tx,
      );
      return row!.id;
    });
    if (input.kind === 'expense') await this.budgets.evaluate(ctx, [input.teamId ?? null]);
    return this.reload(id);
  }

  async update(ctx: TenantContext, id: string, input: LedgerInput): Promise<LedgerEntryDto> {
    const { row, team: beforeTeam } = await this.getVisible(ctx, input.kind, id);
    if (!coversRecord(ctx.access, 'finance.edit', beforeTeam)) throw Errors.forbidden();
    const before = row.e;
    await this.db.transaction(async (tx) => {
      const { enabled } = await this.currencies(tx, ctx.organizationId);
      if (input.currency !== before.currency && !enabled.includes(input.currency)) {
        throw new AppError(
          'currency_not_enabled',
          400,
          `${input.currency} is not enabled for this organization`,
        );
      }
      const { team, seasonId } = await this.resolveRefs(tx, ctx, input);
      // Moving a record to another team (or to organization level) needs edit rights there too.
      if (!coversRecord(ctx.access, 'finance.edit', team)) throw Errors.forbidden();

      const resnapshot =
        input.currency !== before.currency || input.date !== before.entryDate || !!input.rate;
      const fx = resnapshot
        ? await this.snapshotRate(input.currency, before.baseCurrency, input.date, input.rate)
        : { rate: before.fxRate, rateDate: before.fxRateDate, source: before.fxSource };
      const baseAmount = convertToBase(input.amount, fx.rate, before.baseCurrency);
      await tx
        .update(financeEntries)
        .set({
          ...this.fieldsFor(input),
          seasonId,
          fxRate: fx.rate,
          fxRateDate: fx.rateDate,
          fxSource: fx.source,
          baseAmount,
          updatedByUserId: ctx.user.id,
          updatedAt: new Date(),
        })
        .where(eq(financeEntries.id, id));
      await this.audit.fromCtx(
        ctx,
        `finance.${input.kind}_updated`,
        { type: `finance_${input.kind}`, id },
        {
          before: {
            category: before.category,
            date: before.entryDate,
            amount: stripZeros(before.amount),
            currency: before.currency,
            rate: before.fxRate,
            baseAmount: before.baseAmount,
            teamId: before.teamId,
            realized: before.realized,
          },
          after: {
            category: input.category,
            date: input.date,
            amount: input.amount,
            currency: input.currency,
            rate: fx.rate,
            baseAmount,
            teamId: input.teamId ?? null,
            realized: input.kind === 'revenue' ? input.realized : true,
          },
          rateResnapshotted: resnapshot,
        },
        tx,
      );
    });
    if (input.kind === 'expense')
      await this.budgets.evaluate(ctx, [before.teamId, input.teamId ?? null]);
    return this.reload(id);
  }

  async remove(ctx: TenantContext, kind: LedgerKind, id: string): Promise<void> {
    const { row, team } = await this.getVisible(ctx, kind, id);
    if (!coversRecord(ctx.access, 'finance.delete', team)) throw Errors.forbidden();
    await this.db.transaction(async (tx) => {
      await tx.delete(financeEntries).where(eq(financeEntries.id, id));
      await this.audit.fromCtx(
        ctx,
        `finance.${kind}_deleted`,
        { type: `finance_${kind}`, id },
        {
          category: row.e.category,
          date: row.e.entryDate,
          amount: stripZeros(row.e.amount),
          currency: row.e.currency,
          baseAmount: row.e.baseAmount,
          teamId: row.e.teamId,
        },
        tx,
      );
    });
    if (kind === 'expense') await this.budgets.evaluate(ctx, [row.e.teamId]);
  }

  /**
   * Every entry in a report scope, any date. No visibility filter: the report service
   * authorizes the scope before calling this.
   */
  rowsForScope(
    organizationId: string,
    filter: { teamId?: string; tournamentId?: string; seasonId?: string },
  ) {
    return this.selectQuery()
      .where(
        and(
          eq(financeEntries.organizationId, organizationId),
          filter.teamId ? eq(financeEntries.teamId, filter.teamId) : undefined,
          filter.tournamentId ? eq(financeEntries.tournamentId, filter.tournamentId) : undefined,
          filter.seasonId ? eq(financeEntries.seasonId, filter.seasonId) : undefined,
        ),
      )
      .orderBy(asc(financeEntries.entryDate), asc(financeEntries.createdAt));
  }
}

export type LedgerRow = Awaited<ReturnType<LedgerService['selectQuery']>>[number];
