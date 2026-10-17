/**
 * Phase 2 — budgets and alerts, the report engine through the API (realized vs projected,
 * break-even, scenarios, payroll), and exports in all four formats carrying the same numbers as
 * the JSON report the dashboard shows.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  DEFAULT_ROLE_TEMPLATES,
  type BudgetDto,
  categoryLabel,
  type FinancialReport,
  type LedgerEntryDto,
  PERMISSIONS,
  type PermissionKey,
} from '@esports/shared';
import { and, eq } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { auditLogs, notifications } from '../src/db/schema';
import { parseFrankfurter } from '../src/finance/fx.provider';
import { FakeClock, FakeFx, expense, financeOrg, revenue, withRole } from './finance-fixtures';
import { type Client, startApp, type TestApp } from './harness';

const fx = new FakeFx();
const clock = new FakeClock();
let t: TestApp;
beforeAll(async () => {
  t = await startApp({ fx, clock });
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.reset();
  fx.reset();
  clock.now = '2026-05-10';
});

const alertsFor = async (userId: string) =>
  t.db
    .select()
    .from(notifications)
    .where(
      and(eq(notifications.recipientUserId, userId), eq(notifications.type, 'budget.exceeded')),
    );

describe('budgets: variance and one alert per crossing', () => {
  test('alerts reach the people who can see the budget, once, and re-arm after recovery', async () => {
    const { owner, ownerId, teamA, teamB } = await financeOrg(t);
    const { me: head } = await withRole(t, owner, 'head@example.com', 'head_of_esports', {
      type: 'organization',
    });
    const { client: mgrA, me: mgrAMe } = await withRole(
      t,
      owner,
      'a@example.com',
      'esports_manager',
      { type: 'team', id: teamA.id },
    );
    const { me: mgrBMe } = await withRole(t, owner, 'b@example.com', 'esports_manager', {
      type: 'team',
      id: teamB.id,
    });

    // Managers can see budgets for their team but cannot set them.
    expect(
      (await mgrA.post('/finance/budgets', { name: 'X', teamId: teamA.id, total: '1' })).status,
    ).toBe(403);
    const budget = await owner.post<BudgetDto>('/finance/budgets', {
      name: 'Team A — Split 1',
      teamId: teamA.id,
      total: '1000',
      lines: [{ category: 'salary_player', amount: '500' }],
    });
    expect(budget.status).toBe(201);
    expect(budget.body.currency).toBe('USD');
    const id = budget.body.id;

    const cost = async (amount: string, category = 'salary_player') =>
      (
        await mgrA.post<LedgerEntryDto>(
          '/finance/expenses',
          expense({ teamId: teamA.id, amount, category }),
        )
      ).body;

    await cost('400');
    expect(await alertsFor(ownerId)).toHaveLength(0);
    const c200 = await cost('200'); // salary line 600 > 500 → line alert
    const c50 = await cost('50'); // still over → no second alert
    const recipients = [ownerId, head.user.id, mgrAMe.user.id];
    for (const u of recipients) {
      const a = await alertsFor(u);
      expect(a).toHaveLength(1);
      expect(a[0]!.data).toMatchObject({
        budgetId: id,
        category: 'salary_player',
        planned: '500.00',
        actual: '600.00',
        overBy: '100.00',
        currency: 'USD',
      });
      expect(a[0]!.link).toBe('/dashboard/finance/budgets');
    }
    expect(await alertsFor(mgrBMe.user.id)).toHaveLength(0);

    const eq500 = await cost('500', 'equipment_operational'); // total 1150 > 1000 → total alert
    for (const u of recipients) expect(await alertsFor(u)).toHaveLength(2);

    const view = (await mgrA.get<BudgetDto>(`/finance/budgets/${id}`)).body;
    expect(view.over).toBe(true);
    expect(view.variance.total).toEqual({
      category: null,
      planned: '1000.00',
      actual: '1150.00',
      variance: '-150.00',
      usedPercent: '115.0',
      over: true,
    });
    expect(view.variance.lines).toEqual([
      {
        category: 'salary_player',
        planned: '500.00',
        actual: '650.00',
        variance: '-150.00',
        usedPercent: '130.0',
        over: true,
      },
    ]);

    // Back within plan → re-armed; the next crossing alerts again.
    for (const e of [c200, c50, eq500])
      expect((await owner.del(`/finance/expenses/${e.id}`)).status).toBe(204);
    expect((await mgrA.get<BudgetDto>(`/finance/budgets/${id}`)).body.over).toBe(false);
    await cost('300');
    for (const u of recipients) expect(await alertsFor(u)).toHaveLength(3);

    const audited = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'budget.exceeded'), eq(auditLogs.targetId, id)));
    expect(audited).toHaveLength(3);
    expect(audited[0]!.actorType).toBe('system');
  });

  test('an organization budget counts every cost and alerts organization-wide viewers only', async () => {
    const { owner, ownerId, teamA } = await financeOrg(t);
    const { client: mgrA, me: mgrAMe } = await withRole(
      t,
      owner,
      'a@example.com',
      'esports_manager',
      { type: 'team', id: teamA.id },
    );
    const b = (
      await owner.post<BudgetDto>('/finance/budgets', {
        name: 'Whole org 2026',
        total: '100',
        periodStart: '2026-01-01',
        periodEnd: '2026-12-31',
      })
    ).body;
    expect((await mgrA.get<BudgetDto[]>('/finance/budgets')).body).toHaveLength(0);
    expect((await mgrA.get(`/finance/budgets/${b.id}`)).status).toBe(404);

    await owner.post('/finance/expenses', expense({ date: '2025-12-31', amount: '500' })); // outside the period
    await mgrA.post('/finance/expenses', expense({ teamId: teamA.id, amount: '150' }));
    expect(await alertsFor(ownerId)).toHaveLength(1);
    expect(await alertsFor(mgrAMe.user.id)).toHaveLength(0);
    expect(
      (await owner.get<BudgetDto>(`/finance/budgets/${b.id}`)).body.variance.total.actual,
    ).toBe('150.00');
    // Budgets also lock the reporting currency.
    expect((await owner.patch('/finance/settings', { baseCurrency: 'SAR' })).status).toBe(409);
  });
});

async function seedReportData(owner: Client, teamA: string) {
  await owner.post(
    '/finance/expenses',
    expense({ teamId: teamA, category: 'salary_player', amount: '5000', date: '2026-01-15' }),
  );
  await owner.post(
    '/finance/expenses',
    expense({ teamId: teamA, category: 'salary_player', amount: '5000', date: '2026-02-15' }),
  );
  // Tax is recorded only: it must never change a total.
  await owner.post(
    '/finance/expenses',
    expense({
      teamId: teamA,
      category: 'equipment_operational',
      amount: '2000',
      date: '2026-03-15',
      taxAmount: '300',
      taxJurisdiction: 'SA',
    }),
  );
  await owner.post(
    '/finance/expenses',
    expense({
      category: 'other_expense',
      amount: '500',
      date: '2026-02-20',
      description: 'Legal, setup',
    }),
  );
  await owner.post(
    '/finance/revenue',
    revenue({ teamId: teamA, category: 'sponsorship_fixed', amount: '9000', date: '2026-03-25' }),
  );
  await owner.post(
    '/finance/revenue',
    revenue({ teamId: teamA, category: 'prize_money', amount: '4000', date: '2026-04-10' }),
  );
  // Not received yet: projections only.
  await owner.post(
    '/finance/revenue',
    revenue({
      teamId: teamA,
      category: 'sponsorship_fixed',
      amount: '6000',
      date: '2026-11-01',
      realized: false,
      certainty: 'certain',
    }),
  );
  await owner.post(
    '/finance/revenue',
    revenue({
      teamId: teamA,
      category: 'prize_money',
      amount: '10000',
      date: '2026-12-01',
      realized: false,
      certainty: 'uncertain',
    }),
  );
}

describe('financial report: transparent cost vs realized revenue', () => {
  test('totals, months, break-even, projections and scenario starting values', async () => {
    const { owner, teamA } = await financeOrg(t);
    await seedReportData(owner, teamA.id);
    const r = (await owner.get<FinancialReport>('/finance/reports?scope=organization')).body;

    expect(r.totals).toEqual({ cost: '12500.00', realizedRevenue: '13000.00', net: '500.00' });
    expect(r.costsByCategory).toEqual([
      { category: 'salary_player', amount: '10000.00', sharePercent: '80.0' },
      { category: 'equipment_operational', amount: '2000.00', sharePercent: '16.0' },
      { category: 'other_expense', amount: '500.00', sharePercent: '4.0' },
    ]);
    expect(r.monthly.map((m) => [m.month, m.cost, m.revenue, m.cumulativeNet])).toEqual([
      ['2026-01', '5000.00', '0.00', '-5000.00'],
      ['2026-02', '5500.00', '0.00', '-10500.00'],
      ['2026-03', '2000.00', '9000.00', '-3500.00'],
      ['2026-04', '0.00', '4000.00', '500.00'],
    ]);
    expect(r.breakEven).toEqual({
      status: 'covered',
      firstCostMonth: '2026-01',
      firstBreakEvenMonth: '2026-04',
      paybackMonths: 4,
      currentPosition: '500.00',
      revenueNeeded: '0.00',
    });
    expect(r.projections.certain).toBe('6000.00');
    expect(r.projections.uncertain).toBe('10000.00');
    expect(r.byTeam).toEqual([
      { teamId: null, teamName: null, cost: '500.00', revenue: '0.00', net: '-500.00' },
      {
        teamId: teamA.id,
        teamName: 'Valorant Team A',
        cost: '12000.00',
        revenue: '13000.00',
        net: '1000.00',
      },
    ]);
    // No ROI score anywhere: only the inputs and their difference.
    expect(JSON.stringify(r)).not.toMatch(/roi|score/i);

    // Starting values from the last 3 full months before May (Feb–Apr), no payroll on file.
    expect(r.scenarioDefaults.base).toEqual({
      monthlyRevenue: '4333.33',
      monthlyCost: '2500.00',
      oneOffRevenue: '6000.00',
      oneOffCost: '0.00',
      horizonMonths: 12,
    });
    expect(r.scenarioDefaults.pessimistic.monthlyRevenue).toBe('0.00');
    expect(r.scenarioDefaults.optimistic.oneOffRevenue).toBe('16000.00');
    expect(r.scenariosCustomized).toBe(false);
    expect(r.footnotes.map((f) => f.key)).toEqual([
      'rates_snapshot',
      'realized_only',
      'projections_separate',
      'break_even_definition',
      'payback_definition',
      'scenario_definition',
      'scenario_defaults',
      'tax_not_calculated',
      'rounding',
    ]);

    // Team and tournament scopes see only their own rows.
    const team = (
      await owner.get<FinancialReport>(`/finance/reports?scope=team&scopeId=${teamA.id}`)
    ).body;
    expect(team.totals).toEqual({ cost: '12000.00', realizedRevenue: '13000.00', net: '1000.00' });
    expect(team.byTeam).toBeNull();
    const ranged = (
      await owner.get<FinancialReport>(
        '/finance/reports?scope=organization&from=2026-03-01&to=2026-03-31',
      )
    ).body;
    expect(ranged.totals).toEqual({ cost: '2000.00', realizedRevenue: '9000.00', net: '7000.00' });

    // Tournament scope: only records linked to the tournament; break-even and payback per event.
    const tour = (await owner.post('/tournaments', { name: 'Riyadh Masters', teamIds: [teamA.id] }))
      .body as { id: string };
    await owner.post(
      '/finance/expenses',
      expense({
        teamId: teamA.id,
        category: 'tournament_fees',
        amount: '1500',
        date: '2026-05-02',
        tournamentId: tour.id,
      }),
    );
    await owner.post(
      '/finance/expenses',
      expense({
        teamId: teamA.id,
        category: 'flights_travel',
        amount: '3500',
        date: '2026-06-01',
        tournamentId: tour.id,
      }),
    );
    await owner.post(
      '/finance/revenue',
      revenue({
        teamId: teamA.id,
        category: 'prize_money',
        amount: '8000',
        date: '2026-07-10',
        tournamentId: tour.id,
      }),
    );
    const event = (
      await owner.get<FinancialReport>(`/finance/reports?scope=tournament&scopeId=${tour.id}`)
    ).body;
    expect(event.scope).toEqual({ kind: 'tournament', id: tour.id, name: 'Riyadh Masters' });
    expect(event.totals).toEqual({ cost: '5000.00', realizedRevenue: '8000.00', net: '3000.00' });
    expect(event.breakEven).toMatchObject({
      status: 'covered',
      firstCostMonth: '2026-05',
      firstBreakEvenMonth: '2026-07',
      paybackMonths: 3,
    });
  });

  test('payroll from roster pay terms feeds the cost starting value', async () => {
    const { owner, teamA } = await financeOrg(t);
    await seedReportData(owner, teamA.id);
    await owner.post('/roster-members', {
      teamId: teamA.id,
      fullName: 'Saad',
      role: 'starter',
      compensation: {
        currency: 'SAR',
        amount: '11250',
        frequency: 'monthly',
        contractStart: '2026-01-01',
      },
    });
    const r = (await owner.get<FinancialReport>('/finance/reports?scope=organization')).body;
    // 11,250 SAR × 0.266666666667 = 3,000.00 USD a month + non-salary average (2000 + 500) / 3.
    expect(r.scenarioDefaults.base.monthlyCost).toBe('3833.33');
    expect(r.footnotes.map((f) => f.key)).toContain('payroll_projection');
    expect(r.footnotes.map((f) => f.key)).not.toContain('payroll_no_rate');

    // Pay that can't be projected is left out — and the report says so.
    await owner.patch('/finance/settings', { enabledCurrencies: ['USD', 'SAR', 'EUR'] });
    await owner.post('/roster-members', {
      teamId: teamA.id,
      fullName: 'Coach',
      role: 'head_coach',
      compensation: { currency: 'EUR', amount: '5000', frequency: 'monthly' },
    });
    await owner.post('/roster-members', {
      teamId: teamA.id,
      fullName: 'Caster',
      role: 'staff',
      compensation: { currency: 'USD', amount: '300', frequency: 'per_event' },
    });
    const r2 = (await owner.get<FinancialReport>('/finance/reports?scope=organization')).body;
    expect(r2.scenarioDefaults.base.monthlyCost).toBe('3833.33');
    expect(r2.footnotes).toContainEqual({ key: 'payroll_no_rate', params: { currencies: 'EUR' } });
    expect(r2.footnotes).toContainEqual({ key: 'payroll_not_periodic', params: { count: '1' } });
  });

  test('scenario inputs can be saved for everyone and reset to the calculated values', async () => {
    const { owner, teamA } = await financeOrg(t);
    await seedReportData(owner, teamA.id);
    const r = (await owner.get<FinancialReport>('/finance/reports?scope=organization')).body;
    const edited = {
      ...r.scenarioDefaults,
      base: { ...r.scenarioDefaults.base, monthlyRevenue: '5000.00' },
    };
    expect(
      (await owner.put('/finance/scenarios', { scope: 'organization', scenarios: edited })).status,
    ).toBe(204);
    const saved = (await owner.get<FinancialReport>('/finance/reports?scope=organization')).body;
    expect(saved.scenariosCustomized).toBe(true);
    expect(saved.scenarios.base.inputs.monthlyRevenue).toBe('5000.00');
    expect(saved.footnotes.map((f) => f.key)).toContain('scenario_customized');

    const { client: mgr } = await withRole(t, owner, 'mgr@example.com', 'esports_manager', {
      type: 'team',
      id: teamA.id,
    });
    expect(
      (await mgr.put('/finance/scenarios', { scope: 'team', scopeId: teamA.id, scenarios: edited }))
        .status,
    ).toBe(403);

    expect((await owner.del('/finance/scenarios?scope=organization')).status).toBe(204);
    expect(
      (await owner.get<FinancialReport>('/finance/reports?scope=organization')).body
        .scenariosCustomized,
    ).toBe(false);
  });
});

describe('exports carry the same numbers as the on-screen report', () => {
  const ISOLATES = /[⁦-⁩]/g;
  const dir = mkdtempSync(join(tmpdir(), 'esports-export-'));

  async function exportFile(
    c: Client,
    format: string,
    locale = 'en',
    extra: Record<string, unknown> = {},
  ) {
    const res = await fetch(`${t.baseUrl}/finance/reports/export`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost:3000',
        cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      },
      body: JSON.stringify({ query: { scope: 'organization' }, format, locale, ...extra }),
    });
    return {
      status: res.status,
      type: res.headers.get('content-type'),
      disposition: res.headers.get('content-disposition'),
      body: Buffer.from(await res.arrayBuffer()),
    };
  }

  test('CSV, TXT, XLSX and PDF', async () => {
    const { owner, teamA } = await financeOrg(t);
    await seedReportData(owner, teamA.id);
    const report = (await owner.get<FinancialReport>('/finance/reports?scope=organization')).body;

    // CSV: machine-readable values, sectioned.
    const csv = await exportFile(owner, 'csv');
    expect(csv.status).toBe(200);
    expect(csv.type).toContain('text/csv');
    expect(csv.disposition).toBe(
      'attachment; filename="financial-report-organization-riyadh-falcons-2026-05-10.csv"',
    );
    const lines = csv.body.toString('utf8').replace(/^﻿/, '').split('\r\n');
    expect(lines).toContain(`Total costs,${report.totals.cost}`);
    expect(lines).toContain(`Realized revenue,${report.totals.realizedRevenue}`);
    expect(lines).toContain(`Net result (realized revenue − costs),${report.totals.net}`);
    expect(lines).toContain('Costs by category');
    expect(lines).toContain(`${categoryLabel('en', 'salary_player')},10000.00,80.0`);
    for (const m of report.monthly)
      expect(lines).toContain(`${m.month},${m.cost},${m.revenue},${m.net},${m.cumulativeNet}`);
    expect(lines).toContain('Payback period (months),4');
    // Commas inside a description are quoted, and the 8 transactions are all present.
    expect(lines.some((l) => l.includes('"Legal, setup"'))).toBe(true);
    expect(lines.filter((l) => /^2026-\d\d-\d\d,(Cost|Revenue),/.test(l))).toHaveLength(
      report.entries.length,
    );

    // TXT: formatted exactly like the dashboard.
    const txt = (await exportFile(owner, 'txt')).body.toString('utf8');
    for (const v of [
      'USD 12,500.00',
      'USD 13,000.00',
      'USD 500.00',
      'USD 6,000.00',
      'USD 10,000.00',
      'Apr 2026',
    ])
      expect(txt).toContain(v);
    expect(txt).toContain(
      'No tax (Zakat, corporate income tax, VAT or withholding) is calculated.',
    );
    expect(txt).not.toMatch(ISOLATES);

    // XLSX: real numbers, one sheet per table.
    const xlsx = await exportFile(owner, 'xlsx');
    expect(xlsx.type).toContain('spreadsheetml');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.body as never);
    const summary = wb.getWorksheet('Summary')!;
    expect(summary.getCell('B2').value).toBe(12500);
    expect(summary.getCell('B2').numFmt).toContain('USD');
    expect(summary.getCell('B4').value).toBe(500);
    const monthly = wb.getWorksheet('By month')!;
    expect(monthly.getCell('E5').value).toBe(500);
    expect(wb.getWorksheet('Transactions')!.rowCount).toBe(1 + report.entries.length);

    // PDF: rendered with embedded fonts; text layer has the same figures.
    const pdf = await exportFile(owner, 'pdf');
    expect(pdf.status).toBe(200);
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
    const pdfPath = join(dir, 'en.pdf');
    writeFileSync(pdfPath, pdf.body);
    const text = execFileSync('pdftotext', ['-layout', pdfPath, '-'])
      .toString('utf8')
      .replace(ISOLATES, '');
    for (const v of [
      'Financial report',
      'USD 12,500.00',
      'USD 13,000.00',
      'USD 500.00',
      'Payback period (months)',
    ])
      expect(text).toContain(v);
    const fonts = execFileSync('pdffonts', [pdfPath]).toString('utf8');
    expect(fonts).toMatch(/Plex/i);

    const audits = await t.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'finance.report_exported'));
    expect(audits.map((a) => (a.metadata as { format: string }).format).sort()).toEqual([
      'csv',
      'pdf',
      'txt',
      'xlsx',
    ]);
  }, 120_000);

  test('Arabic exports: right-to-left, same figures', async () => {
    const { owner, teamA } = await financeOrg(t);
    await seedReportData(owner, teamA.id);
    const csv = (await exportFile(owner, 'csv', 'ar')).body.toString('utf8');
    expect(csv).toContain('إجمالي التكاليف,12500.00');
    const xlsx = await exportFile(owner, 'xlsx', 'ar');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.body as never);
    const summary = wb.getWorksheet('الملخص')!;
    expect(summary.views[0]).toMatchObject({ rightToLeft: true });
    expect(summary.getCell('B2').value).toBe(12500);
    const pdf = await exportFile(owner, 'pdf', 'ar');
    expect(pdf.status).toBe(200);
    const p = join(dir, 'ar.pdf');
    writeFileSync(p, pdf.body);
    const text = execFileSync('pdftotext', [p, '-'])
      .toString('utf8')
      .replace(ISOLATES, '')
      .normalize('NFKC');
    expect(text).toContain('12,500.00');
    expect(text).toContain('13,000.00');
    expect(readFileSync(p).length).toBeGreaterThan(10_000);
  }, 120_000);

  test('the on-screen scenario inputs (even unsaved) are what the file shows', async () => {
    const { owner, teamA } = await financeOrg(t);
    await seedReportData(owner, teamA.id);
    const r = (await owner.get<FinancialReport>('/finance/reports?scope=organization')).body;
    const scenarios = {
      ...r.scenarioDefaults,
      optimistic: { ...r.scenarioDefaults.optimistic, monthlyRevenue: '9876.54' },
    };
    const csv = (await exportFile(owner, 'csv', 'en', { scenarios })).body.toString('utf8');
    expect(csv).toContain('Monthly revenue,0.00,4333.33,9876.54');
    expect(csv).toContain('Scenario inputs were edited by a user');
  });

  test('export needs finance.export at the report scope', async () => {
    const { owner, teamA } = await financeOrg(t);
    const { client: ops } = await withRole(t, owner, 'ops@example.com', 'esports_operations', {
      type: 'organization',
    });
    expect((await exportFile(ops, 'csv')).status).toBe(403);
    const { client: mgr } = await withRole(t, owner, 'mgr@example.com', 'esports_manager', {
      type: 'team',
      id: teamA.id,
    });
    expect((await exportFile(mgr, 'csv')).status).toBe(403);
    const teamExport = await fetch(`${t.baseUrl}/finance/reports/export`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost:3000',
        cookie: [...mgr.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      },
      body: JSON.stringify({ query: { scope: 'team', scopeId: teamA.id }, format: 'txt' }),
    });
    expect(teamExport.status).toBe(200);
  });
});

describe('structural checks', () => {
  test('migration 0003 grants existing roles exactly the Phase 2 template permissions', () => {
    const sqlText = readFileSync(
      join(import.meta.dir, '../drizzle/0003_finance_hardening.sql'),
      'utf8',
    );
    const phase2 = new Set(['rosters', 'tournaments', 'finance']);
    const blocks = [
      ...sqlText.matchAll(/unnest\(ARRAY\[([\s\S]*?)\]\)[\s\S]*?template_key = '(\w+)'/g),
    ];
    const fromSql = Object.fromEntries(
      blocks.map((m) => [m[2]!, [...m[1]!.matchAll(/'([\w.]+)'/g)].map((x) => x[1]!).sort()]),
    );
    const fromTemplates = Object.fromEntries(
      DEFAULT_ROLE_TEMPLATES.filter((r) => r.templateKey !== 'owner')
        .map(
          (r) =>
            [
              r.templateKey,
              r.permissions
                .filter((p) => phase2.has(PERMISSIONS[p as PermissionKey].domain))
                .sort(),
            ] as const,
        )
        .filter(([, p]) => p.length),
    );
    expect(fromSql).toEqual(fromTemplates);
  });

  test('Frankfurter v2 response parsing', () => {
    const body = [{ date: '2026-10-01', base: 'SAR', quote: 'USD', rate: 0.26665 }];
    expect(parseFrankfurter(body, 'SAR', 'USD')).toEqual({
      rate: '0.26665',
      rateDate: '2026-10-01',
    });
    expect(parseFrankfurter(body, 'SAR', 'EUR')).toBeNull();
    expect(parseFrankfurter({ message: 'not found' }, 'SAR', 'USD')).toBeNull();
    expect(
      parseFrankfurter([{ date: 'x', base: 'SAR', quote: 'USD', rate: 1 }], 'SAR', 'USD'),
    ).toBeNull();
    expect(
      parseFrankfurter([{ date: '2026-10-01', base: 'SAR', quote: 'USD', rate: -1 }], 'SAR', 'USD'),
    ).toBeNull();
  });
});
