/**
 * Offer Optimizer arithmetic (spec §8.2.4). The assistant explains trade-offs in words; every
 * number it is shown or that the user sees next to an alternative is computed here, from the
 * terms, with exact decimal arithmetic — never taken from model output.
 *
 * Cost of an offer over its term (an upper bound, all in the offer's own currency):
 *   base     = monthly equivalent × duration in months   (one-time pay: the amount itself)
 *   bonuses  = sum of every listed bonus amount           (assumes all are earned)
 *   total    = base + signing bonus + bonuses
 * Monthly equivalents follow the payroll projection (weekly ×52/12, biweekly ×26/12,
 * semimonthly ×2, quarterly ÷3, annually ÷12). Per-event pay can't be projected, and a revenue
 * share can't be costed without a revenue figure; both are reported as notes, not guessed.
 */
import { monthlyEquivalent } from '../finance/payroll.js';
import type { PayFrequency } from '../finance/catalog.js';
import { type Amount, d, money, sum, ZERO } from '../finance/money.js';

export interface OfferTerms {
  salaryAmount?: Amount | null;
  currency: string;
  frequency: PayFrequency;
  durationMonths?: number | null;
  signingBonus?: Amount | null;
  bonuses: { description: string; amount?: Amount | null }[];
  revenueSharePercent?: string | null;
  buyoutAmount?: Amount | null;
  otherTerms?: string | null;
}

export type OfferCostNote =
  | 'salary_unknown'
  | 'duration_unknown'
  | 'per_event_not_projected'
  | 'revenue_share_not_costed'
  | 'bonus_amount_unknown';

export interface OfferCost {
  currency: string;
  /** Pay per month (null for per-event or one-time pay, or when no salary is set). */
  monthly: Amount | null;
  /** Pay over the whole term. */
  base: Amount | null;
  signingBonus: Amount;
  /** Every listed bonus earned. */
  bonusesMax: Amount;
  /** base + signing bonus + bonuses; null when the base can't be computed. */
  totalUpperBound: Amount | null;
  notes: OfferCostNote[];
}

export function offerCost(t: OfferTerms): OfferCost {
  const notes: OfferCostNote[] = [];
  const signing = d(t.signingBonus || 0);
  const bonusAmounts = t.bonuses.map((b) => b.amount).filter((a): a is string => !!a);
  if (bonusAmounts.length < t.bonuses.length) notes.push('bonus_amount_unknown');
  const bonuses = sum(bonusAmounts);
  let monthly: ReturnType<typeof d> | null = null;
  let base: ReturnType<typeof d> | null = null;
  if (!t.salaryAmount) {
    notes.push('salary_unknown');
  } else if (t.frequency === 'one_time') {
    base = d(t.salaryAmount);
  } else if (t.frequency === 'per_event') {
    notes.push('per_event_not_projected');
  } else {
    monthly = monthlyEquivalent(t.salaryAmount, t.frequency);
    if (t.durationMonths && monthly) base = monthly.times(t.durationMonths);
    else notes.push('duration_unknown');
  }
  if (t.revenueSharePercent && d(t.revenueSharePercent).gt(ZERO))
    notes.push('revenue_share_not_costed');
  return {
    currency: t.currency,
    monthly: monthly ? money(monthly, t.currency) : null,
    base: base ? money(base, t.currency) : null,
    signingBonus: money(signing, t.currency),
    bonusesMax: money(bonuses, t.currency),
    totalUpperBound: base ? money(base.plus(signing).plus(bonuses), t.currency) : null,
    notes,
  };
}

/** a − b, when both totals are known and in the same currency (otherwise not comparable). */
export function costDelta(a: OfferCost, b: OfferCost): Amount | null {
  if (a.currency !== b.currency || a.totalUpperBound === null || b.totalUpperBound === null)
    return null;
  return money(d(a.totalUpperBound).minus(b.totalUpperBound), a.currency);
}
