/**
 * Dates use the Gregorian calendar with Western digits in both languages (a deliberate,
 * reversible choice — see DECISIONS.md). `ar-SA` alone would default to the Hijri calendar.
 */
const intlLocale = (locale: string) => (locale === 'ar' ? 'ar-u-ca-gregory-nu-latn' : 'en-GB');

export function formatDate(iso: string | null | undefined, locale: string): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat(intlLocale(locale), { day: 'numeric', month: 'short', year: 'numeric' }).format(
    new Date(iso),
  );
}

export function formatDateTime(iso: string | null | undefined, locale: string): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat(intlLocale(locale), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

/** Picks the role name in the reader's language, falling back to the other one. */
export function roleName(r: { nameEn: string | null; nameAr: string | null }, locale: string): string {
  return (locale === 'ar' ? (r.nameAr ?? r.nameEn) : (r.nameEn ?? r.nameAr)) ?? '';
}

/** Wraps an email/slug in Unicode LTR isolates so it renders correctly inside Arabic sentences. */
export const ltr = (s: string) => `\u2066${s}\u2069`;
