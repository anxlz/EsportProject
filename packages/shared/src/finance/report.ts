/**
 * The financial report model and the ONE calculation engine behind it.
 *
 * The API builds a FinancialReport from database rows; the dashboard renders it; the PDF, CSV,
 * XLSX and TXT exports render the very same object. Scenario edits in the browser are recomputed
 * with `projectScenario` from this file, and an export re-runs the full builder on the server with
 * the same inputs — so the numbers in every format are identical by construction.
 *
 * ROI philosophy (implementation brief §6.4, "Option C"): there is NO single ROI score. The report
 * shows costs against REALIZED revenue by category and month, and keeps projections (unrealized,
 * uncertain income) in a separate, labelled section. Formulas and their limits are documented here
 * and surfaced to users as footnotes (see ./i18n.ts).
 */
import type { Certainty, Recurrence } from './catalog.js';
import { currencyInfo, SALARY_CATEGORIES } from './catalog.js';
import { addMonths, type Amount, d, Dec, money, monthDiff, monthOf, monthRange } from './money.js';

export type ScopeKind = 'organization' | 'team' | 'tournament' | 'season';
export type RateMode = 'snapshot' | 'current';
export const SCENARIO_NAMES = ['pessimistic', 'base', 'optimistic'] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

export interface LedgerEntry {
  id: string;
  kind: 'expense' | 'revenue';
  /** Expense: date incurred. Revenue: date received (realized) or expected (unrealized). */
  date: string;
  category: string;
  amount: Amount;
  currency: string;
  /** Amount in the base currency under the report's rate mode. */
  baseAmount: Amount;
  /** Expenses are always realized. Revenue is realized once received. */
  realized: boolean;
  certainty: Certainty | null;
  recurrence: Recurrence;
  description: string | null;
  teamId: string | null;
  teamName: string | null;
  /** The rate used for `baseAmount` and where it came from. */
  rate: string;
  rateDate: string | null;
  rateSource: string;
}

export interface ScenarioInputs {
  /** Recurring revenue expected each month (base currency). */
  monthlyRevenue: Amount;
  /** Recurring costs expected each month (base currency). */
  monthlyCost: Amount;
  /** One-off revenue assumed to arrive in the first projected month. */
  oneOffRevenue: Amount;
  /** One-off cost assumed in the first projected month. */
  oneOffCost: Amount;
  horizonMonths: number;
}
export type ScenarioSet = Record<ScenarioName, ScenarioInputs>;

export type ScenarioOutcome = 'already_covered' | 'reaches_break_even' | 'beyond_horizon' | 'never';

export interface ScenarioResult {
  inputs: ScenarioInputs;
  startPosition: Amount;
  monthlyNet: Amount;
  months: { month: string; position: Amount }[];
  outcome: ScenarioOutcome;
  /** Months after the start month until cumulative result is ≥ 0 and stays there. */
  monthsToBreakEven: number | null;
  breakEvenMonth: string | null;
  endPosition: Amount;
  lowestPosition: Amount;
  /** Monthly revenue needed to finish the horizon at ≥ 0, other inputs unchanged. */
  requiredMonthlyRevenue: Amount;
}

export interface BreakEvenAnalysis {
  status: 'no_costs' | 'covered' | 'not_covered';
  firstCostMonth: string | null;
  /** First month (from the first cost month on) where cumulative net reached ≥ 0. */
  firstBreakEvenMonth: string | null;
  /** Months counted inclusively from first cost month to first break-even month. */
  paybackMonths: number | null;
  /** Cumulative realized revenue − cumulative cost at the end of the series. */
  currentPosition: Amount;
  /** Realized revenue still needed to cover all costs so far (0 when covered). */
  revenueNeeded: Amount;
}

export type FootnoteKey =
  | 'rates_snapshot'
  | 'rates_current'
  | 'current_rate_missing'
  | 'realized_only'
  | 'projections_separate'
  | 'break_even_definition'
  | 'payback_definition'
  | 'scenario_definition'
  | 'scenario_defaults'
  | 'scenario_customized'
  | 'payroll_projection'
  | 'payroll_not_periodic'
  | 'payroll_no_rate'
  | 'tax_not_calculated'
  | 'rounding';

export interface Footnote {
  key: FootnoteKey;
  params?: Record<string, string>;
}

