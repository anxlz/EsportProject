/**
 * Finance engine tests. Every expected value was worked out by hand first; the arithmetic is in
 * the comments so a reviewer (or your accountant) can check it without running anything.
 */
import { describe, expect, test } from 'bun:test';
import { formatMoney, formatMonth } from './format';
import { footnoteText } from './i18n';
import { convertToBase, invertRate, money, monthRange } from './money';
import { monthlyEquivalent, projectPayroll } from './payroll';
import {
  analyzeBreakEven,
  buildFinancialReport,
  computeBudgetVariance,
  deriveScenarioDefaults,
  type LedgerEntry,
  projectScenario,
  type ScenarioSet,
} from './report';

const entry = (
  p: Partial<LedgerEntry> & Pick<LedgerEntry, 'id' | 'kind' | 'date' | 'category' | 'baseAmount'>,
): LedgerEntry => ({
  amount: p.baseAmount,
  currency: 'SAR',
  realized: true,
  certainty: null,
  recurrence: 'one_time',
  description: null,
  teamId: 't1',
  teamName: 'Team One',
  rate: '1.000000000000',
  rateDate: p.date,
  rateSource: 'same_currency',
  ...p,
});

// Ledger used across tests (base currency SAR):
//   Jan: cost 10,000 (salary) + 2,000 (flights)           → net −12,000, cumulative −12,000
//   Feb: revenue 5,000 (sponsor); cost 4,000 (salary)     → net  +1,000, cumulative −11,000
//   Mar: revenue 12,000 (prize); cost 500 (visas)         → net +11,500, cumulative     +500
//   Unrealized: 3,000 certain (May), 8,000 uncertain (Jun) — never in realized totals.
const LEDGER: LedgerEntry[] = [
  entry({
    id: 'e1',
    kind: 'expense',
    date: '2026-01-10',
    category: 'salary_player',
    baseAmount: '10000.00',
  }),
  entry({
    id: 'e2',
    kind: 'expense',
    date: '2026-01-20',
    category: 'flights_travel',
    baseAmount: '2000.00',
  }),
  entry({
    id: 'r1',
    kind: 'revenue',
    date: '2026-02-05',
    category: 'sponsorship_fixed',
    baseAmount: '5000.00',
    certainty: 'certain',
  }),
  entry({
    id: 'e3',
    kind: 'expense',
    date: '2026-02-15',
    category: 'salary_player',
    baseAmount: '4000.00',
  }),
  entry({
    id: 'r2',
    kind: 'revenue',
    date: '2026-03-01',
    category: 'prize_money',
    baseAmount: '12000.00',
    certainty: 'uncertain',
  }),
  entry({ id: 'e4', kind: 'expense', date: '2026-03-20', category: 'visas', baseAmount: '500.00' }),
  entry({
    id: 'u1',
    kind: 'revenue',
    date: '2026-05-01',
    category: 'sponsorship_fixed',
    baseAmount: '3000.00',
    realized: false,
    certainty: 'certain',
  }),
  entry({
    id: 'u2',
    kind: 'revenue',
    date: '2026-06-01',
    category: 'prize_money',
    baseAmount: '8000.00',
    realized: false,
    certainty: 'uncertain',
  }),
];

const flat = (rev: string, cost: string, oneOff = '0.00', h = 12) => ({
  monthlyRevenue: rev,
  monthlyCost: cost,
  oneOffRevenue: oneOff,
  oneOffCost: '0.00',
  horizonMonths: h,
});
const SCEN: ScenarioSet = {
  pessimistic: flat('0.00', '1000.00'),
  base: flat('1000.00', '1000.00'),
  optimistic: flat('3000.00', '1000.00'),
};

