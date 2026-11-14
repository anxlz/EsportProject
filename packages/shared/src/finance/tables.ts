/**
 * The report as labelled tables — the single layout every export renders (PDF, CSV, XLSX, TXT).
 * Cells keep their raw values and type; each renderer only decides presentation, so no format
 * can drift from another or from the on-screen report (which shows the same FinancialReport).
 */
import { currencyInfo } from './catalog.js';
import {
  formatIsoDate,
  formatMoney,
  formatMonth,
  formatNumber,
  formatPercent,
  type MoneyFormatOptions,
} from './format.js';
import { categoryLabel, type FinanceLocale, fl, footnoteText } from './i18n.js';
import { SCENARIO_NAMES, type FinancialReport } from './report.js';

export type ReportCell =
  | { t: 'text'; v: string }
  /** Amount in a known currency, displayed with its code ("USD 1,250.00"). */
  | { t: 'money'; v: string; c: string }
  /** Amount whose currency sits in a neighbouring column (displayed without a code). */
  | { t: 'amount'; v: string; c: string }
  | { t: 'percent'; v: string }
  | { t: 'int'; v: number }
  | { t: 'month'; v: string }
  | { t: 'date'; v: string }
  | { t: 'rate'; v: string }
  | null;

export interface ReportTable {
  id: string;
  title: string;
  columns: string[];
  rows: ReportCell[][];
}

export interface ReportDocument {
  title: string;
  meta: [string, string][];
  tables: ReportTable[];
  footnotesTitle: string;
  footnotes: string[];
}

const text = (v: string | null | undefined): ReportCell =>
  v === null || v === undefined || v === '' ? null : { t: 'text', v };
const stripRate = (v: string) => (v.includes('.') ? v.replace(/\.?0+$/, '') : v);
/** Decimals to show: the currency's minor units, or more when the amount was entered with more. */
const digitsFor = (v: string, currency: string) =>
  Math.max(currencyInfo(currency).minorUnits, (stripRate(v).split('.')[1] ?? '').length);
const fixedDigits = (v: string, digits: number) => {
  const [i, f = ''] = v.split('.');
  return digits ? `${i}.${(f + '0'.repeat(digits)).slice(0, digits)}` : i!;
};

/** Display text, identical to the dashboard (the riyal sign only where its font is available). */
export function displayCell(
  cell: ReportCell,
  locale: FinanceLocale,
  opts: MoneyFormatOptions = {},
): string {
  if (!cell) return '';
  switch (cell.t) {
    case 'text':
      return cell.v;
    case 'money':
      return formatMoney(cell.v, cell.c, locale, opts);
    case 'amount':
      return `⁦${formatNumber(cell.v, locale, digitsFor(cell.v, cell.c))}⁩`;
    case 'percent':
      return formatPercent(cell.v, locale);
    case 'int':
      return formatNumber(cell.v, locale);
    case 'month':
      return formatMonth(cell.v, locale);
    case 'date':
      return formatIsoDate(cell.v, locale);
    case 'rate':
      return stripRate(cell.v);
  }
}

/** Machine-readable value (CSV): plain decimals, ISO dates, no grouping or currency codes. */
export function rawCell(cell: ReportCell): string {
  if (!cell) return '';
  switch (cell.t) {
    case 'int':
      return String(cell.v);
    case 'rate':
      return stripRate(cell.v);
    case 'amount':
      return fixedDigits(cell.v, digitsFor(cell.v, cell.c));
    case 'money':
      return fixedDigits(cell.v, currencyInfo(cell.c).minorUnits);
    default:
      return cell.v;
  }
}