export interface FinancialReport {
  baseCurrency: string;
  scope: { kind: ScopeKind; id: string | null; name: string };
  period: { from: string | null; to: string | null };
  rateMode: RateMode;
  asOf: string;
  totals: { cost: Amount; realizedRevenue: Amount; net: Amount };
  costsByCategory: { category: string; amount: Amount; sharePercent: string }[];
  revenueByCategory: { category: string; amount: Amount; sharePercent: string }[];
  byTeam:
    | {
        teamId: string | null;
        teamName: string | null;
        cost: Amount;
        revenue: Amount;
        net: Amount;
      }[]
    | null;
  monthly: { month: string; cost: Amount; revenue: Amount; net: Amount; cumulativeNet: Amount }[];
  breakEven: BreakEvenAnalysis;
  projections: {
    certain: Amount;
    uncertain: Amount;
    items: Pick<
      LedgerEntry,
      | 'id'
      | 'date'
      | 'category'
      | 'baseAmount'
      | 'amount'
      | 'currency'
      | 'certainty'
      | 'description'
    >[];
  };
  scenarios: Record<ScenarioName, ScenarioResult>;
  scenarioDefaults: ScenarioSet;
  scenariosCustomized: boolean;
  entries: LedgerEntry[];
  footnotes: Footnote[];
}

export interface ReportInput {
  baseCurrency: string;
  scope: FinancialReport['scope'];
  period: FinancialReport['period'];
  rateMode: RateMode;
  asOf: string;
  /** Entries already filtered to the scope AND period. */
  entries: LedgerEntry[];
  scenarios: ScenarioSet;
  scenarioDefaults: ScenarioSet;
  /** Whether payroll projection fed the scenario defaults (adds a footnote). */
  usedPayrollProjection: boolean;
  /**
   * Roster members left out of the payroll projection: per-event/one-time pay, or pay in a
   * currency with no current exchange rate. Shown as a footnote so the gap is visible.
   */
  payrollExcluded?: { notPeriodic: number; noRate: string[] };
  /** Currencies whose current rate is unknown when rateMode = current (snapshot used instead). */
  missingCurrentRates: string[];
}

const pct = (part: InstanceType<typeof Dec>, whole: InstanceType<typeof Dec>) =>
  whole.isZero()
    ? '0.0'
    : part.div(whole).times(100).toDecimalPlaces(1, Dec.ROUND_HALF_UP).toFixed(1);

function groupByCategory(entries: LedgerEntry[], currency: string) {
  const map = new Map<string, InstanceType<typeof Dec>>();
  for (const e of entries)
    map.set(e.category, (map.get(e.category) ?? new Dec(0)).plus(e.baseAmount));
  const total = [...map.values()].reduce((a, b) => a.plus(b), new Dec(0));
  return [...map.entries()]
    .sort((a, b) => b[1].comparedTo(a[1]) || a[0].localeCompare(b[0]))
    .map(([category, amt]) => ({
      category,
      amount: money(amt, currency),
      sharePercent: pct(amt, total),
    }));
}

/**
 * Break-even on REALIZED figures.
 * - cumulative net(m) = Σ realized revenue − Σ costs, month by month.
 * - first break-even month: first month at or after the first month with costs from which the
 *   cumulative net stays ≥ 0 through the latest month. A one-off payment received up front
 *   (e.g. a sponsorship paid in January) that later costs eat into does not count as payback.
 *   Not reached while the current cumulative net is below zero.
 * - payback months: counted inclusively from the first cost month to that month
 *   (costs in Jan, recovered in Mar ⇒ 3).
 */
export function analyzeBreakEven(
  monthly: { month: string; cost: Amount; cumulativeNet: Amount }[],
  currency: string,
): BreakEvenAnalysis {
  const first = monthly.find((m) => d(m.cost).gt(0));
  const currentPosition = monthly.length
    ? monthly[monthly.length - 1]!.cumulativeNet
    : money(0, currency);
  if (!first) {
    return {
      status: 'no_costs',
      firstCostMonth: null,
      firstBreakEvenMonth: null,
      paybackMonths: null,
      currentPosition,
      revenueNeeded: money(0, currency),
    };
  }
  // Walk back from the latest month while the cumulative result is ≥ 0: where that run starts
  // is the month from which costs have stayed covered.
  let be: (typeof monthly)[number] | undefined;
  for (let i = monthly.length - 1; i >= 0 && monthly[i]!.month >= first.month; i--) {
    if (d(monthly[i]!.cumulativeNet).lt(0)) break;
    be = monthly[i];
  }
  const pos = d(currentPosition);
  return {
    status: pos.gte(0) ? 'covered' : 'not_covered',
    firstCostMonth: first.month,
    firstBreakEvenMonth: be?.month ?? null,
    paybackMonths: be ? monthDiff(first.month, be.month) + 1 : null,
    currentPosition,
    revenueNeeded: money(pos.lt(0) ? pos.negated() : 0, currency),
  };
}

