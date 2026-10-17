/** Shared setup for the Phase 2 (finance) integration tests. */
import type { TeamDto } from '@esports/shared';
import type { Clock } from '../src/finance/clock';
import type { FxRateProvider, ProviderRate } from '../src/finance/fx.provider';
import {
  type Client,
  inviteAndAccept,
  registerOwner,
  roleIdByTemplate,
  type TestApp,
} from './harness';

/**
 * Deterministic stand-in for the exchange-rate service. Rates are looked up by
 * `BASE>QUOTE@date` first, then `BASE>QUOTE`; every call is recorded.
 */
export class FakeFx implements FxRateProvider {
  readonly name = 'frankfurter' as const;
  readonly calls: string[] = [];
  readonly rates = new Map<string, string>();

  async fetchRate(base: string, quote: string, date: string): Promise<ProviderRate | null> {
    this.calls.push(`${base}>${quote}@${date}`);
    const rate = this.rates.get(`${base}>${quote}@${date}`) ?? this.rates.get(`${base}>${quote}`);
    return rate ? { rate, rateDate: date } : null;
  }

  reset() {
    this.calls.length = 0;
    this.rates.clear();
    // 1 SAR = 1/3.75 USD (the riyal's peg) unless a test says otherwise.
    this.rates.set('SAR>USD', '0.266666666667');
  }
}

export class FakeClock implements Clock {
  now = '2026-10-15';
  today() {
    return this.now;
  }
}

export async function financeOrg(t: TestApp) {
  const { client: owner, me } = await registerOwner(t);
  // New organizations report in SAR (Phase 3 default). The Phase 2 suites were written around a
  // USD reporting currency, so they set it explicitly; the SAR default has its own test.
  const set = await owner.patch('/finance/settings', {
    baseCurrency: 'USD',
    enabledCurrencies: ['USD', 'SAR'],
  });
  if (set.status !== 200) throw new Error(`financeOrg: could not set USD (${set.status})`);
  const esports = (await owner.post('/departments', { name: 'Esports' })).body as { id: string };
  const games = (await owner.get('/games')).body as { id: string; name: string }[];
  const val = games.find((g) => g.name === 'VALORANT')!.id;
  const cs2 = games.find((g) => g.name === 'Counter-Strike 2')!.id;
  const teamA = (
    await owner.post('/teams', { name: 'Valorant Team A', departmentId: esports.id, gameId: val })
  ).body as TeamDto;
  const teamB = (
    await owner.post('/teams', { name: 'CS2 Team B', departmentId: esports.id, gameId: cs2 })
  ).body as TeamDto;
  return { owner, ownerId: me.user.id, esports, teamA, teamB, val };
}

/** Invite someone with a template role at one scope. */
export async function withRole(
  t: TestApp,
  owner: Client,
  email: string,
  template: 'head_of_esports' | 'esports_manager' | 'esports_operations',
  scope: { type: 'organization' } | { type: 'team' | 'department'; id: string },
) {
  const roleId = await roleIdByTemplate(owner, template);
  return inviteAndAccept(t, owner, email, [
    scope.type === 'organization'
      ? { roleId, scopeType: 'organization' }
      : { roleId, scopeType: scope.type, scopeId: scope.id },
  ]);
}

export const expense = (over: Record<string, unknown> = {}) => ({
  category: 'equipment_operational',
  date: '2026-03-10',
  amount: '100',
  currency: 'USD',
  ...over,
});

export const revenue = (over: Record<string, unknown> = {}) => ({
  category: 'sponsorship_fixed',
  date: '2026-03-20',
  amount: '100',
  currency: 'USD',
  realized: true,
  certainty: 'certain',
  ...over,
});
