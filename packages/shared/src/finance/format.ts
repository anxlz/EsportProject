/**
 * Display formatting shared by the dashboard and the exports, so a figure reads exactly the same
 * everywhere. Currency is shown as its ISO code ("USD 1,250.00": unambiguous in a multi-currency
 * tool), except the Saudi riyal, which uses the official riyal sign U+20C1 ("⃁ 1,250.00") where
 * the output is guaranteed to have a font for it: the dashboard (once its bundled riyal font has
 * loaded) and our PDFs (font embedded). CSV/TXT/XLSX files keep "SAR", because they are opened
 * in other software whose fonts we can't control. The sign sits to the left of the number with
 * a space, in Arabic and English alike (SAMA guidance). Western digits and the Gregorian
 * calendar in both languages (see DECISIONS.md).
 */
import { currencyInfo } from './catalog.js';
import type { FinanceLocale } from './i18n.js';
import { money } from './money.js';

const numberLocale = (l: FinanceLocale) => (l === 'ar' ? 'ar-u-nu-latn' : 'en-GB');

/** U+20C1 SAUDI RIYAL SIGN (Unicode 17.0). */
export const RIYAL_SIGN = '\u20C1';

export interface MoneyFormatOptions {
  /** Show the riyal sign instead of "SAR". Only where a font with the glyph is guaranteed. */
  riyalSign?: boolean;
}

/** The currency mark printed before an amount: the riyal sign or the ISO code. */
export const currencyMark = (currency: string, opts: MoneyFormatOptions = {}) =>
  currency === 'SAR' && opts.riyalSign ? RIYAL_SIGN : currency;

export function formatMoney(
  amount: string,
  currency: string,
  locale: FinanceLocale,
  opts: MoneyFormatOptions = {},
): string {
  const minor = currencyInfo(currency).minorUnits;
  const fixed = money(amount, currency);
  const n = new Intl.NumberFormat(numberLocale(locale), {
    minimumFractionDigits: minor,
    maximumFractionDigits: minor,
    // Decimal strings are formatted exactly (no float conversion).
  }).format(fixed as unknown as number);
  // Isolate the code + number so the minus sign and digits stay in order inside Arabic text.
  return `⁦${currencyMark(currency, opts)} ${n}⁩`;
}

export function formatNumber(
  value: string | number,
  locale: FinanceLocale,
  fractionDigits = 0,
): string {
  return new Intl.NumberFormat(numberLocale(locale), {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value as number);
}

export function formatPercent(value: string, locale: FinanceLocale): string {
  return `⁦${formatNumber(value, locale, 1)}%⁩`;
}

const MONTHS_EN = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const MONTHS_AR = [
  'يناير',
  'فبراير',
  'مارس',
  'أبريل',
  'مايو',
  'يونيو',
  'يوليو',
  'أغسطس',
  'سبتمبر',
  'أكتوبر',
  'نوفمبر',
  'ديسمبر',
];

/** "2026-03" → "Mar 2026" / "مارس 2026" (deterministic: no ICU calendar differences). */
export function formatMonth(month: string, locale: FinanceLocale): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return `${(locale === 'ar' ? MONTHS_AR : MONTHS_EN)[m - 1]} ${y}`;
}

/** "2026-03-15" → "15 Mar 2026" / "15 مارس 2026". */
export function formatIsoDate(date: string, locale: FinanceLocale): string {
  const [y, m, dd] = date.slice(0, 10).split('-').map(Number) as [number, number, number];
  return `${dd} ${(locale === 'ar' ? MONTHS_AR : MONTHS_EN)[m - 1]} ${y}`;
}
