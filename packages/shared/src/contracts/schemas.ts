/** Request schemas for Phase 3 (contracts). Enforced by the API; reused by the dashboard. */
import { z } from 'zod';
import { CURRENCY_CODES, PAY_FREQUENCIES } from '../finance/catalog';
import {
  BACKGROUND_KINDS,
  CLAUSE_SOURCES,
  DOCUMENT_LANGUAGES,
  LOGO_POSITIONS,
  RECIPIENT_KINDS,
  STAMP_POSITIONS,
} from './catalog';

const text = (max: number) => z.string().trim().max(max);
const optText = (max: number) => text(max).nullable().optional();
const uuid = z.uuid();
const optUuid = uuid.nullable().optional();
const isoDate = z.iso.date();
const currency = z.enum(CURRENCY_CODES as [string, ...string[]]);
const amount = z
  .string()
  .trim()
  .regex(/^\d{1,14}(\.\d{1,4})?$/, 'amount_format')
  .refine((v) => Number(v) > 0, 'amount_positive');
const percent = z
  .string()
  .trim()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, 'percent_format')
  .refine((v) => Number(v) > 0 && Number(v) <= 100, 'percent_range');

// ---------- Document setup (spec §7.1) ----------

export const documentSettingsSchema = z.object({
  legalNameEn: optText(200),
  legalNameAr: optText(200),
  commercialRegistration: optText(60),
  taxNumber: optText(60),
  addressEn: optText(500),
  addressAr: optText(500),
  email: z.email().max(254).nullable().optional(),
  phone: optText(40),
  website: optText(200),
  headerTextEn: optText(300),
  headerTextAr: optText(300),
  footerTextEn: optText(300),
  footerTextAr: optText(300),
  logoFileId: optUuid,
  logoPosition: z.enum(LOGO_POSITIONS).default('start'),
  backgroundKind: z.enum(BACKGROUND_KINDS).default('none'),
  backgroundFileId: optUuid,
  /** A4 page margins in millimetres. */
  marginTopMm: z.number().int().min(5).max(60).default(20),
  marginBottomMm: z.number().int().min(5).max(60).default(20),
  marginStartMm: z.number().int().min(5).max(50).default(18),
  marginEndMm: z.number().int().min(5).max(50).default(18),
  pageBorder: z.boolean().default(false),
  fontSizePt: z.number().min(8).max(14).default(10.5),
  lineHeight: z.number().min(1.1).max(2.2).default(1.55),
  defaultLanguage: z.enum(DOCUMENT_LANGUAGES).default('bilingual'),
});
export type DocumentSettingsInput = z.infer<typeof documentSettingsSchema>;

export const stampSettingsSchema = z.object({
  stampFileId: optUuid,
  stampPosition: z.enum(STAMP_POSITIONS).default('end'),
  stampWidthMm: z.number().int().min(15).max(80).default(35),
});
export type StampSettingsInput = z.infer<typeof stampSettingsSchema>;

// ---------- Contract types and clause templates (spec §7.2, §7.3) ----------

export const contractTypeInputSchema = z.object({
  nameEn: text(120).min(1),
  nameAr: text(120).min(1),
  descriptionEn: optText(500),
  descriptionAr: optText(500),
});
export type ContractTypeInput = z.infer<typeof contractTypeInputSchema>;

const clauseText = {
  titleEn: text(200),
  titleAr: text(200),
  bodyEn: text(8000),
  bodyAr: text(8000),
};
const hasSomeText = (c: { titleEn: string; titleAr: string; bodyEn: string; bodyAr: string }) =>
  !!(c.titleEn || c.titleAr) && !!(c.bodyEn || c.bodyAr);

export const templateClauseSchema = z
  .object({ id: optUuid, required: z.boolean(), ...clauseText })
  .refine(hasSomeText, 'clause_empty');

/** The full ordered list replaces the template's clauses (Owner-only). */
export const templateClausesSchema = z.object({
  clauses: z.array(templateClauseSchema).max(80),
});
export type TemplateClausesInput = z.infer<typeof templateClausesSchema>;

// ---------- Contracts (spec §7.5) ----------

export const recipientSchema = z.object({
  kind: z.enum(RECIPIENT_KINDS),
  fullNameEn: optText(160),
  fullNameAr: optText(160),
  nationality: optText(80),
  dateOfBirth: isoDate.nullable().optional(),
  idNumber: optText(40),
  email: z.email().max(254).nullable().optional(),
  phone: optText(40),
  address: optText(500),
});

