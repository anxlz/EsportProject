/**
 * The five AI assistants (spec §8.2) and the rules they share (spec §8.1). Keys are stored in
 * the database; labels live in the web app's message catalogs.
 */
import type { PermissionKey } from '../permissions';

export const ASSISTANT_KEYS = [
  'general',
  'formal_message',
  'email',
  'offer_optimizer',
  'player_analyst',
] as const;
export type AssistantKey = (typeof ASSISTANT_KEYS)[number];

/** Access is per assistant (spec §4.2 "AI Assistants — access per assistant"). */
export const ASSISTANT_PERMISSION: Record<AssistantKey, PermissionKey> = {
  general: 'assistants.general',
  formal_message: 'assistants.formal_message',
  email: 'assistants.email',
  offer_optimizer: 'assistants.offer_optimizer',
  player_analyst: 'assistants.player_analyst',
};

export type ProposalKind = 'none' | 'message' | 'email' | 'offer' | 'analysis';

export interface AssistantFeatures {
  /** May look things up: platform data the user can see, and web search. */
  tools: boolean;
  /** Web search is on by default for new conversations (the user can switch it off). */
  webSearchDefault: boolean;
  proposal: ProposalKind;
}

export const ASSISTANT_FEATURES: Record<AssistantKey, AssistantFeatures> = {
  general: { tools: true, webSearchDefault: true, proposal: 'none' },
  // Composition from what the user provides: no lookups, so nothing to cite.
  formal_message: { tools: false, webSearchDefault: false, proposal: 'message' },
  email: { tools: false, webSearchDefault: false, proposal: 'email' },
  offer_optimizer: { tools: true, webSearchDefault: false, proposal: 'offer' },
  player_analyst: { tools: true, webSearchDefault: true, proposal: 'analysis' },
};

/** Spec §8.1 guardrail 2: every claim is labeled. */
export const CONFIDENCE_LEVELS = ['confirmed', 'estimated', 'uncertain'] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

/** `auto` answers in the language of each message (spec §8.1: switchable per conversation). */
export const REPLY_LANGUAGES = ['auto', 'ar', 'en'] as const;
export type ReplyLanguage = (typeof REPLY_LANGUAGES)[number];
export type AnswerLanguage = 'ar' | 'en';

export const EMAIL_TONES = [
  'formal',
  'friendly',
  'neutral',
  'firm',
  'apologetic',
  'celebratory',
] as const;
export type EmailTone = (typeof EMAIL_TONES)[number];

export const MESSAGE_STATUSES = ['pending', 'complete', 'failed'] as const;
export type AssistantMessageStatus = (typeof MESSAGE_STATUSES)[number];

/** Where a cited source came from: platform data, the web, or context the user typed in. */
export const SOURCE_KINDS = ['platform', 'web', 'user'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/**
 * What a platform or user-context source is, so the dashboard can name it in the reader's own
 * language (the English title is what the model sees). Web sources keep their page title.
 */
export const SOURCE_LABELS = [
  'teams',
  'roster',
  'roster_member',
  'finance_report',
  'budgets',
  'contracts',
  'contract',
  'tournaments',
  'user_context',
  'user_email_brief',
  'user_terms',
  'user_profile',
] as const;
export type SourceLabel = (typeof SOURCE_LABELS)[number];

export const TOOL_CALL_KINDS = ['platform', 'web_search'] as const;
export type ToolCallKind = (typeof TOOL_CALL_KINDS)[number];
/** `denied`: the user may not see that data. `unknown_tool`: not a tool the assistant has. */
export const TOOL_CALL_OUTCOMES = ['ok', 'denied', 'not_found', 'error', 'unknown_tool'] as const;
export type ToolCallOutcome = (typeof TOOL_CALL_OUTCOMES)[number];

export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const ANALYST_SCENARIOS = ['conservative', 'base', 'optimistic'] as const;
export type AnalystScenarioName = (typeof ANALYST_SCENARIOS)[number];

/** Explicit human actions on a proposal (spec §8.1: Accept / Send / Save). */
export const PROPOSAL_ACTIONS = ['email_sent', 'offer_applied'] as const;
export type ProposalAction = (typeof PROPOSAL_ACTIONS)[number];

/** Guardrail findings shown with an answer (spec §8.1 source verification). */
export const GUARDRAIL_CODES = [
  'unknown_source_removed',
  'unsupported_confirmation',
  'link_removed',
  'language_mismatch',
  'guarantee_language',
  'tool_denied',
  'unknown_tool',
  'web_search_unavailable',
] as const;
export type GuardrailCode = (typeof GUARDRAIL_CODES)[number];

export const ASSISTANT_LIMITS = {
  messageChars: 6000,
  contextChars: 12000,
  /** Earlier messages sent along with each new one. */
  historyMessages: 20,
  turnsPerHour: 60,
  emailsPerHour: 20,
  maxRecipients: 10,
  /** A pending reply older than this is treated as failed (e.g. after a restart). */
  pendingTimeoutMs: 4 * 60_000,
} as const;

const ARABIC_LETTER = /[ء-يٱ-ۓۺ-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/g;
const LATIN_LETTER = /[A-Za-zÀ-ɏ]/g;

/**
 * The language a message is written in: Arabic when it has more Arabic letters than Latin ones
 * (so an Arabic sentence with an English name is Arabic, and the reverse is English).
 */
export function detectLanguage(text: string): AnswerLanguage {
  const ar = text.match(ARABIC_LETTER)?.length ?? 0;
  const la = text.match(LATIN_LETTER)?.length ?? 0;
  return ar > la ? 'ar' : 'en';
}

/** The language of the next reply: the conversation's choice, or the message's own language. */
export function replyLanguageFor(pref: ReplyLanguage, message: string): AnswerLanguage {
  return pref === 'auto' ? detectLanguage(message) : pref;
}
