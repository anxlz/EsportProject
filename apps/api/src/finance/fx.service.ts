/**
 * Exchange-rate lookups with caching and snapshot semantics (brief §5).
 *
 * - Every ledger entry stores the rate used, its date and its source. Reports use that stored
 *   rate forever ("snapshot"); today's rate is only ever used for the explicit comparison view.
 * - Provider answers are cached in app.fx_rates by the requested date, so each pair/date is
 *   fetched once and historical reports never depend on the provider being reachable.
 * - Dates in the future (expected revenue) use today's rate; the stored rate date says so.
 * - When no rate can be found, the caller must supply one (manual source) — never a guess.
 */
import { Inject, Injectable } from '@nestjs/common';
import { normalizeRate } from '@esports/shared';
import { and, eq } from 'drizzle-orm';
import { DB, type Database } from '../db/client';
import { fxRates } from '../db/schema-finance';
import { CLOCK, type Clock } from './clock';
import { FX_PROVIDER, type FxRateProvider } from './fx.provider';

export interface RateQuote {
  /** Units of `base` per 1 unit of `currency`, 12 decimal places. */
  rate: string;
  rateDate: string | null;
  source: 'same_currency' | 'provider';
}

@Injectable()
export class FxService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(FX_PROVIDER) private readonly provider: FxRateProvider,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  get providerName(): FxRateProvider['name'] {
    return this.provider.name;
  }

  /** Rate to convert `currency` into `base` for `date`, or null if unknown. */
  async quote(currency: string, base: string, date: string): Promise<RateQuote | null> {
    if (currency === base)
      return { rate: normalizeRate(1), rateDate: null, source: 'same_currency' };
    const today = this.clock.today();
    const effective = date > today ? today : date;

    const [cached] = await this.db
      .select()
      .from(fxRates)
      .where(
        and(
          eq(fxRates.source, this.provider.name),
          eq(fxRates.base, currency),
          eq(fxRates.quote, base),
          eq(fxRates.requestedDate, effective),
        ),
      );
    if (cached)
      return { rate: normalizeRate(cached.rate), rateDate: cached.rateDate, source: 'provider' };

    const fetched = await this.provider.fetchRate(currency, base, effective);
    if (!fetched) return null;
    const rate = normalizeRate(fetched.rate);
    await this.db
      .insert(fxRates)
      .values({
        source: this.provider.name,
        base: currency,
        quote: base,
        requestedDate: effective,
        rateDate: fetched.rateDate,
        rate,
      })
      .onConflictDoNothing();
    return { rate, rateDate: fetched.rateDate, source: 'provider' };
  }

  /** Today's rate, for projections and the "view at today's rate" comparison. */
  current(currency: string, base: string): Promise<RateQuote | null> {
    return this.quote(currency, base, this.clock.today());
  }
}