export function reportDocument(r: FinancialReport, locale: FinanceLocale): ReportDocument {
  const L = fl(locale);
  const R = L.report;
  const c = r.baseCurrency;
  const m = (v: string): ReportCell => ({ t: 'money', v, c });
  const month = (v: string | null): ReportCell =>
    v ? { t: 'month', v } : { t: 'text', v: R.notReached };

  const period =
    r.period.from || r.period.to
      ? `${r.period.from ? formatIsoDate(r.period.from, locale) : '…'} – ${r.period.to ? formatIsoDate(r.period.to, locale) : '…'}`
      : R.allTime;
  const meta: [string, string][] = [
    [R.scope, `${L.scopeKind[r.scope.kind]}: ${r.scope.name}`],
    [R.period, period],
    [R.generated, formatIsoDate(r.asOf, locale)],
    [R.currency, c],
    [R.rates, r.rateMode === 'snapshot' ? R.rateSnapshot : R.rateCurrent],
  ];

  const tables: ReportTable[] = [];
  tables.push({
    id: 'summary',
    title: R.summary,
    columns: [R.item, R.amountBase],
    rows: [
      [text(R.totalCost), m(r.totals.cost)],
      [text(R.realizedRevenue), m(r.totals.realizedRevenue)],
      [text(R.net), m(r.totals.net)],
    ],
  });
  tables.push({
    id: 'costs_by_category',
    title: R.costsByCategory,
    columns: [R.category, R.amountBase, R.share],
    rows: r.costsByCategory.map((x) => [
      text(categoryLabel(locale, x.category)),
      m(x.amount),
      { t: 'percent', v: x.sharePercent },
    ]),
  });
  tables.push({
    id: 'revenue_by_category',
    title: R.revenueByCategory,
    columns: [R.category, R.amountBase, R.share],
    rows: r.revenueByCategory.map((x) => [
      text(categoryLabel(locale, x.category)),
      m(x.amount),
      { t: 'percent', v: x.sharePercent },
    ]),
  });
  if (r.byTeam) {
    tables.push({
      id: 'by_team',
      title: R.byTeam,
      columns: [R.team, R.cost, R.revenue, R.monthNet],
      rows: r.byTeam.map((x) => [text(x.teamName ?? R.noTeam), m(x.cost), m(x.revenue), m(x.net)]),
    });
  }
  tables.push({
    id: 'monthly',
    title: R.monthly,
    columns: [R.month, R.cost, R.revenue, R.monthNet, R.cumulative],
    rows: r.monthly.map((x) => [
      { t: 'month', v: x.month },
      m(x.cost),
      m(x.revenue),
      m(x.net),
      m(x.cumulativeNet),
    ]),
  });

  const be = r.breakEven;
  tables.push({
    id: 'break_even',
    title: R.breakEven,
    columns: [R.item, R.value],
    rows:
      be.status === 'no_costs'
        ? [[text(R.firstCostMonth), text(R.noCosts)]]
        : [
            [text(R.firstCostMonth), month(be.firstCostMonth)],
            [text(R.firstBreakEvenMonth), month(be.firstBreakEvenMonth)],
            [
              text(R.paybackMonths),
              be.paybackMonths === null ? text(R.notReached) : { t: 'int', v: be.paybackMonths },
            ],
            [text(R.currentPosition), m(be.currentPosition)],
            [text(R.revenueNeeded), m(be.revenueNeeded)],
          ],
  });

  tables.push({
    id: 'projections',
    title: R.projections,
    columns: [R.item, R.amountBase],
    rows: [
      [text(R.certainUnrealized), m(r.projections.certain)],
      [text(R.uncertainUnrealized), m(r.projections.uncertain)],
    ],
  });
  tables.push({
    id: 'expected_items',
    title: R.expectedItems,
    columns: [
      R.expectedOn,
      R.category,
      R.description,
      R.amountOriginal,
      R.originalCurrency,
      R.amountBase,
      R.status,
    ],
    rows: r.projections.items.map((x) => [
      { t: 'date', v: x.date },
      text(categoryLabel(locale, x.category)),
      text(x.description),
      { t: 'amount', v: x.amount, c: x.currency },
      text(x.currency),
      m(x.baseAmount),
      text(x.certainty ? L.certainty[x.certainty] : null),
    ]),
  });

  const s = r.scenarios;
  const row = (
    label: string,
    f: (n: (typeof SCENARIO_NAMES)[number]) => ReportCell,
  ): ReportCell[] => [text(label), ...SCENARIO_NAMES.map(f)];
  tables.push({
    id: 'scenarios',
    title: R.scenarios,
    columns: [R.item, ...SCENARIO_NAMES.map((n) => L.scenario[n])],
    rows: [
      row(R.monthlyRevenue, (n) => m(s[n].inputs.monthlyRevenue)),
      row(R.monthlyCost, (n) => m(s[n].inputs.monthlyCost)),
      row(R.oneOffRevenue, (n) => m(s[n].inputs.oneOffRevenue)),
      row(R.oneOffCost, (n) => m(s[n].inputs.oneOffCost)),
      row(R.horizonMonths, (n) => ({ t: 'int', v: s[n].inputs.horizonMonths })),
      row(R.startPosition, (n) => m(s[n].startPosition)),
      row(R.monthlyNetInput, (n) => m(s[n].monthlyNet)),
      row(R.outcome, (n) => text(L.outcome[s[n].outcome])),
      row(R.monthsToBreakEven, (n) =>
        s[n].monthsToBreakEven === null
          ? text(R.notReached)
          : { t: 'int', v: s[n].monthsToBreakEven! },
      ),
      row(R.breakEvenMonth, (n) =>
        s[n].breakEvenMonth
          ? { t: 'month', v: s[n].breakEvenMonth! }
          : s[n].outcome === 'already_covered'
            ? text(L.outcome.already_covered)
            : text(R.notReached),
      ),
      row(R.endPosition, (n) => m(s[n].endPosition)),
      row(R.lowestPosition, (n) => m(s[n].lowestPosition)),
      row(R.requiredMonthlyRevenue, (n) => m(s[n].requiredMonthlyRevenue)),
    ],
  });

  tables.push({
    id: 'transactions',
    title: R.transactions,
    columns: [
      R.date,
      R.type,
      R.category,
      R.team,
      R.description,
      R.amountOriginal,
      R.originalCurrency,
      R.rate,
      R.rateDate,
      R.amountBase,
      R.status,
    ],
    rows: r.entries.map((e) => [
      { t: 'date', v: e.date },
      text(e.kind === 'expense' ? R.expense : R.revenueRow),
      text(categoryLabel(locale, e.category)),
      text(e.teamName ?? R.noTeam),
      text(e.description),
      { t: 'amount', v: e.amount, c: e.currency },
      text(e.currency),
      { t: 'rate', v: e.rate },
      e.rateDate ? { t: 'date', v: e.rateDate } : null,
      m(e.baseAmount),
      text(e.kind === 'revenue' ? (e.realized ? R.realized : R.expected) : null),
    ]),
  });

  return {
    title: R.title,
    meta,
    tables,
    footnotesTitle: R.notes,
    footnotes: r.footnotes.map((f) => footnoteText(locale, f.key, f.params)),
  };
}