/**
 * Forward projection for one scenario (constant monthly inputs, one-offs in month 1):
 *   position(m) = start + oneOffRevenue − oneOffCost + m × (monthlyRevenue − monthlyCost)
 * Break-even = first month the position is ≥ 0 and stays ≥ 0 through the horizon. If not within
 * the horizon but the monthly net is positive, the month is estimated in closed form:
 *   m* = ceil( −(start + oneOffs) / monthlyNet ).
 * Required monthly revenue to end the horizon at ≥ 0:
 *   R ≥ monthlyCost − (start + oneOffRevenue − oneOffCost) / horizon   (rounded UP, never < 0).
 */
export function projectScenario(
  startPosition: Amount,
  startMonth: string,
  inputs: ScenarioInputs,
  currency: string,
): ScenarioResult {
  const H = Math.max(1, Math.min(120, Math.trunc(inputs.horizonMonths)));
  const start = d(startPosition);
  const net = d(inputs.monthlyRevenue).minus(inputs.monthlyCost);
  const oneOffs = d(inputs.oneOffRevenue).minus(inputs.oneOffCost);

  const months: ScenarioResult['months'] = [];
  let lowest = start;
  for (let m = 1; m <= H; m++) {
    const p = start.plus(oneOffs).plus(net.times(m));
    if (p.lt(lowest)) lowest = p;
    months.push({ month: addMonths(startMonth, m), position: money(p, currency) });
  }

  const everNegative = start.lt(0) || months.some((x) => d(x.position).lt(0));
  let outcome: ScenarioOutcome;
  let monthsToBreakEven: number | null = null;
  if (!everNegative) {
    outcome = 'already_covered';
    monthsToBreakEven = 0;
  } else {
    let idx = -1;
    for (let i = 0; i < months.length; i++) {
      if (months.slice(i).every((x) => d(x.position).gte(0))) {
        idx = i;
        break;
      }
    }
    if (idx >= 0) {
      outcome = 'reaches_break_even';
      monthsToBreakEven = idx + 1;
    } else if (net.gt(0)) {
      outcome = 'beyond_horizon';
      monthsToBreakEven = start.plus(oneOffs).negated().div(net).ceil().toNumber();
    } else {
      outcome = 'never';
    }
  }

  const required = d(inputs.monthlyCost).minus(start.plus(oneOffs).div(H));
  return {
    inputs: { ...inputs, horizonMonths: H },
    startPosition: money(start, currency),
    monthlyNet: money(net, currency),
    months,
    outcome,
    monthsToBreakEven,
    breakEvenMonth:
      monthsToBreakEven && monthsToBreakEven > 0 ? addMonths(startMonth, monthsToBreakEven) : null,
    endPosition: months.length ? months[months.length - 1]!.position : money(start, currency),
    lowestPosition: money(lowest, currency),
    requiredMonthlyRevenue: money(
      required.lt(0) ? 0 : required.toDecimalPlaces(minorUnitsOf(currency), Dec.ROUND_UP),
      currency,
    ),
  };
}

const minorUnitsOf = (currency: string) => currencyInfo(currency).minorUnits;

export interface DefaultsInput {
  baseCurrency: string;
  asOf: string;
  /** All entries in the scope (any date). */
  entries: LedgerEntry[];
  /** Average monthly payroll projected from roster terms, or null when not applicable. */
  projectedMonthlyPayroll: Amount | null;
}

/**
 * Starting points for the three scenarios, derived only from the organization's own data
 * (no invented growth multipliers). Users can edit every number.
 * - Trailing window: the 3 full calendar months before the as-of month.
 * - Monthly cost: projected payroll + average non-salary cost in the window, or (no payroll) the
 *   average total cost in the window.
 * - Pessimistic: no new monthly revenue; only CERTAIN unrealized revenue arrives.
 * - Base: average realized monthly revenue in the window; CERTAIN unrealized revenue arrives.
 * - Optimistic: like base, plus all UNCERTAIN unrealized revenue arrives (e.g. hoped-for prizes).
 * - Horizon: 12 months.
 */
