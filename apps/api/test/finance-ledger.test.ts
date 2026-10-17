/**
 * Phase 2 — ledger, scope hierarchy, multi-currency snapshotting, settings, seasons, rosters and
 * tournament research, through the real HTTP API.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type {
  FinancialReport,
  LedgerEntryDto,
  ReportScopeOption,
  RosterMemberDto,
  TournamentDto,
} from '@esports/shared';
import { and, eq } from 'drizzle-orm';
import { auditLogs } from '../src/db/schema';
import { FakeClock, FakeFx, expense, financeOrg, revenue, withRole } from './finance-fixtures';
import { registerOwner, startApp, type TestApp } from './harness';

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
  clock.now = '2026-10-15';
});

describe('scope hierarchy: organization → team → player', () => {
  test('a team-scoped manager records costs only for its own team and its players', async () => {
    const { owner, teamA, teamB } = await financeOrg(t);
    const { client: mgr } = await withRole(t, owner, 'mgr@example.com', 'esports_manager', {
      type: 'team',
      id: teamA.id,
    });
    const playerA = (
      await owner.post<RosterMemberDto>('/roster-members', {
        teamId: teamA.id,
        fullName: 'Saad A',
        role: 'starter',
      })
    ).body;
    const playerB = (
      await owner.post<RosterMemberDto>('/roster-members', {
        teamId: teamB.id,
        fullName: 'Omar B',
        role: 'starter',
      })
    ).body;

    // Team level and player level on the manager's team.
    const teamCost = await mgr.post<LedgerEntryDto>(
      '/finance/expenses',
      expense({ teamId: teamA.id }),
    );
    expect(teamCost.status).toBe(201);
    expect(teamCost.body.teamName).toBe('Valorant Team A');
    const playerCost = await mgr.post<LedgerEntryDto>(
      '/finance/expenses',
      expense({ teamId: teamA.id, rosterMemberId: playerA.id, category: 'flights_travel' }),
    );
    expect(playerCost.status).toBe(201);
    expect(playerCost.body.rosterMemberName).toBe('Saad A');

    // Another team, or organization level: not in scope.
    expect((await mgr.post('/finance/expenses', expense({ teamId: teamB.id }))).status).toBe(403);
    expect((await mgr.post('/finance/expenses', expense())).status).toBe(403);
    // A player must belong to the team the cost is recorded for.
    const mismatch = await mgr.post(
      '/finance/expenses',
      expense({ teamId: teamA.id, rosterMemberId: playerB.id }),
    );
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error.code).toBe('roster_member_mismatch');
    // Player level requires a team.
    expect(
      (await owner.post('/finance/expenses', expense({ rosterMemberId: playerA.id }))).status,
    ).toBe(400);

    // Owner records an organization-wide cost and one for team B.
    const orgCost = (
      await owner.post<LedgerEntryDto>('/finance/expenses', expense({ category: 'other_expense' }))
    ).body;
    const bCost = (
      await owner.post<LedgerEntryDto>('/finance/expenses', expense({ teamId: teamB.id }))
    ).body;

    // The manager sees only team A's rows; out-of-scope rows are indistinguishable from missing.
    const mine = await mgr.get<LedgerEntryDto[]>('/finance/expenses');
    expect(mine.body.map((e) => e.id).sort()).toEqual(
      [teamCost.body.id, playerCost.body.id].sort(),
    );
    expect((await mgr.get(`/finance/expenses/${bCost.id}`)).status).toBe(404);
    expect((await mgr.get(`/finance/expenses/${orgCost.id}`)).status).toBe(404);
    const all = await owner.get<LedgerEntryDto[]>('/finance/expenses');
    expect(all.body).toHaveLength(4);
    expect(
      (await owner.get<LedgerEntryDto[]>('/finance/expenses?teamId=none')).body.map((e) => e.id),
    ).toEqual([orgCost.id]);
    expect(
      (await owner.get<LedgerEntryDto[]>(`/finance/expenses?rosterMemberId=${playerA.id}`)).body,
    ).toHaveLength(1);

    // The manager template has no finance.edit / finance.delete.
    expect(
      (
        await mgr.patch(
          `/finance/expenses/${teamCost.body.id}`,
          expense({ teamId: teamA.id, amount: '5' }),
        )
      ).status,
    ).toBe(403);
    expect((await mgr.del(`/finance/expenses/${teamCost.body.id}`)).status).toBe(403);

    // Reports: own team yes; other team hidden; organization-wide needs organization-wide access.
    expect((await mgr.get(`/finance/reports?scope=team&scopeId=${teamA.id}`)).status).toBe(200);
    expect((await mgr.get(`/finance/reports?scope=team&scopeId=${teamB.id}`)).status).toBe(404);
    expect((await mgr.get('/finance/reports?scope=organization')).status).toBe(403);
    const scopes = (await mgr.get<ReportScopeOption[]>('/finance/reports/scopes')).body;
    expect(scopes).toEqual([
      { kind: 'team', id: teamA.id, name: 'Valorant Team A', departmentId: teamA.departmentId },
    ]);
  });

  test('moving a record to another team needs rights on both; every change is audited', async () => {
    const { owner, teamA, teamB } = await financeOrg(t);
    const { client: head } = await withRole(t, owner, 'head@example.com', 'head_of_esports', {
      type: 'team',
      id: teamA.id,
    });
    const e = (await head.post<LedgerEntryDto>('/finance/expenses', expense({ teamId: teamA.id })))
      .body;
    expect(
      (await head.patch(`/finance/expenses/${e.id}`, expense({ teamId: teamB.id }))).status,
    ).toBe(403);
    const ok = await head.patch<LedgerEntryDto>(
      `/finance/expenses/${e.id}`,
      expense({ teamId: teamA.id, amount: '250' }),
    );
    expect(ok.status).toBe(200);
    expect(ok.body.baseAmount).toBe('250.00');
    expect((await head.del(`/finance/expenses/${e.id}`)).status).toBe(204);

    const actions = (
      await t.db.select({ a: auditLogs.action }).from(auditLogs).where(eq(auditLogs.targetId, e.id))
    )
      .map((r) => r.a)
      .sort();
    expect(actions).toEqual([
      'finance.expense_created',
      'finance.expense_deleted',
      'finance.expense_updated',
    ]);
  });

  test('records referencing a team, player or tournament block deleting them (409 in_use)', async () => {
    const { owner, teamA, val } = await financeOrg(t);
    const p = (
      await owner.post<RosterMemberDto>('/roster-members', {
        teamId: teamA.id,
        fullName: 'Saad',
        role: 'starter',
      })
    ).body;
    const tour = (
      await owner.post<TournamentDto>('/tournaments', { name: 'Riyadh Masters', gameId: val })
    ).body;
    await owner.post(
      '/finance/expenses',
      expense({ teamId: teamA.id, rosterMemberId: p.id, tournamentId: tour.id }),
    );
    for (const path of [
      `/teams/${teamA.id}`,
      `/roster-members/${p.id}`,
      `/tournaments/${tour.id}`,
    ]) {
      const res = await owner.del(path);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('in_use');
    }
  });
});

describe('multi-currency: rates are snapshotted on each transaction', () => {
  test('the stored rate is used forever; "current" mode is a separate comparison view', async () => {
    const { owner } = await financeOrg(t);
    fx.rates.set('SAR>USD@2026-03-10', '0.266666666667');
    const e = await owner.post<LedgerEntryDto>(
      '/finance/expenses',
      expense({ amount: '3750', currency: 'SAR' }),
    );
    expect(e.status).toBe(201);
    expect(e.body).toMatchObject({
      amount: '3750',
      currency: 'SAR',
      rate: '0.266666666667',
      rateDate: '2026-03-10',
      rateSource: 'provider',
      baseAmount: '1000.00',
      baseCurrency: 'USD',
    });

    // The market moves. Stored figures do not.
    fx.rates.set('SAR>USD@2026-03-10', '0.2');
    fx.rates.set('SAR>USD@2026-10-15', '0.25');
    const snap = await owner.get<FinancialReport>('/finance/reports?scope=organization');
    expect(snap.body.totals.cost).toBe('1000.00');
    expect(snap.body.footnotes.map((f) => f.key)).toContain('rates_snapshot');
    const current = await owner.get<FinancialReport>(
      '/finance/reports?scope=organization&rateMode=current',
    );
    expect(current.body.totals.cost).toBe('937.50');
    expect(current.body.footnotes.map((f) => f.key)).toContain('rates_current');

    // Editing a field that is not currency/date keeps the stored rate…
    const edited = await owner.patch<LedgerEntryDto>(
      `/finance/expenses/${e.body.id}`,
      expense({ amount: '3750', currency: 'SAR', description: 'Monitors' }),
    );
    expect(edited.body.rate).toBe('0.266666666667');
    expect(edited.body.baseAmount).toBe('1000.00');
    // …changing the date takes that date's rate (cached per date; one provider call each).
    const moved = await owner.patch<LedgerEntryDto>(
      `/finance/expenses/${e.body.id}`,
      expense({ amount: '3750', currency: 'SAR', date: '2026-04-01' }),
    );
    expect(moved.body.rate).toBe('0.266666666667');
    expect(fx.calls.filter((c) => c === 'SAR>USD@2026-03-10')).toHaveLength(1);
  });

  test('no known rate → the user must enter one; manual rates are labelled as such', async () => {
    const { owner } = await financeOrg(t);
    fx.rates.clear();
    const missing = await owner.post(
      '/finance/expenses',
      expense({ amount: '500', currency: 'SAR' }),
    );
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatchObject({
      code: 'fx_rate_required',
      details: { currency: 'SAR', baseCurrency: 'USD', date: '2026-03-10' },
    });
    const manual = await owner.post<LedgerEntryDto>(
      '/finance/expenses',
      expense({ amount: '500', currency: 'SAR', rate: '0.2667' }),
    );
    expect(manual.status).toBe(201);
    expect(manual.body).toMatchObject({
      rate: '0.266700000000',
      rateSource: 'manual',
      baseAmount: '133.35',
    });

    // Only enabled currencies; the rate lookup endpoint reports "unknown" as null.
    const eur = await owner.post('/finance/expenses', expense({ currency: 'EUR' }));
    expect(eur.body.error.code).toBe('currency_not_enabled');
    const q = await owner.get('/finance/rates?currency=SAR&date=2026-03-10');
    expect(q.body).toMatchObject({ currency: 'SAR', baseCurrency: 'USD', rate: null });
  });

  test("future-dated (expected) income uses today's rate and says so", async () => {
    const { owner } = await financeOrg(t);
    const r = await owner.post<LedgerEntryDto>(
      '/finance/revenue',
      revenue({ date: '2027-02-01', amount: '37500', currency: 'SAR', realized: false }),
    );
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      rateDate: '2026-10-15',
      baseAmount: '10000.00',
      realized: false,
    });
    expect(fx.calls).toEqual(['SAR>USD@2026-10-15']);
  });

  test('three-decimal currencies round to their own minor unit', async () => {
    const { owner } = await financeOrg(t);
    await owner.patch('/finance/settings', {
      baseCurrency: 'KWD',
      enabledCurrencies: ['KWD', 'USD'],
    });
    fx.rates.set('USD>KWD', '0.30712');
    const e = await owner.post<LedgerEntryDto>('/finance/expenses', expense({ amount: '10.01' }));
    // 10.01 × 0.30712 = 3.0742712 → 3.074
    expect(e.body.baseAmount).toBe('3.074');
  });
});

describe('finance settings and seasons', () => {
  test('new organizations report in SAR, with SAR and USD enabled', async () => {
    const { client: owner } = await registerOwner(t);
    const s = await owner.get('/finance/settings');
    expect(s.body).toMatchObject({ baseCurrency: 'SAR', enabledCurrencies: ['SAR', 'USD'], baseCurrencyLocked: false });
  });

  test('the reporting currency locks once records exist; the base is always enabled', async () => {
    const { owner } = await financeOrg(t);
    const s = await owner.get('/finance/settings');
    expect(s.body).toMatchObject({
      baseCurrency: 'USD',
      enabledCurrencies: ['USD', 'SAR'],
      baseCurrencyLocked: false,
    });
    const changed = await owner.patch('/finance/settings', {
      baseCurrency: 'SAR',
      enabledCurrencies: ['USD'],
    });
    expect(changed.body.enabledCurrencies).toEqual(['SAR', 'USD']);
    await owner.patch('/finance/settings', { baseCurrency: 'USD' });

    await owner.post('/finance/expenses', expense());
    const locked = await owner.patch('/finance/settings', { baseCurrency: 'SAR' });
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe('base_currency_locked');
    // Enabling more currencies is still fine.
    expect(
      (await owner.patch('/finance/settings', { enabledCurrencies: ['USD', 'SAR', 'AED'] })).status,
    ).toBe(200);
  });

  test('seasons never overlap and entries are assigned to them by date', async () => {
    const { owner } = await financeOrg(t);
    const before = (
      await owner.post<LedgerEntryDto>('/finance/expenses', expense({ date: '2026-02-01' }))
    ).body;
    expect(before.seasonId).toBeNull();
    const s1 = await owner.post('/finance/seasons', {
      name: '2026 Split 1',
      startDate: '2026-01-01',
      endDate: '2026-06-30',
    });
    expect(s1.status).toBe(201);
    expect(
      (await owner.get<LedgerEntryDto>(`/finance/expenses/${before.id}`)).body.seasonName,
    ).toBe('2026 Split 1');
    const later = (
      await owner.post<LedgerEntryDto>('/finance/expenses', expense({ date: '2026-05-05' }))
    ).body;
    expect(later.seasonId).toBe(s1.body.id);
    const overlap = await owner.post('/finance/seasons', {
      name: 'Overlap',
      startDate: '2026-06-01',
      endDate: '2026-12-31',
    });
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.code).toBe('season_overlap');

    // Shrinking the season detaches entries now outside it.
    await owner.patch(`/finance/seasons/${s1.body.id}`, {
      name: '2026 Split 1',
      startDate: '2026-03-01',
      endDate: '2026-06-30',
    });
    expect(
      (await owner.get<LedgerEntryDto>(`/finance/expenses/${before.id}`)).body.seasonId,
    ).toBeNull();

    // A season report covers the season's own dates by default.
    const rep = await owner.get<FinancialReport>(
      `/finance/reports?scope=season&scopeId=${s1.body.id}`,
    );
    expect(rep.body.period).toEqual({ from: '2026-03-01', to: '2026-06-30' });
    expect(rep.body.totals.cost).toBe('100.00');
  });

  test('only finance.configure can change settings', async () => {
    const { owner } = await financeOrg(t);
    const { client: head } = await withRole(t, owner, 'head@example.com', 'head_of_esports', {
      type: 'organization',
    });
    expect((await head.patch('/finance/settings', { enabledCurrencies: ['USD'] })).status).toBe(
      403,
    );
    expect(
      (
        await head.post('/finance/seasons', {
          name: 'S',
          startDate: '2026-01-01',
          endDate: '2026-02-01',
        })
      ).status,
    ).toBe(403);
  });
});

describe('rosters and pay terms', () => {
  test('pay is visible only with finance.view and editable only with finance.edit', async () => {
    const { owner, teamA } = await financeOrg(t);
    const created = await owner.post<RosterMemberDto>('/roster-members', {
      teamId: teamA.id,
      fullName: 'Saad Al-Harbi',
      handle: 'saad',
      role: 'starter',
      compensation: {
        currency: 'SAR',
        amount: '15000',
        frequency: 'monthly',
        contractStart: '2026-01-01',
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.compensation).toMatchObject({
      currency: 'SAR',
      amount: '15000',
      frequency: 'monthly',
    });

    const { client: ops } = await withRole(t, owner, 'ops@example.com', 'esports_operations', {
      type: 'organization',
    });
    const opsView = await ops.get<RosterMemberDto[]>(`/teams/${teamA.id}/roster`);
    expect(opsView.status).toBe(200);
    expect(opsView.body[0]!.fullName).toBe('Saad Al-Harbi');
    expect(opsView.body[0]).not.toHaveProperty('compensation');

    const { client: mgr } = await withRole(t, owner, 'mgr@example.com', 'esports_manager', {
      type: 'team',
      id: teamA.id,
    });
    expect(
      (await mgr.get<RosterMemberDto>(`/roster-members/${created.body.id}`)).body.compensation
        ?.amount,
    ).toBe('15000');
    // finance.view but not finance.edit: roster fields yes, pay no.
    expect(
      (await mgr.patch(`/roster-members/${created.body.id}`, { position: 'IGL' })).status,
    ).toBe(200);
    expect(
      (
        await mgr.patch(`/roster-members/${created.body.id}`, {
          compensation: { currency: 'SAR', amount: '1', frequency: 'monthly' },
        })
      ).status,
    ).toBe(403);

    // Roster CSV: pay columns only for finance viewers.
    const csvMgr = await mgr.get(`/teams/${teamA.id}/roster/export.csv`);
    expect(csvMgr.text).toContain('pay_amount');
    expect(csvMgr.text).toContain('15000');

    // Moving teams is done by leaving and re-adding, so history stays with the team.
    const { teamB } = {
      teamB: (await owner.post('/teams', { name: 'Other' })).body as { id: string },
    };
    const move = await owner.patch(`/roster-members/${created.body.id}`, { teamId: teamB.id });
    expect(move.status).toBe(400);

    const audit = await t.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, 'roster.compensation_changed'),
          eq(auditLogs.targetId, created.body.id),
        ),
      );
    expect(audit).toHaveLength(1);
  });
});

describe('tournament research (manual entry)', () => {
  test('records source and last-verified date; only http(s) links; team links', async () => {
    const { owner, teamA, val } = await financeOrg(t);
    const bad = await owner.post('/tournaments', { name: 'X', sourceUrl: 'javascript:alert(1)' });
    expect(bad.status).toBe(400);
    const tour = await owner.post<TournamentDto>('/tournaments', {
      name: 'Riyadh Masters',
      organizer: 'Example Organizer',
      gameId: val,
      region: 'MENA',
      startDate: '2026-07-10',
      endDate: '2026-07-20',
      status: 'planned',
      entryFeeAmount: '500',
      entryFeeCurrency: 'USD',
      prizePoolAmount: '1000000',
      prizePoolCurrency: 'USD',
      placementRewards: [{ placement: '1st', amount: '400000', currency: 'USD' }],
      sourceUrl: 'https://example.com/riyadh-masters',
      lastVerifiedOn: '2026-10-01',
      teamIds: [teamA.id],
    });
    expect(tour.status).toBe(201);
    expect(tour.body).toMatchObject({
      sourceUrl: 'https://example.com/riyadh-masters',
      lastVerifiedOn: '2026-10-01',
      prizePoolAmount: '1000000',
      teams: [{ id: teamA.id, name: 'Valorant Team A' }],
    });
    // Manager can read but not write research.
    const { client: mgr } = await withRole(t, owner, 'mgr@example.com', 'esports_manager', {
      type: 'team',
      id: teamA.id,
    });
    expect((await mgr.get('/tournaments')).body).toHaveLength(1);
    expect((await mgr.post('/tournaments', { name: 'Nope' })).status).toBe(403);
  });
});
