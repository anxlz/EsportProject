/** Request schemas for the AI assistants (Phase 5). Enforced by the API; reused by the dashboard. */
import { z } from 'zod';
import { CURRENCY_CODES, PAY_FREQUENCIES } from '../finance/catalog';
import {
  ASSISTANT_KEYS,
  ASSISTANT_LIMITS,
  type AssistantKey,
  EMAIL_TONES,
  REPLY_LANGUAGES,
} from './catalog';

const text = (max: number) => z.string().trim().max(max);
const optText = (max: number) => text(max).nullable().optional();
const uuid = z.uuid();
const optUuid = uuid.nullable().optional();
const currency = z.enum(CURRENCY_CODES as [string, ...string[]]);
const amount = z
  .string()
  .trim()
  .regex(/^\d{1,14}(\.\d{1,4})?$/, 'amount_format');
const percent = z
  .string()
  .trim()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, 'percent_format')
  .refine((v) => Number(v) <= 100, 'percent_range');

/** Contract terms on one side of a negotiation (Offer Optimizer). */
export const offerTermsSchema = z.object({
  salaryAmount: amount.nullable().optional(),
  currency: currency.default('SAR'),
  frequency: z.enum(PAY_FREQUENCIES).default('monthly'),
  durationMonths: z.number().int().min(1).max(120).nullable().optional(),
  signingBonus: amount.nullable().optional(),
  bonuses: z
    .array(z.object({ description: text(300).min(1), amount: amount.nullable().optional() }))
    .max(10)
    .default([]),
  revenueSharePercent: percent.nullable().optional(),
  buyoutAmount: amount.nullable().optional(),
  otherTerms: optText(2000),
});
export type OfferTermsInput = z.infer<typeof offerTermsSchema>;

/**
 * Context the user provides per conversation. The Offer Optimizer and the Player Investment
 * Analyst work from it when platform data doesn't exist or isn't visible (spec §8.2 fallback).
 */
export const offerContextSchema = z.object({
  preferred: offerTermsSchema.default({ currency: 'SAR', frequency: 'monthly', bonuses: [] }),
  requested: offerTermsSchema.default({ currency: 'SAR', frequency: 'monthly', bonuses: [] }),
  /** A contract whose current terms were loaded as the preferred side (for reference). */
  contractId: optUuid,
  counterparty: optText(200),
  notes: optText(ASSISTANT_LIMITS.contextChars),
});
export const analystContextSchema = z.object({
  rosterMemberId: optUuid,
  profile: optText(6000),
  evidence: optText(ASSISTANT_LIMITS.contextChars),
});
export const emailContextSchema = z.object({
  recipientName: optText(160),
  recipientEmail: z.email().max(254).nullable().optional(),
  recipientRole: optText(120),
  gameOrTeam: optText(160),
  purpose: optText(4000),
  tone: z.enum(EMAIL_TONES).nullable().optional(),
});
export const formalContextSchema = z.object({
  recipient: optText(200),
  sender: optText(200),
  purpose: optText(4000),
});
export const generalContextSchema = z.object({});

export const ASSISTANT_CONTEXT_SCHEMAS = {
  general: generalContextSchema,
  formal_message: formalContextSchema,
  email: emailContextSchema,
  offer_optimizer: offerContextSchema,
  player_analyst: analystContextSchema,
} satisfies Record<AssistantKey, z.ZodType>;

export type OfferContext = z.infer<typeof offerContextSchema>;
export type AnalystContext = z.infer<typeof analystContextSchema>;
export type EmailContext = z.infer<typeof emailContextSchema>;
export type FormalContext = z.infer<typeof formalContextSchema>;

export const createConversationSchema = z.object({
  assistant: z.enum(ASSISTANT_KEYS),
  title: optText(120),
  replyLanguage: z.enum(REPLY_LANGUAGES).default('auto'),
  webSearch: z.boolean().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});
export type CreateConversationInput = z.infer<typeof createConversationSchema>;

export const updateConversationSchema = z.object({
  title: optText(120),
  replyLanguage: z.enum(REPLY_LANGUAGES).optional(),
  webSearch: z.boolean().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  archived: z.boolean().optional(),
});
export type UpdateConversationInput = z.infer<typeof updateConversationSchema>;

export const sendAssistantMessageSchema = z.object({
  text: text(ASSISTANT_LIMITS.messageChars).min(1),
});

const recipient = z.object({ email: z.email().max(254), name: optText(160) });
/** Sending a reviewed email: the user's final recipients, subject and body (may be edited). */
export const sendProposedEmailSchema = z.object({
  to: z.array(recipient).min(1).max(ASSISTANT_LIMITS.maxRecipients),
  cc: z.array(recipient).max(ASSISTANT_LIMITS.maxRecipients).default([]),
  subject: text(200).min(1),
  body: text(20000).min(1),
});
export type SendProposedEmailInput = z.infer<typeof sendProposedEmailSchema>;

/** Applying one Offer Optimizer alternative to a draft contract (a new contract version). */
export const applyOfferSchema = z.object({
  alternative: z.number().int().min(0).max(9),
  contractId: uuid,
});
export type ApplyOfferInput = z.infer<typeof applyOfferSchema>;

export const toolCallQuerySchema = z.object({
  assistant: z.enum(ASSISTANT_KEYS).optional(),
  userId: uuid.optional(),
  before: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
