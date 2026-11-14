/**
 * Financial reports at organization / team / tournament / season scope.
 *
 * One engine: the API gathers the scope's ledger rows and hands them to the shared, pure
 * `buildFinancialReport` — the same function the dashboard uses to recompute scenarios live and
 * every export renders from — so the screen, PDF, CSV, XLSX and TXT always show the same numbers.
 *
 * ROI is shown as cost vs realized revenue and their difference, with the inputs listed. There
 * is deliberately no single computed "ROI score" (brief §6.4).
 *
 * Access: a team report needs finance.view covering the team. Organization, tournament and
 * season reports aggregate across teams, so they need organization-wide finance.view — a
 * team-scoped user never receives a silently partial total.
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  addMonths,
  type CompensationTerms,
  convertToBase,
  deriveScenarioDefaults,
  type FinancialReport,
  type LedgerEntry,
  money,
  monthOf,
  monthRange,
  type PayFrequency,
  projectPayroll,
  type ReportQuery,
  type ReportScopeOption,
  type ScenarioSet,
  scenarioSetSchema,
  type ScopeKind,
  buildFinancialReport,
} from '@esports/shared';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { PermissionKey } from '@esports/shared';
import type { TeamRef } from '../authz/access.js';
import type { TenantContext } from '../authz/context.js';
import { scopeCondition } from '../authz/scope-filter.js';
import { AuditService } from '../audit/audit.service.js';
import { Errors } from '../common/errors.js';
import { DB, type Database } from '../db/client.js';
import { organizations, teams } from '../db/schema.js';
import { financeScenarios, seasons, tournaments } from '../db/schema-finance.js';
import { RostersService } from '../rosters/rosters.service.js';
import { CLOCK, type Clock } from './clock.js';
import { FxService } from './fx.service.js';
import { LedgerService, type LedgerRow, stripZeros } from './ledger.service.js';

export interface ResolvedScope {
  kind: ScopeKind;
  id: string | null;
  name: string;
  team: TeamRef | null;
  /** Default period (a season's own dates). */
  period: { from: string | null; to: string | null };
}