export function deriveScenarioDefaults(input: DefaultsInput): ScenarioSet {
  const c = input.baseCurrency;
  const asOfMonth = monthOf(input.asOf);
  const window = [addMonths(asOfMonth, -3), addMonths(asOfMonth, -2), addMonths(asOfMonth, -1)];
  const inWindow = (e: LedgerEntry) => window.includes(monthOf(e.date));

  const realizedRevenue = input.entries.filter(
    (e) => e.kind === 'revenue' && e.realized && inWindow(e),
  );
  const costs = input.entries.filter((e) => e.kind === 'expense' && inWindow(e));
  const total = (xs: LedgerEntry[]) => xs.reduce((a, e) => a.plus(e.baseAmount), new Dec(0));

  const avgRevenue = total(realizedRevenue).div(3);
  const avgCost = total(costs).div(3);
  const avgNonSalary = total(
    costs.filter((e) => !SALARY_CATEGORIES.includes(e.category as never)),
  ).div(3);
  const payroll = input.projectedMonthlyPayroll ? d(input.projectedMonthlyPayroll) : null;
  const monthlyCost = payroll && payroll.gt(0) ? payroll.plus(avgNonSalary) : avgCost;

  const unrealized = input.entries.filter((e) => e.kind === 'revenue' && !e.realized);
  const certain = total(unrealized.filter((e) => e.certainty === 'certain'));
  const uncertain = total(unrealized.filter((e) => e.certainty !== 'certain'));

  const mk = (
    monthlyRevenue: InstanceType<typeof Dec>,
    oneOffRevenue: InstanceType<typeof Dec>,
  ): ScenarioInputs => ({
    monthlyRevenue: money(monthlyRevenue, c),
    monthlyCost: money(monthlyCost, c),
    oneOffRevenue: money(oneOffRevenue, c),
    oneOffCost: money(0, c),
    horizonMonths: 12,
  });
  return {
    pessimistic: mk(new Dec(0), certain),
    base: mk(avgRevenue, certain),
    optimistic: mk(avgRevenue, certain.plus(uncertain)),
  };
}

