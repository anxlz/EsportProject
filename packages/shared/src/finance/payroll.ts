/**
 * Payroll projection from roster compensation terms.
 *
 * Assumptions (also shown to users as footnote `payroll_projection`):
 * - Pay is converted to a monthly equivalent: weekly ×52/12, biweekly ×26/12, semimonthly ×2,
 *   monthly ×1, quarterly ÷3, annually ÷12. Per-event and one-time payments are NOT projected
 *   (they're listed separately because their timing is unknown).
 * - A month uses the season amount if any configured season overlaps it, otherwise the
 *   off-season amount (or the season amount when no off-season amount is set).
 * - A contract counts for a whole month if it is active on any day of that month (no proration).
 * - Projections convert at the CURRENT exchange rate (they're forward-looking; there is no
 *   transaction to snapshot yet).
 */
import type { PayFrequency } from './catalog.js';
import { type Amount, d, Dec, money } from './money.js';

export interface CompensationTerms {
  rosterMemberId: string;
  teamId: string;
  currency: string;
  amount: Amount;
  offSeasonAmount: Amount | null;
  frequency: PayFrequency;
  contractStart: string | null;
  contractEnd: string | null;
  /** Current rate: base-currency units per 1 unit of `currency`. Null when unknown. */
  currentRate: string | null;
}

export interface SeasonRange {
  startDate: string;
  endDate: string;
}

export function monthlyEquivalent(
  amount: Amount,
  frequency: PayFrequency,
): InstanceType<typeof Dec> | null {
  const a = d(amount);
  switch (frequency) {
    case 'weekly':
      return a.times(52).div(12);
    case 'biweekly':
      return a.times(26).div(12);
    case 'semimonthly':
      return a.times(2);
    case 'monthly':
      return a;
    case 'quarterly':
      return a.div(3);
    case 'annually':
      return a.div(12);
    case 'per_event':
    case 'one_time':
      return null;
  }
}

const monthStart = (m: string) => `${m}-01`;
function monthEnd(m: string): string {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return `${m}-${String(last).padStart(2, '0')}`;
}

export function monthInSeason(month: string, seasons: SeasonRange[]): boolean {
  const s = monthStart(month);
  const e = monthEnd(month);
  return seasons.some((x) => x.startDate <= e && x.endDate >= s);
}

export function contractActiveIn(
  month: string,
  t: Pick<CompensationTerms, 'contractStart' | 'contractEnd'>,
): boolean {
  return (
    (!t.contractStart || t.contractStart <= monthEnd(month)) &&
    (!t.contractEnd || t.contractEnd >= monthStart(month))
  );
}

export interface PayrollProjection {
  months: { month: string; amount: Amount }[];
  /** Mean of the monthly amounts (base currency). */
  average: Amount;
  /** Members whose pay could not be projected (per-event/one-time pay, or no current rate). */
  excluded: { rosterMemberId: string; reason: 'not_periodic' | 'no_rate' }[];
}

export function projectPayroll(
  terms: CompensationTerms[],
  months: string[],
  seasons: SeasonRange[],
  baseCurrency: string,
): PayrollProjection {
  const excluded: PayrollProjection['excluded'] = [];
  const usable = terms.filter((t) => {
    if (monthlyEquivalent(t.amount, t.frequency) === null) {
      excluded.push({ rosterMemberId: t.rosterMemberId, reason: 'not_periodic' });
      return false;
    }
    if (!t.currentRate) {
      excluded.push({ rosterMemberId: t.rosterMemberId, reason: 'no_rate' });
      return false;
    }
    return true;
  });

  const rows = months.map((month) => {
    const inSeason = monthInSeason(month, seasons);
    let total = new Dec(0);
    for (const t of usable) {
      if (!contractActiveIn(month, t)) continue;
      const periodAmount = inSeason || t.offSeasonAmount === null ? t.amount : t.offSeasonAmount;
      const monthly = monthlyEquivalent(periodAmount, t.frequency)!;
      // Round each member-month to the base currency once, then sum exact values.
      total = total.plus(money(monthly.times(t.currentRate!), baseCurrency));
    }
    return { month, amount: money(total, baseCurrency) };
  });

  const average = rows.length
    ? money(rows.reduce((acc, r) => acc.plus(r.amount), new Dec(0)).div(rows.length), baseCurrency)
    : money(0, baseCurrency);
  return { months: rows, average, excluded };
}
