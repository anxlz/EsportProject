/** Request schemas for Phase 3 (contracts). Enforced by the API; reused by the dashboard. */
import { z } from 'zod';
import { CURRENCY_CODES, PAY_FREQUENCIES } from '../finance/catalog';
import {
  BACKGROUND_KINDS,
  CLAUSE_SOURCES,
  CONTRACT_TEXT_FONTS,
  CONTRACT_TEXT_FONT_FAMILIES,
  DEFAULT_CONTRACT_TEXT_STYLE,
  DOCUMENT_LANGUAGES,
  DRAW_CANVAS,
  ID_DOCUMENT_TYPES,
  MIN_DRAWN_LENGTH,
  LOGO_POSITIONS,
  RECIPIENT_KINDS,
  SIGNATURE_FONT_KEYS,
  SIGNATURE_METHODS,
  SIGNING_LINK_DEFAULT_DAYS,
  SIGNING_LINK_MAX_DAYS,
  signatureFontsFor,
  STAMP_POSITIONS,
  TERMINATION_REASON_CODES,
  VERIFICATION_METHODS,
} from './catalog';
import { CONSENT_VERSION } from './i18n';

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

export const contractTextStyleSchema = z
  .object({
    fontFamily: z.enum(CONTRACT_TEXT_FONT_FAMILIES),
    fontWeight: z.number().int().min(300).max(800),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'contract_text_color'),
  })
  .refine(
    (style) => {
      const font = CONTRACT_TEXT_FONTS.find((item) => item.family === style.fontFamily);
      return !!font && (font.weights as readonly number[]).includes(style.fontWeight);
    },
    { path: ['fontWeight'], message: 'contract_text_weight' },
  );
export type ContractTextStyleInput = z.infer<typeof contractTextStyleSchema>;

export function contractTextStyleCss(style: ContractTextStyleInput): string {
  const parsed = contractTextStyleSchema.parse(style);
  return `:root{--contract-font-family:'${parsed.fontFamily}';--contract-font-weight:${parsed.fontWeight};--contract-text-color:${parsed.color}}`;
}

export const contractTerminationRequestSchema = z
  .object({
    reasonCode: z.enum(TERMINATION_REASON_CODES),
    reasonDetails: optText(4000),
    effectiveDate: isoDate,
    noticePeriodDays: z.number().int().min(0).max(3650).default(0),
  })
  .refine(
    (input) =>
      !['breach', 'non_performance'].includes(input.reasonCode) || !!input.reasonDetails?.trim(),
    { path: ['reasonDetails'], message: 'termination_reason_details_required' },
  );
export type ContractTerminationRequestInput = z.infer<typeof contractTerminationRequestSchema>;

export const contractTerminationResponseSchema = z.object({
  decision: z.enum(['accepted', 'rejected']),
  note: optText(2000),
});

export const contractTerminationExecuteSchema = z.object({
  settlementNotes: optText(4000),
});

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
    textStyle: contractTextStyleSchema.default(DEFAULT_CONTRACT_TEXT_STYLE),
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

// ---------- Electronic signatures (spec §7.7, Phase 4) ----------

export const cancelSigningSchema = z.object({ reason: text(500).min(3) });

/** A signing link for one signer. The previous link of that signer, if any, stops working. */
export const createSigningLinkSchema = z.object({
  method: z.enum(VERIFICATION_METHODS),
  /** Where the email code goes; defaults to the address in the approved contract. */
  email: z.email().max(254).nullable().optional(),
  expiresInDays: z
    .number()
    .int()
    .min(1)
    .max(SIGNING_LINK_MAX_DAYS)
    .default(SIGNING_LINK_DEFAULT_DAYS),
});
export type CreateSigningLinkInput = z.infer<typeof createSigningLinkSchema>;

export const verifySigningCodeSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'code_format'),
});

const point = z
  .tuple([z.number().min(0).max(DRAW_CANVAS.width), z.number().min(0).max(DRAW_CANVAS.height)])
  .transform((coordinates): [number, number] => [coordinates[0]!, coordinates[1]!]);
const strokesSchema = z
  .array(z.array(point).min(1).max(2000))
  .min(1)
  .max(60)
  .refine((s) => s.reduce((n, st) => n + st.length, 0) <= 6000, 'too_many_points')
  .refine((s) => strokeLength(s) >= MIN_DRAWN_LENGTH, 'signature_too_short');

/** Total drawn path length, in canvas units (a dot or a tiny scribble isn't a signature). */
export function strokeLength(strokes: [number, number][][]): number {
  let total = 0;
  for (const st of strokes)
    for (let i = 1; i < st.length; i++)
      total += Math.hypot(st[i]![0] - st[i - 1]![0], st[i]![1] - st[i - 1]![1]);
  return total;
}

export const signSchema = z
  .object({
    method: z.enum(SIGNATURE_METHODS),
    typedName: text(120).nullable().optional(),
    fontKey: z.enum(SIGNATURE_FONT_KEYS).nullable().optional(),
    strokes: strokesSchema.nullable().optional(),
    /** Language the consent statement was shown in; it is stored verbatim in that language. */
    locale: z.enum(['ar', 'en']),
    consentVersion: z.literal(CONSENT_VERSION),
    /** The signer ticked the consent statement… */
    consent: z.literal(true),
    /** …and confirmed the final "sign" step after seeing the preview. */
    confirm: z.literal(true),
  })
  .refine(
    (v) => v.method !== 'typed' || (!!v.typedName && v.typedName.length >= 2 && !!v.fontKey),
    'typed_needs_name_and_font',
  )
  .refine(
    (v) =>
      v.method !== 'typed' ||
      !v.typedName ||
      !v.fontKey ||
      signatureFontsFor(v.typedName).some((f) => f.key === v.fontKey),
    'font_script_mismatch',
  )
  .refine((v) => v.method !== 'drawn' || !!v.strokes, 'drawn_needs_strokes');
export type SignInput = z.infer<typeof signSchema>;

/** ID-document patch: the query of the raw upload (the body is the file itself). */
export const idDocumentUploadQuerySchema = z.object({ type: z.enum(ID_DOCUMENT_TYPES) });
export type IdDocumentUploadQuery = z.infer<typeof idDocumentUploadQuerySchema>;
