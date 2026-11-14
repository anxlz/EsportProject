/**
 * Merge fields: `{{field}}` placeholders in clause text, filled from the contract's details at
 * render time. A field with no value is rendered as a visible "missing" marker and reported, so a
 * contract can't be submitted with gaps. Pure functions: the same input renders the same text in
 * the preview, the approval document and the dashboard.
 */
import { formatIsoDate, formatMoney, type MoneyFormatOptions } from '../finance/format.js';
import { MERGE_FIELDS, type MergeField } from './catalog.js';
import { cl, type ContractLocale, formatDuration } from './i18n.js';
import type { ContractSnapshot } from './dto.js';
import { isMinorOn } from './signing.js';

export interface MergeContext {
  organizationName: string;
  legalNameEn: string | null;
  legalNameAr: string | null;
  contractNumber: string;
}

export type MergeValues = Partial<Record<MergeField, string>>;

const PLACEHOLDER = /\{\{\s*([a-zA-Z]+)\s*\}\}/g;

/** Whole months and remaining days from start to end, counting both dates (1 Jan–31 Dec = 12 months). */
export function contractLength(start: string, end: string): { months: number; days: number } {
  const s = new Date(`${start}T00:00:00Z`);
  const e = new Date(`${end}T00:00:00Z`);
  e.setUTCDate(e.getUTCDate() + 1); // exclusive end: both dates count
  // `start` plus n calendar months, clamped to the month's last day (31 Jan + 1 month = 28 Feb).
  const plusMonths = (n: number) => {
    const y = s.getUTCFullYear() + Math.floor((s.getUTCMonth() + n) / 12);
    const m = (s.getUTCMonth() + n) % 12;
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return new Date(Date.UTC(y, m, Math.min(s.getUTCDate(), last)));
  };
  let months = (e.getUTCFullYear() - s.getUTCFullYear()) * 12 + (e.getUTCMonth() - s.getUTCMonth());
  while (months > 0 && plusMonths(months) > e) months -= 1;
  const days = Math.round((e.getTime() - plusMonths(Math.max(0, months)).getTime()) / 86_400_000);
  return { months: Math.max(0, months), days: Math.max(0, days) };
}

export function mergeValues(
  snapshot: ContractSnapshot,
  ctx: MergeContext,
  locale: ContractLocale,
  opts: MoneyFormatOptions = {},
): MergeValues {
  const L = cl(locale);
  const d = snapshot.details;
  const r = d.recipient;
  const pick = (enV: string | null | undefined, arV: string | null | undefined) =>
    (locale === 'ar' ? arV || enV : enV || arV) || undefined;
  const v: MergeValues = {
    organizationName: ctx.organizationName,
    organizationLegalName: pick(ctx.legalNameEn, ctx.legalNameAr) ?? ctx.organizationName,
    contractNumber: ctx.contractNumber,
    recipientName: pick(r.fullNameEn, r.fullNameAr),
    teamName: snapshot.teamName ?? undefined,
    gameName: snapshot.gameName ?? undefined,
    role: d.role || undefined,
    startDate: d.startDate ? formatIsoDate(d.startDate, locale) : undefined,
    endDate: d.endDate ? formatIsoDate(d.endDate, locale) : undefined,
    salary:
      d.compensation?.amount && d.compensation.currency
        ? formatMoney(d.compensation.amount, d.compensation.currency, locale, opts)
        : undefined,
    paymentFrequency: d.compensation?.amount
      ? L.frequencyPhrase[d.compensation.frequency]
      : undefined,
  };
  if (d.startDate && d.endDate) {
    const { months, days } = contractLength(d.startDate, d.endDate);
    v.duration = formatDuration(months, days, locale);
  }
  return v;
}

export type TextPart = { text: string } | { missing: MergeField | string };

/** Splits clause text into literal text and filled/missing placeholders. */
export function fillTemplate(body: string, values: MergeValues): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const m of body.matchAll(PLACEHOLDER)) {
    if (m.index! > last) parts.push({ text: body.slice(last, m.index) });
    const field = m[1]!;
    const value = (MERGE_FIELDS as readonly string[]).includes(field)
      ? values[field as MergeField]
      : undefined;
    parts.push(value ? { text: value } : { missing: field });
    last = m.index! + m[0].length;
  }
  if (last < body.length) parts.push({ text: body.slice(last) });
  return parts;
}

export function placeholdersIn(body: string): string[] {
  return [...body.matchAll(PLACEHOLDER)].map((m) => m[1]!);
}

/** The languages a document is produced in. */
export const documentLocales = (
  language: ContractSnapshot['details']['language'],
): ContractLocale[] => (language === 'bilingual' ? ['en', 'ar'] : [language]);

/**
 * What still prevents submission: required values, placeholders without a value in included
 * clauses, and clause text missing for a document language. The date of birth is required so the
 * signing step can tell, without guessing, whether a parent or guardian must also sign; for a
 * recipient under 18 (on `today`), the guardian's name, relationship and a contact are required.
 */
export function completenessIssues(
  snapshot: ContractSnapshot,
  ctx: MergeContext,
  today: string = new Date().toISOString().slice(0, 10),
): string[] {
  const issues = new Set<string>();
  const d = snapshot.details;
  const minor = isMinorOn(d.recipient.dateOfBirth, today);
  if (minor === null) issues.add('dateOfBirth');
  if (minor) {
    if (!d.guardian?.fullName) issues.add('guardianName');
    if (!d.guardian?.relationship) issues.add('guardianRelationship');
    if (!d.guardian?.email && !d.guardian?.phone) issues.add('guardianContact');
  }
  const locales = documentLocales(d.language);
  for (const loc of locales) {
    const name =
      loc === 'ar'
        ? d.recipient.fullNameAr || d.recipient.fullNameEn
        : d.recipient.fullNameEn || d.recipient.fullNameAr;
    if (!name) issues.add('recipientName');
  }
  if (!d.startDate) issues.add('startDate');
  for (const c of snapshot.clauses.filter((x) => x.included)) {
    for (const loc of locales) {
      const body = loc === 'ar' ? c.bodyAr : c.bodyEn;
      const title = loc === 'ar' ? c.titleAr : c.titleEn;
      if (!body.trim() || !title.trim()) issues.add(`clause_text_${loc}:${c.id}`);
      const values = mergeValues(snapshot, ctx, loc);
      for (const p of fillTemplate(body, values)) if ('missing' in p) issues.add(p.missing);
    }
  }
  return [...issues];
}
