/**
 * Display formatting shared by the dashboard and the PDF/TXT exports, so a figure reads exactly
 * the same everywhere. Currency is shown as its ISO code (multi-currency tool: "SAR 1,250.00" is
 * unambiguous where symbols are not). Western digits and the Gregorian calendar in both
 * languages (see DECISIONS.md).
 */
import { currencyInfo } from './catalog';
import type { FinanceLocale } from './i18n';
import { money } from './money';

const numberLocale = (l: FinanceLocale) => (l === 'ar' ? 'ar-u-nu-latn' : 'en-GB');

export function formatMoney(amount: string, currency: string, locale: FinanceLocale): string {
  const minor = currencyInfo(currency).minorUnits;
  const fixed = money(amount, currency);
  const n = new Intl.NumberFormat(numberLocale(locale), {
    minimumFractionDigits: minor,
    maximumFractionDigits: minor,
    // Decimal strings are formatted exactly (no float conversion).
  }).format(fixed as unknown as number);
  // Isolate the code + number so the minus sign and digits stay in order inside Arabic text.
  return `⁦${currency} ${n}⁩`;
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