export function sameScenarios(a: ScenarioSet, b: ScenarioSet): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Builds the complete report. Pure: same input ⇒ same output, on the server or in the browser. */
export function buildFinancialReport(input: ReportInput): FinancialReport {
  const c = input.baseCurrency;
  const expenses = input.entries.filter((e) => e.kind === 'expense');
  const realizedRevenue = input.entries.filter((e) => e.kind === 'revenue' && e.realized);
  const unrealized = input.entries.filter((e) => e.kind === 'revenue' && !e.realized);

  const costTotal = expenses.reduce((a, e) => a.plus(e.baseAmount), new Dec(0));
  const revenueTotal = realizedRevenue.reduce((a, e) => a.plus(e.baseAmount), new Dec(0));

  // Monthly series over realized activity (filled so gaps show as zero months).
  const realizedAll = [...expenses, ...realizedRevenue];
  let monthly: FinancialReport['monthly'] = [];
  if (realizedAll.length || (input.period.from && input.period.to)) {
    const dates = realizedAll.map((e) => monthOf(e.date)).sort();
    const from = input.period.from ? monthOf(input.period.from) : dates[0]!;
    const to = input.period.to ? monthOf(input.period.to) : dates[dates.length - 1]!;
    let cumulative = new Dec(0);
    monthly = monthRange(from, to).map((month) => {
      const cost = expenses
        .filter((e) => monthOf(e.date) === month)
        .reduce((a, e) => a.plus(e.baseAmount), new Dec(0));
      const revenue = realizedRevenue
        .filter((e) => monthOf(e.date) === month)
        .reduce((a, e) => a.plus(e.baseAmount), new Dec(0));
      const net = revenue.minus(cost);
      cumulative = cumulative.plus(net);
      return {
        month,
        cost: money(cost, c),
        revenue: money(revenue, c),
        net: money(net, c),
        cumulativeNet: money(cumulative, c),
      };
    });
  }

  const breakEven = analyzeBreakEven(monthly, c);
  const asOfMonth = monthOf(input.asOf);
  const lastMonth = monthly.length ? monthly[monthly.length - 1]!.month : asOfMonth;
  const projectionStart = lastMonth > asOfMonth ? lastMonth : asOfMonth;
  const scenarios = Object.fromEntries(
    (['pessimistic', 'base', 'optimistic'] as const).map((name) => [
      name,
      projectScenario(breakEven.currentPosition, projectionStart, input.scenarios[name], c),
    ]),
  ) as Record<ScenarioName, ScenarioResult>;

  let byTeam: FinancialReport['byTeam'] = null;
  if (input.scope.kind !== 'team') {
    const teams = new Map<
      string,
      {
        teamId: string | null;
        teamName: string | null;
        cost: InstanceType<typeof Dec>;
        revenue: InstanceType<typeof Dec>;
      }
    >();
    for (const e of [...expenses, ...realizedRevenue]) {
      const key = e.teamId ?? '';
      const row = teams.get(key) ?? {
        teamId: e.teamId,
        teamName: e.teamName,
        cost: new Dec(0),
        revenue: new Dec(0),
      };
      if (e.kind === 'expense') row.cost = row.cost.plus(e.baseAmount);
      else row.revenue = row.revenue.plus(e.baseAmount);
      teams.set(key, row);
    }
    byTeam = [...teams.values()]
      .sort((a, b) => (a.teamName ?? '').localeCompare(b.teamName ?? ''))
      .map((r) => ({
        teamId: r.teamId,
        teamName: r.teamName,
        cost: money(r.cost, c),
        revenue: money(r.revenue, c),
        net: money(r.revenue.minus(r.cost), c),
      }));
  }

  const customized = !sameScenarios(input.scenarios, input.scenarioDefaults);
  const footnotes: Footnote[] = [
    { key: input.rateMode === 'snapshot' ? 'rates_snapshot' : 'rates_current' },
    ...(input.rateMode === 'current' && input.missingCurrentRates.length
      ? [
          {
            key: 'current_rate_missing' as const,
            params: { currencies: input.missingCurrentRates.join(', ') },
          },
        ]
      : []),
    { key: 'realized_only' },
    { key: 'projections_separate' },
    { key: 'break_even_definition' },
    { key: 'payback_definition' },
    { key: 'scenario_definition' },
    { key: customized ? 'scenario_customized' : 'scenario_defaults' },
    ...(input.usedPayrollProjection ? [{ key: 'payroll_projection' as const }] : []),
    ...(input.payrollExcluded?.notPeriodic
      ? [
          {
            key: 'payroll_not_periodic' as const,
            params: { count: String(input.payrollExcluded.notPeriodic) },
          },
        ]
      : []),
    ...(input.payrollExcluded?.noRate.length
      ? [
          {
            key: 'payroll_no_rate' as const,
            params: { currencies: input.payrollExcluded.noRate.join(', ') },
          },
        ]
      : []),
    { key: 'tax_not_calculated' },
    { key: 'rounding', params: { currency: c } },
  ];

  return {
    baseCurrency: c,
    scope: input.scope,
    period: input.period,
    rateMode: input.rateMode,
    asOf: input.asOf,
    totals: {
      cost: money(costTotal, c),
      realizedRevenue: money(revenueTotal, c),
      net: money(revenueTotal.minus(costTotal), c),
    },
    costsByCategory: groupByCategory(expenses, c),
    revenueByCategory: groupByCategory(realizedRevenue, c),
    byTeam,
    monthly,
    breakEven,
    projections: {
      certain: money(
        unrealized
          .filter((e) => e.certainty === 'certain')
          .reduce((a, e) => a.plus(e.baseAmount), new Dec(0)),
        c,
      ),
      uncertain: money(
        unrealized
          .filter((e) => e.certainty !== 'certain')
          .reduce((a, e) => a.plus(e.baseAmount), new Dec(0)),
        c,
      ),
      items: unrealized
        .sort((a, b) => a.date.localeCompare(b.date))
        .map(({ id, date, category, baseAmount, amount, currency, certainty, description }) => ({
          id,
          date,
          category,
          baseAmount,
          amount,
          currency,
          certainty,
          description,
        })),
    },
    scenarios,
    scenarioDefaults: input.scenarioDefaults,
    scenariosCustomized: customized,
    entries: [...input.entries].sort(
      (a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind),
    ),
    footnotes,
  };
}

/** Budget variance: planned − actual. Positive = under budget, negative = over budget. */
export interface BudgetVarianceLine {
  category: string | null;
  planned: Amount;
  actual: Amount;
  variance: Amount;
  usedPercent: string;
  over: boolean;
}

export function computeBudgetVariance(
  budget: { total: Amount; lines: { category: string; amount: Amount }[] },
  expenses: Pick<LedgerEntry, 'category' | 'baseAmount'>[],
  currency: string,
): { total: BudgetVarianceLine; lines: BudgetVarianceLine[] } {
  const line = (
    category: string | null,
    planned: Amount,
    actualSum: InstanceType<typeof Dec>,
  ): BudgetVarianceLine => ({
    category,
    planned: money(planned, currency),
    actual: money(actualSum, currency),
    variance: money(d(planned).minus(actualSum), currency),
    usedPercent: pct(actualSum, d(planned)),
    over: actualSum.gt(planned),
  });
  const actualTotal = expenses.reduce((a, e) => a.plus(e.baseAmount), new Dec(0));
  return {
    total: line(null, budget.total, actualTotal),
    lines: budget.lines.map((l) =>
      line(
        l.category,
        l.amount,
        expenses
          .filter((e) => e.category === l.category)
          .reduce((a, e) => a.plus(e.baseAmount), new Dec(0)),
      ),
    ),
  };
}
