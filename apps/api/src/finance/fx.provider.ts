/**
 * Exchange-rate providers. Behind an injection token: tests use a fake and never call out.
 *
 * Frankfurter v2 (https://frankfurter.dev): free, no API key, blended rates from central banks,
 * historical rates by date, 200+ currencies including SAR. Verified 2026-10-15:
 *   GET /v2/rates?base=USD&quotes=SAR&date=2026-10-01
 *   → [{"date":"2026-10-01","base":"USD","quote":"SAR","rate":3.75}]
 * For a weekend/holiday date it answers with the previous trading day's rate (its `date` field).
 * Its docs state blended rates are free for commercial use; review frankfurter.dev/license before
 * production (the licence page could not be loaded from the build environment).
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type Env, ENV } from '../config/env';

export interface ProviderRate {
  /** 1 unit of `base` = `rate` units of `quote`, as a decimal string. */
  rate: string;
  /** Date the rate applies to (may be earlier than requested on non-trading days). */
  rateDate: string;
}

export interface FxRateProvider {
  readonly name: 'frankfurter' | 'none';
  fetchRate(base: string, quote: string, date: string): Promise<ProviderRate | null>;
}

export const FX_PROVIDER = Symbol('FX_PROVIDER');

export class NoFxProvider implements FxRateProvider {
  readonly name = 'none' as const;
  async fetchRate(): Promise<null> {
    return null;
  }
}

@Injectable()
export class FrankfurterProvider implements FxRateProvider {
  readonly name = 'frankfurter' as const;
  private readonly logger = new Logger('FX');

  constructor(@Inject(ENV) private readonly env: Env) {}

  async fetchRate(base: string, quote: string, date: string): Promise<ProviderRate | null> {
    const url = `${this.env.FX_PROVIDER_URL}/v2/rates?base=${encodeURIComponent(base)}&quotes=${encodeURIComponent(quote)}&date=${encodeURIComponent(date)}`;
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(5000),
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        this.logger.warn(`Rate request failed (${res.status}) for ${base}/${quote} on ${date}`);
        return null;
      }
      return parseFrankfurter(await res.json(), base, quote);
    } catch (err) {
      this.logger.warn(
        `Rate request error for ${base}/${quote} on ${date}: ${(err as Error).message}`,
      );
      return null;
    }
  }
}

/** Parses the v2 /rates response. Exported for tests against the recorded response format. */
export function parseFrankfurter(body: unknown, base: string, quote: string): ProviderRate | null {
  if (!Array.isArray(body)) return null;
  const row = body.find(
    (r): r is { date: string; base: string; quote: string; rate: number | string } =>
      typeof r === 'object' &&
      r !== null &&
      (r as { base?: unknown }).base === base &&
      (r as { quote?: unknown }).quote === quote,
  );
  if (!row || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) return null;
  const rate = String(row.rate);
  if (!/^\d+(\.\d+)?(e-?\d+)?$/i.test(rate) || Number(rate) <= 0) return null;
  return { rate, rateDate: row.date };
}