export const guardianSchema = z.object({
  fullName: optText(160),
  relationship: optText(80),
  email: z.email().max(254).nullable().optional(),
  phone: optText(40),
});

export const bonusSchema = z.object({
  description: text(500).min(1),
  amount: amount.nullable().optional(),
  currency: currency.nullable().optional(),
  condition: optText(1000),
});

export const contractDetailsSchema = z.object({
  title: optText(200),
  language: z.enum(DOCUMENT_LANGUAGES).default('bilingual'),
  recipient: recipientSchema,
  guardian: guardianSchema.nullable().optional(),
  gameId: optUuid,
  role: optText(120),
  startDate: isoDate.nullable().optional(),
  endDate: isoDate.nullable().optional(),
  compensation: z
    .object({
      amount: amount.nullable().optional(),
      currency: currency.default('SAR'),
      frequency: z.enum(PAY_FREQUENCIES).default('monthly'),
      offSeasonAmount: amount.nullable().optional(),
      offSeasonNotes: optText(1000),
    })
    .default({ currency: 'SAR', frequency: 'monthly' }),
  revenueShare: z
    .object({ percent: percent.nullable().optional(), description: optText(1000) })
    .default({}),
  bonuses: z.array(bonusSchema).max(20).default([]),
  buyout: z
    .object({
      amount: amount.nullable().optional(),
      currency: currency.default('SAR'),
      triggers: optText(2000),
    })
    .default({ currency: 'SAR' }),
  terminationConditions: optText(4000),
  obligations: optText(4000),
  internalNotes: optText(2000),
});
export type ContractDetailsInput = z.infer<typeof contractDetailsSchema>;

export const contractClauseSchema = z
  .object({
    /** Stable id of the clause within this contract (kept across versions). */
    id: uuid,
    templateClauseId: optUuid,
    source: z.enum(CLAUSE_SOURCES),
    required: z.boolean(),
    included: z.boolean(),
    ...clauseText,
  })
  .refine(hasSomeText, 'clause_empty')
  .refine((c) => !c.required || c.included, 'required_clause');

export const contractCreateSchema = z.object({
  contractTypeId: uuid,
  teamId: optUuid,
  /** Pre-fills the recipient from a roster member of the same team. */
  rosterMemberId: optUuid,
});
export type ContractCreateInput = z.infer<typeof contractCreateSchema>;

/** Saving a draft. Each save is stored as a new immutable version. */
export const contractSaveSchema = z
  .object({
    teamId: optUuid,
    rosterMemberId: optUuid,
    details: contractDetailsSchema,
    clauses: z.array(contractClauseSchema).max(120),
    note: optText(500),
  })
  .refine((v) => !v.rosterMemberId || !!v.teamId, 'roster_member_requires_team')
  .refine(
    (v) => !v.details.startDate || !v.details.endDate || v.details.startDate <= v.details.endDate,
    'contract_dates',
  )
  .refine((v) => new Set(v.clauses.map((c) => c.id)).size === v.clauses.length, 'duplicate_clause');
export type ContractSaveInput = z.infer<typeof contractSaveSchema>;

export const contractSubmitSchema = z.object({ note: optText(1000) });
export const approvalDecisionSchema = z.object({ comment: optText(2000) });
/** Rejection must explain itself (spec §7.6). */
export const rejectionSchema = z.object({ reason: text(2000).min(3) });

export const contractListQuerySchema = z.object({
  view: z.enum(['all', 'drafts', 'approvals', 'approved', 'signed']).default('all'),
  teamId: z.union([uuid, z.literal('none')]).optional(),
  status: z.string().max(40).optional(),
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

// ---------- Custom Clause Assistant (spec §7.4) ----------

export const clauseProposalRequestSchema = z.object({
  /** What the clause should achieve, in the user's words (Arabic or English). */
  purpose: text(2000).min(5),
  /** Feedback on a previous proposal, to revise it. */
  revisionOf: optUuid,
  feedback: optText(2000),
});
export type ClauseProposalRequest = z.infer<typeof clauseProposalRequestSchema>;

export const clauseProposalAcceptSchema = z.object({
  /** Insert before the clause with this id; omit to append at the end. */
  beforeClauseId: optUuid,
});