@Injectable()
export class ReportsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly fx: FxService,
    private readonly ledger: LedgerService,
    private readonly rosters: RostersService,
    private readonly audit: AuditService,
  ) {}

  /** The scopes this user can report on, for the scope picker. */
  async scopes(ctx: TenantContext): Promise<ReportScopeOption[]> {
    const out: ReportScopeOption[] = [];
    const orgWide = ctx.access.hasAll('finance.view');
    if (orgWide) {
      const [org] = await this.db
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, ctx.organizationId));
      out.push({ kind: 'organization', id: null, name: org?.name ?? '' });
    }
    const teamRows = await this.db
      .select({ id: teams.id, name: teams.name, departmentId: teams.departmentId })
      .from(teams)
      .where(
        and(
          eq(teams.organizationId, ctx.organizationId),
          scopeCondition(ctx.access.scope('finance.view'), {
            teamId: teams.id,
            departmentId: teams.departmentId,
          }),
        ),
      )
      .orderBy(asc(teams.name));
    out.push(
      ...teamRows.map((t) => ({
        kind: 'team' as const,
        id: t.id,
        name: t.name,
        departmentId: t.departmentId,
      })),
    );
    if (orgWide) {
      const ts = await this.db
        .select({ id: tournaments.id, name: tournaments.name })
        .from(tournaments)
        .where(eq(tournaments.organizationId, ctx.organizationId))
        .orderBy(asc(tournaments.name));
      out.push(...ts.map((t) => ({ kind: 'tournament' as const, id: t.id, name: t.name })));
      const ss = await this.db
        .select({ id: seasons.id, name: seasons.name })
        .from(seasons)
        .where(eq(seasons.organizationId, ctx.organizationId))
        .orderBy(asc(seasons.startDate));
      out.push(...ss.map((s) => ({ kind: 'season' as const, id: s.id, name: s.name })));
    }
    return out;
  }

  /**
   * Resolves and authorizes a scope. Unknown or out-of-scope teams are 404; aggregate scopes
   * without organization-wide access are 403.
   */
  async resolveScope(
    ctx: TenantContext,
    kind: ScopeKind,
    id: string | null | undefined,
    perm: PermissionKey = 'finance.view',
  ): Promise<ResolvedScope> {
    const none = { from: null, to: null };
    if (kind === 'team') {
      const [t] = await this.db
        .select({ id: teams.id, name: teams.name, departmentId: teams.departmentId })
        .from(teams)
        .where(and(eq(teams.id, id!), eq(teams.organizationId, ctx.organizationId)));
      if (!t || !ctx.access.coversTeam('finance.view', t)) throw Errors.notFound('Team');
      if (!ctx.access.coversTeam(perm, t)) throw Errors.forbidden();
      return { kind, id: t.id, name: t.name, team: t, period: none };
    }
    if (!ctx.access.hasAll('finance.view') || !ctx.access.hasAll(perm)) {
      throw Errors.forbidden(
        'This report covers every team, so it needs organization-wide finance access',
      );
    }
    if (kind === 'organization') {
      const [org] = await this.db
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, ctx.organizationId));
      return { kind, id: null, name: org!.name, team: null, period: none };
    }
    if (kind === 'tournament') {
      const [t] = await this.db
        .select({ id: tournaments.id, name: tournaments.name })
        .from(tournaments)
        .where(and(eq(tournaments.id, id!), eq(tournaments.organizationId, ctx.organizationId)));
      if (!t) throw Errors.notFound('Tournament');
      return { kind, id: t.id, name: t.name, team: null, period: none };
    }
    const [s] = await this.db
      .select()
      .from(seasons)
      .where(and(eq(seasons.id, id!), eq(seasons.organizationId, ctx.organizationId)));
    if (!s) throw Errors.notFound('Season');
    return {
      kind,
      id: s.id,
      name: s.name,
      team: null,
      period: { from: s.startDate, to: s.endDate },
    };
  }

  private toEntry(r: LedgerRow): LedgerEntry {
    const e = r.e;
    return {
      id: e.id,
      kind: e.kind,
      date: e.entryDate,
      category: e.category,
      amount: stripZeros(e.amount)!,
      currency: e.currency,
      baseAmount: money(e.baseAmount, e.baseCurrency),
      realized: e.realized,
      certainty: (e.certainty as LedgerEntry['certainty']) ?? null,
      recurrence: e.recurrence as LedgerEntry['recurrence'],
      description: e.description,
      teamId: e.teamId,
      teamName: r.teamName,
      rate: e.fxRate,
      rateDate: e.fxRateDate,
      rateSource: e.fxSource,
    };
  }

  /** Today's rate per currency (null when unknown). */
  private async currentRates(
    currencies: string[],
    base: string,
  ): Promise<Map<string, { rate: string; rateDate: string | null } | null>> {
    const out = new Map<string, { rate: string; rateDate: string | null } | null>();
    for (const c of new Set(currencies)) {
      const q = await this.fx.current(c, base);
      out.set(c, q ? { rate: q.rate, rateDate: q.rateDate } : null);
    }
    return out;
  }

  /**
   * Average monthly payroll over the next 12 months from roster pay terms (org/team only), plus
   * who had to be left out (per-event/one-time pay, or no current rate for their currency).
   */
  private async projectedPayroll(
    ctx: TenantContext,
    scope: ResolvedScope,
    base: string,
    asOf: string,
  ) {
    const none = { average: null, excluded: { notPeriodic: 0, noRate: [] as string[] } };
    if (scope.kind !== 'organization' && scope.kind !== 'team') return none;
    const rows = await this.rosters.compensationForTeams(
      ctx.organizationId,
      scope.kind === 'team' ? [scope.id!] : 'all',
    );
    if (!rows.length) return none;
    const rates = await this.currentRates(
      rows.map((r) => r.c.currency),
      base,
    );
    const terms: CompensationTerms[] = rows.map(({ m, c }) => ({
      rosterMemberId: m.id,
      teamId: m.teamId,
      currency: c.currency,
      amount: c.amount,
      offSeasonAmount: c.offSeasonAmount,
      frequency: c.frequency as PayFrequency,
      contractStart: c.contractStart,
      contractEnd: c.contractEnd,
      currentRate: rates.get(c.currency)?.rate ?? null,
    }));
    const seasonRows = await this.db
      .select({ startDate: seasons.startDate, endDate: seasons.endDate })
      .from(seasons)
      .where(eq(seasons.organizationId, ctx.organizationId));
    const start = monthOf(asOf);
    const projection = projectPayroll(
      terms,
      monthRange(start, addMonths(start, 11)),
      seasonRows,
      base,
    );
    const currencyOf = new Map(terms.map((x) => [x.rosterMemberId, x.currency]));
    return {
      average: projection.months.some((m) => Number(m.amount) > 0) ? projection.average : null,
      excluded: {
        notPeriodic: projection.excluded.filter((x) => x.reason === 'not_periodic').length,
        noRate: [
          ...new Set(
            projection.excluded
              .filter((x) => x.reason === 'no_rate')
              .map((x) => currencyOf.get(x.rosterMemberId)!),
          ),
        ].sort(),
      },
    };
  }

  async savedScenarios(
    organizationId: string,
    kind: ScopeKind,
    id: string | null,
  ): Promise<ScenarioSet | null> {
    const [row] = await this.db
      .select()
      .from(financeScenarios)
      .where(
        and(
          eq(financeScenarios.organizationId, organizationId),
          eq(financeScenarios.scopeKind, kind),
          id ? eq(financeScenarios.scopeId, id) : isNull(financeScenarios.scopeId),
        ),
      );
    if (!row) return null;
    const parsed = scenarioSetSchema.safeParse(row.scenarios);
    return parsed.success ? parsed.data : null;
  }

  async build(
    ctx: TenantContext,
    q: ReportQuery,
    scenarioOverride?: ScenarioSet,
  ): Promise<FinancialReport> {
    const scope = await this.resolveScope(ctx, q.scope, q.scopeId);
    const { base } = await this.ledger.currencies(this.db, ctx.organizationId);
    const asOf = this.clock.today();
    const period = { from: q.from ?? scope.period.from, to: q.to ?? scope.period.to };

    const rows = await this.ledger.rowsForScope(ctx.organizationId, {
      teamId: scope.kind === 'team' ? scope.id! : undefined,
      tournamentId: scope.kind === 'tournament' ? scope.id! : undefined,
      seasonId: scope.kind === 'season' ? scope.id! : undefined,
    });
    let all = rows.map((r) => this.toEntry(r));

    const missingCurrentRates: string[] = [];
    if (q.rateMode === 'current') {
      const rates = await this.currentRates(
        all.filter((e) => e.currency !== base).map((e) => e.currency),
        base,
      );
      for (const [c, r] of rates) if (!r) missingCurrentRates.push(c);
      all = all.map((e) => {
        const r = e.currency === base ? null : rates.get(e.currency);
        if (!r) return e; // same currency, or no current rate (footnoted; snapshot kept)
        return {
          ...e,
          baseAmount: convertToBase(e.amount, r.rate, base),
          rate: r.rate,
          rateDate: r.rateDate,
          rateSource: 'provider',
        };
      });
      missingCurrentRates.sort();
    }

    const inPeriod = all.filter(
      (e) => (!period.from || e.date >= period.from) && (!period.to || e.date <= period.to),
    );
    const payroll = await this.projectedPayroll(ctx, scope, base, asOf);
    const scenarioDefaults = deriveScenarioDefaults({
      baseCurrency: base,
      asOf,
      entries: all,
      projectedMonthlyPayroll: payroll.average,
    });
    const scenarios =
      scenarioOverride ??
      (await this.savedScenarios(ctx.organizationId, scope.kind, scope.id)) ??
      scenarioDefaults;

    return buildFinancialReport({
      baseCurrency: base,
      scope: { kind: scope.kind, id: scope.id, name: scope.name },
      period,
      rateMode: q.rateMode,
      asOf,
      entries: inPeriod,
      scenarios,
      scenarioDefaults,
      usedPayrollProjection: payroll.average !== null,
      payrollExcluded: payroll.excluded,
      missingCurrentRates,
    });
  }

  /** Scenario inputs are planning data shared by everyone who sees the report. */
  async saveScenarios(
    ctx: TenantContext,
    kind: ScopeKind,
    id: string | null,
    scenarios: ScenarioSet | null,
  ) {
    const scope = await this.resolveScope(ctx, kind, id, 'finance.edit');
    const before = await this.savedScenarios(ctx.organizationId, scope.kind, scope.id);
    await this.db.transaction(async (tx) => {
      const where = and(
        eq(financeScenarios.organizationId, ctx.organizationId),
        eq(financeScenarios.scopeKind, scope.kind),
        scope.id ? eq(financeScenarios.scopeId, scope.id) : isNull(financeScenarios.scopeId),
      );
      if (scenarios === null) {
        await tx.delete(financeScenarios).where(where);
      } else {
        await tx
          .insert(financeScenarios)
          .values({
            organizationId: ctx.organizationId,
            scopeKind: scope.kind,
            scopeId: scope.id,
            scenarios,
            updatedByUserId: ctx.user.id,
          })
          .onConflictDoUpdate({
            target: [
              financeScenarios.organizationId,
              financeScenarios.scopeKind,
              financeScenarios.scopeId,
            ],
            set: { scenarios, updatedByUserId: ctx.user.id, updatedAt: new Date() },
          });
      }
      await this.audit.fromCtx(
        ctx,
        scenarios === null ? 'finance.scenarios_reset' : 'finance.scenarios_saved',
        { type: `report_${scope.kind}`, id: scope.id ?? ctx.organizationId },
        { before, after: scenarios },
        tx,
      );
    });
  }
}
