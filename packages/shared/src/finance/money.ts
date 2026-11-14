/**
 * Money arithmetic. Every amount crosses the API as a decimal STRING and is computed with
 * decimal.js — never JavaScript floating point — so 0.1 + 0.2 is 0.3 and totals match to the
 * last minor unit in the UI, the database and every export.
 *
 * Rounding: half away from zero (ROUND_HALF_UP in decimal.js terms), to the currency's ISO 4217
 * minor units, applied once when an amount is converted into the base currency. Sums of rounded
 * amounts are exact; nothing is re-rounded afterwards.
 */
import { Decimal } from 'decimal.js';
import { currencyInfo } from './catalog.js';

type DecimalValue = Decimal.Value;

export const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type Dec = InstanceType<typeof Dec>;

export type Amount = string;

export const ZERO = new Dec(0);

export function d(value: DecimalValue): Dec {
  return new Dec(value);
}

export function sum(values: DecimalValue[]): Dec {
  return values.reduce<Dec>((acc, v) => acc.plus(v), new Dec(0));
}

export function roundTo(value: DecimalValue, currency: string): Dec {
  return new Dec(value).toDecimalPlaces(currencyInfo(currency).minorUnits, Dec.ROUND_HALF_UP);
}

/** Canonical string for an amount in a currency: fixed minor units, no exponent. */
export function money(value: DecimalValue, currency: string): Amount {
  return roundTo(value, currency).toFixed(currencyInfo(currency).minorUnits);
}

/**
 * Converts an original amount into the base currency with a snapshotted rate
 * (`rate` = units of base currency per 1 unit of the original currency).
 */
export function convertToBase(
  amount: DecimalValue,
  rate: DecimalValue,
  baseCurrency: string,
): Amount {
  return money(new Dec(amount).times(rate), baseCurrency);
}

/** Exchange rates are stored with 12 decimal places. */
export function normalizeRate(rate: DecimalValue): string {
  return new Dec(rate).toDecimalPlaces(12, Dec.ROUND_HALF_UP).toFixed(12);
}

/** Inverse of a rate (e.g. provider gives SAR→USD, we need USD→SAR). */
export function invertRate(rate: DecimalValue): string {
  return normalizeRate(new Dec(1).div(rate));
}

export function isValidAmount(value: string): boolean {
  try {
    const x = new Dec(value);
    return x.isFinite();
  } catch {
    return false;
  }
}

/** "2026-03-15" → "2026-03". */
export const monthOf = (isoDate: string) => isoDate.slice(0, 7);

/** Months from `from` to `to` inclusive, as "YYYY-MM". */
export function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number) as [number, number];
  const [ty, tm] = to.split('-').map(Number) as [number, number];
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

/** Whole months from month a to month b (b − a). */
export function monthDiff(a: string, b: string): number {
  const [ay, am] = a.split('-').map(Number) as [number, number];
  const [by, bm] = b.split('-').map(Number) as [number, number];
  return (by - ay) * 12 + (bm - am);
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}