describe('money', () => {
  test('conversion and rounding (half away from zero, ISO minor units)', () => {
    expect(convertToBase('100', '3.75', 'SAR')).toBe('375.00');
    // 1000 × 0.266666666667 = 266.666666667 → 266.67
    expect(convertToBase('1000', '0.266666666667', 'USD')).toBe('266.67');
    expect(money('2.345', 'USD')).toBe('2.35');
    expect(money('-2.345', 'USD')).toBe('-2.35');
    expect(money('1.0005', 'KWD')).toBe('1.001');
    expect(money('1.5', 'JPY')).toBe('2');
    expect(money('0.1', 'USD')).toBe('0.10');
    // 1 / 3.75 = 0.26666… → 12 places
    expect(invertRate('3.75')).toBe('0.266666666667');
  });

  test('no floating point drift: 0.10 + 0.20', () => {
    const r = buildFinancialReport({
      baseCurrency: 'USD',
      scope: { kind: 'team', id: 't1', name: 'T' },
      period: { from: null, to: null },
      rateMode: 'snapshot',
      asOf: '2026-01-31',
      entries: [
        entry({
          id: 'a',
          kind: 'expense',
          date: '2026-01-01',
          category: 'visas',
          baseAmount: '0.10',
          currency: 'USD',
        }),
        entry({
          id: 'b',
          kind: 'expense',
          date: '2026-01-02',
          category: 'visas',
          baseAmount: '0.20',
          currency: 'USD',
        }),
      ],
      scenarios: SCEN,
      scenarioDefaults: SCEN,
      usedPayrollProjection: false,
      missingCurrentRates: [],
    });
    expect(r.totals.cost).toBe('0.30');
  });

  test('month helpers', () => {
    expect(monthRange('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(formatMonth('2026-03', 'en')).toBe('Mar 2026');
    expect(formatMonth('2026-03', 'ar')).toBe('مارس 2026');
  });

  test('formatting is identical code-first in both languages, Western digits', () => {
    expect(formatMoney('1234.5', 'SAR', 'en')).toBe('⁦SAR 1,234.50⁩');
    expect(formatMoney('-1234.5', 'USD', 'en')).toBe('⁦USD -1,234.50⁩');
    expect(formatMoney('1234.5', 'SAR', 'ar')).toMatch(/SAR 1.234.50/);
  });
});

describe('payroll projection', () => {
  test('monthly equivalents', () => {
    expect(monthlyEquivalent('1200', 'weekly')!.toString()).toBe('5200'); // 1200×52/12
    expect(monthlyEquivalent('1200', 'biweekly')!.toString()).toBe('2600'); // 1200×26/12
    expect(monthlyEquivalent('1000', 'semimonthly')!.toString()).toBe('2000');
    expect(monthlyEquivalent('9000', 'quarterly')!.toString()).toBe('3000');
    expect(monthlyEquivalent('120000', 'annually')!.toString()).toBe('10000');
    expect(monthlyEquivalent('500', 'per_event')).toBeNull();
  });

  test('season / off-season pay, contract dates, currency conversion', () => {
    // Season: Feb–Mar 2026. Base SAR.
    // A: USD 1,000 monthly at 3.75 = 3,750/month, contract 15 Jan – 10 Mar.
    // B: SAR 2,000 monthly in season, 1,000 off-season, open-ended.
    // C: USD 300 weekly = 1,300 USD/month × 3.75 = 4,875, from 1 Mar.
    // D: per-event pay → excluded.
    // Jan (off): A 3,750 + B 1,000            =  4,750
    // Feb (in):  A 3,750 + B 2,000            =  5,750
    // Mar (in):  A 3,750 + B 2,000 + C 4,875  = 10,625
    // Apr (off): B 1,000 + C 4,875            =  5,875
    // Average = 27,000 / 4 = 6,750
    const p = projectPayroll(
      [
        {
          rosterMemberId: 'A',
          teamId: 't',
          currency: 'USD',
          amount: '1000',
          offSeasonAmount: null,
          frequency: 'monthly',
          contractStart: '2026-01-15',
          contractEnd: '2026-03-10',
          currentRate: '3.75',
        },
        {
          rosterMemberId: 'B',
          teamId: 't',
          currency: 'SAR',
          amount: '2000',
          offSeasonAmount: '1000',
          frequency: 'monthly',
          contractStart: null,
          contractEnd: null,
          currentRate: '1',
        },
        {
          rosterMemberId: 'C',
          teamId: 't',
          currency: 'USD',
          amount: '300',
          offSeasonAmount: null,
          frequency: 'weekly',
          contractStart: '2026-03-01',
          contractEnd: null,
          currentRate: '3.75',
        },
        {
          rosterMemberId: 'D',
          teamId: 't',
          currency: 'SAR',
          amount: '500',
          offSeasonAmount: null,
          frequency: 'per_event',
          contractStart: null,
          contractEnd: null,
          currentRate: '1',
        },
      ],
      ['2026-01', '2026-02', '2026-03', '2026-04'],
      [{ startDate: '2026-02-01', endDate: '2026-03-31' }],
      'SAR',
    );
    expect(p.months.map((m) => m.amount)).toEqual(['4750.00', '5750.00', '10625.00', '5875.00']);
    expect(p.average).toBe('6750.00');
    expect(p.excluded).toEqual([{ rosterMemberId: 'D', reason: 'not_periodic' }]);
  });

  test('members without a current rate are excluded, not guessed', () => {
    const p = projectPayroll(
      [
        {
          rosterMemberId: 'X',
          teamId: 't',
          currency: 'EUR',
          amount: '1000',
          offSeasonAmount: null,
          frequency: 'monthly',
          contractStart: null,
          contractEnd: null,
          currentRate: null,
        },
      ],
      ['2026-01'],
      [],
      'SAR',
    );
    expect(p.months[0]!.amount).toBe('0.00');
    expect(p.excluded).toEqual([{ rosterMemberId: 'X', reason: 'no_rate' }]);
  });
});

describe('financial report (cost vs realized revenue)', () => {
  const report = buildFinancialReport({
    baseCurrency: 'SAR',
    scope: { kind: 'team', id: 't1', name: 'Team One' },
    period: { from: null, to: null },
    rateMode: 'snapshot',
    asOf: '2026-04-16',
    entries: LEDGER,
    scenarios: SCEN,
    scenarioDefaults: SCEN,
    usedPayrollProjection: false,
    missingCurrentRates: [],
  });

  test('totals use realized revenue only', () => {
    // Costs 10,000 + 2,000 + 4,000 + 500 = 16,500. Realized revenue 5,000 + 12,000 = 17,000.
    expect(report.totals).toEqual({ cost: '16500.00', realizedRevenue: '17000.00', net: '500.00' });
  });

  test('monthly and cumulative series', () => {
    expect(report.monthly).toEqual([
      {
        month: '2026-01',
        cost: '12000.00',
        revenue: '0.00',
        net: '-12000.00',
        cumulativeNet: '-12000.00',
      },
      {
        month: '2026-02',
        cost: '4000.00',
        revenue: '5000.00',
        net: '1000.00',
        cumulativeNet: '-11000.00',
      },
      {
        month: '2026-03',
        cost: '500.00',
        revenue: '12000.00',
        net: '11500.00',
        cumulativeNet: '500.00',
      },
    ]);
  });

  test('categories with shares', () => {
    // 14,000/16,500 = 84.85% → 84.8 ; 2,000/16,500 = 12.12% → 12.1 ; 500/16,500 = 3.03% → 3.0
    expect(report.costsByCategory).toEqual([
      { category: 'salary_player', amount: '14000.00', sharePercent: '84.8' },
      { category: 'flights_travel', amount: '2000.00', sharePercent: '12.1' },
      { category: 'visas', amount: '500.00', sharePercent: '3.0' },
    ]);
    // 12,000/17,000 = 70.59% → 70.6 ; 5,000/17,000 = 29.41% → 29.4
    expect(report.revenueByCategory).toEqual([
      { category: 'prize_money', amount: '12000.00', sharePercent: '70.6' },
      { category: 'sponsorship_fixed', amount: '5000.00', sharePercent: '29.4' },
    ]);
  });

  test('break-even and payback (first cost Jan, cumulative ≥ 0 in Mar ⇒ 3 months)', () => {
    expect(report.breakEven).toEqual({
      status: 'covered',
      firstCostMonth: '2026-01',
      firstBreakEvenMonth: '2026-03',
      paybackMonths: 3,
      currentPosition: '500.00',
      revenueNeeded: '0.00',
    });
  });

  test('break-even not reached ⇒ revenue still needed', () => {
    const partial = buildFinancialReport({
      baseCurrency: 'SAR',
      scope: { kind: 'team', id: 't1', name: 'T' },
      period: { from: null, to: null },
      rateMode: 'snapshot',
      asOf: '2026-02-28',
      entries: LEDGER.filter((e) => e.date < '2026-03-01'),
      scenarios: SCEN,
      scenarioDefaults: SCEN,
      usedPayrollProjection: false,
      missingCurrentRates: [],
    });
    expect(partial.breakEven).toMatchObject({
      status: 'not_covered',
      firstBreakEvenMonth: null,
      paybackMonths: null,
      currentPosition: '-11000.00',
      revenueNeeded: '11000.00',
    });
  });

  test('money received up front that costs later use up is not break-even', () => {
    // Jan: cost 1000, revenue 3000 (cum +2000) · Feb: cost 1500 (+500) · Mar: cost 1000 (−500)
    // · Apr: revenue 1000 (+500). Covered for good only from April ⇒ payback 4 months.
    const months = [
      { month: '2026-01', cost: '1000.00', cumulativeNet: '2000.00' },
      { month: '2026-02', cost: '1500.00', cumulativeNet: '500.00' },
      { month: '2026-03', cost: '1000.00', cumulativeNet: '-500.00' },
      { month: '2026-04', cost: '0.00', cumulativeNet: '500.00' },
    ];
    expect(analyzeBreakEven(months, 'USD')).toMatchObject({
      status: 'covered',
      firstBreakEvenMonth: '2026-04',
      paybackMonths: 4,
    });
    // Ending March (−500): positive in January, but not break-even now.
    expect(analyzeBreakEven(months.slice(0, 3), 'USD')).toMatchObject({
      status: 'not_covered',
      firstBreakEvenMonth: null,
      paybackMonths: null,
      revenueNeeded: '500.00',
    });
  });

  test('projections are listed separately, split by certainty', () => {
    expect(report.projections.certain).toBe('3000.00');
    expect(report.projections.uncertain).toBe('8000.00');
    expect(report.projections.items.map((i) => i.id)).toEqual(['u1', 'u2']);
    // …and never appear in the monthly series (which ends in March).
    expect(report.monthly.at(-1)!.month).toBe('2026-03');
  });

  test('tax amounts do not exist in the engine: only baseAmount is ever summed', () => {
    expect(report.footnotes.map((f) => f.key)).toContain('tax_not_calculated');
  });

  test('organization-scope report breaks costs down by team', () => {
    const org = buildFinancialReport({
      baseCurrency: 'SAR',
      scope: { kind: 'organization', id: null, name: 'Org' },
      period: { from: null, to: null },
      rateMode: 'snapshot',
      asOf: '2026-04-16',
      entries: [
        ...LEDGER,
        entry({
          id: 'o1',
          kind: 'expense',
          date: '2026-02-01',
          category: 'equipment_operational',
          baseAmount: '700.00',
          teamId: null,
          teamName: null,
        }),
      ],
      scenarios: SCEN,
      scenarioDefaults: SCEN,
      usedPayrollProjection: false,
      missingCurrentRates: [],
    });
    expect(org.byTeam).toEqual([
      { teamId: null, teamName: null, cost: '700.00', revenue: '0.00', net: '-700.00' },
      { teamId: 't1', teamName: 'Team One', cost: '16500.00', revenue: '17000.00', net: '500.00' },
    ]);
  });

  test('a period filter fills empty months with zeros', () => {
    const r = buildFinancialReport({
      baseCurrency: 'SAR',
      scope: { kind: 'team', id: 't1', name: 'T' },
      period: { from: '2025-12-01', to: '2026-01-31' },
      rateMode: 'snapshot',
      asOf: '2026-04-16',
      entries: LEDGER.filter((e) => e.date <= '2026-01-31'),
      scenarios: SCEN,
      scenarioDefaults: SCEN,
      usedPayrollProjection: false,
      missingCurrentRates: [],
    });
    expect(r.monthly.map((m) => [m.month, m.cost])).toEqual([
      ['2025-12', '0.00'],
      ['2026-01', '12000.00'],
    ]);
  });
});

describe('scenario projection', () => {
  test('reaches break-even within the horizon', () => {
    // start −11,000; one-off +2,000; net 3,000 − 1,000 = 2,000/month
    // positions: −7,000 −5,000 −3,000 −1,000 +1,000 +3,000 ⇒ month 5 (Aug 2026)
    // required R = 1,000 − (−11,000 + 2,000)/6 = 1,000 + 1,500 = 2,500
    const r = projectScenario(
      '-11000.00',
      '2026-03',
      flat('3000.00', '1000.00', '2000.00', 6),
      'SAR',
    );
    expect(r.months.map((m) => m.position)).toEqual([
      '-7000.00',
      '-5000.00',
      '-3000.00',
      '-1000.00',
      '1000.00',
      '3000.00',
    ]);
    expect(r).toMatchObject({
      outcome: 'reaches_break_even',
      monthsToBreakEven: 5,
      breakEvenMonth: '2026-08',
      endPosition: '3000.00',
      lowestPosition: '-11000.00',
      requiredMonthlyRevenue: '2500.00',
      monthlyNet: '2000.00',
    });
  });

  test('beyond the horizon is estimated in closed form', () => {
    // Same inputs, 3-month horizon: ceil(9,000 / 2,000) = 5 ; required = 1,000 + 9,000/3 = 4,000
    const r = projectScenario(
      '-11000.00',
      '2026-03',
      flat('3000.00', '1000.00', '2000.00', 3),
      'SAR',
    );
    expect(r).toMatchObject({
      outcome: 'beyond_horizon',
      monthsToBreakEven: 5,
      requiredMonthlyRevenue: '4000.00',
    });
  });

  test('never, when monthly net is not positive', () => {
    const r = projectScenario(
      '-11000.00',
      '2026-03',
      flat('1000.00', '1000.00', '2000.00', 6),
      'SAR',
    );
    expect(r).toMatchObject({
      outcome: 'never',
      monthsToBreakEven: null,
      breakEvenMonth: null,
      requiredMonthlyRevenue: '2500.00',
    });
  });

  test('already covered; required revenue rounds UP', () => {
    // required = 800 − 500/6 = 716.666… → 716.67 (rounded up so it is never short)
    const r = projectScenario('500.00', '2026-03', flat('1000.00', '800.00', '0.00', 6), 'SAR');
    expect(r).toMatchObject({
      outcome: 'already_covered',
      monthsToBreakEven: 0,
      requiredMonthlyRevenue: '716.67',
    });
  });

  test('covered today but falling below zero counts as never', () => {
    // 500 − 200/month: 300, 100, −100 … never recovers
    const r = projectScenario('500.00', '2026-03', flat('0.00', '200.00', '0.00', 6), 'SAR');
    expect(r.outcome).toBe('never');
  });

  test('required revenue is floored at zero', () => {
    const r = projectScenario('100000.00', '2026-03', flat('0.00', '100.00', '0.00', 12), 'SAR');
    expect(r.requiredMonthlyRevenue).toBe('0.00');
  });
});

describe('scenario starting values come only from the data', () => {
  // as of 16 Apr 2026 ⇒ window Jan–Mar 2026.
  // realized revenue 17,000/3 = 5,666.67 ; costs 16,500/3 = 5,500 ; non-salary (2,000+500)/3 = 833.33…
  test('without payroll', () => {
    const s = deriveScenarioDefaults({
      baseCurrency: 'SAR',
      asOf: '2026-04-16',
      entries: LEDGER,
      projectedMonthlyPayroll: null,
    });
    expect(s.pessimistic).toEqual({
      monthlyRevenue: '0.00',
      monthlyCost: '5500.00',
      oneOffRevenue: '3000.00',
      oneOffCost: '0.00',
      horizonMonths: 12,
    });
    expect(s.base).toEqual({
      monthlyRevenue: '5666.67',
      monthlyCost: '5500.00',
      oneOffRevenue: '3000.00',
      oneOffCost: '0.00',
      horizonMonths: 12,
    });
    expect(s.optimistic).toEqual({
      monthlyRevenue: '5666.67',
      monthlyCost: '5500.00',
      oneOffRevenue: '11000.00',
      oneOffCost: '0.00',
      horizonMonths: 12,
    });
  });

  test('with projected payroll: payroll + average non-salary costs', () => {
    // 6,750 + 833.333… = 7,583.33
    const s = deriveScenarioDefaults({
      baseCurrency: 'SAR',
      asOf: '2026-04-16',
      entries: LEDGER,
      projectedMonthlyPayroll: '6750.00',
    });
    expect(s.base.monthlyCost).toBe('7583.33');
  });
});

describe('budget variance', () => {
  test('planned − actual, per line and total', () => {
    // total 10,000 vs 8,500 + 300 + 1,000 = 9,800 ⇒ +200, 98.0% used
    // salary line 8,000 vs 8,500 ⇒ −500, over, 106.25% → 106.3
    // visas 500 vs 300 ⇒ +200, 60.0%
    const v = computeBudgetVariance(
      {
        total: '10000.00',
        lines: [
          { category: 'salary_player', amount: '8000.00' },
          { category: 'visas', amount: '500.00' },
        ],
      },
      [
        { category: 'salary_player', baseAmount: '8500.00' },
        { category: 'visas', baseAmount: '300.00' },
        { category: 'flights_travel', baseAmount: '1000.00' },
      ],
      'SAR',
    );
    expect(v.total).toEqual({
      category: null,
      planned: '10000.00',
      actual: '9800.00',
      variance: '200.00',
      usedPercent: '98.0',
      over: false,
    });
    expect(v.lines).toEqual([
      {
        category: 'salary_player',
        planned: '8000.00',
        actual: '8500.00',
        variance: '-500.00',
        usedPercent: '106.3',
        over: true,
      },
      {
        category: 'visas',
        planned: '500.00',
        actual: '300.00',
        variance: '200.00',
        usedPercent: '60.0',
        over: false,
      },
    ]);
  });
});

describe('footnotes', () => {
  test('render with parameters in both languages', () => {
    expect(footnoteText('en', 'rounding', { currency: 'SAR' })).toContain('SAR');
    expect(footnoteText('ar', 'current_rate_missing', { currencies: 'EUR' })).toContain('EUR');
  });
});
