/** Response types for the AI assistants (Phase 5). */
import type { Amount } from '../finance/money';
import type {
  AnswerLanguage,
  AssistantKey,
  AssistantMessageStatus,
  Confidence,
  GuardrailCode,
  ProposalAction,
  ProposalKind,
  ReplyLanguage,
  RiskLevel,
  SourceLabel,
  AnalystScenarioName,
  SourceKind,
  ToolCallKind,
  ToolCallOutcome,
} from './catalog';
import type { OfferCost, OfferTerms } from './offer';

/** A statement with its confidence and the sources it rests on (spec §8.1 guardrails 1–2). */
export interface ClaimDto {
  text: string;
  confidence: Confidence;
  /** Ids of sources in the same answer (P1, W1, U1…); only ids the tools actually produced. */
  sourceIds: string[];
}

/**
 * A source consulted for an answer. Registered by the platform when a tool returns data — never
 * taken from model output — so a citation can only point at something that was really looked up.
 */
export interface SourceDto {
  id: string;
  kind: SourceKind;
  /** English title (what the model was shown). */
  title: string;
  /** For platform and user sources: what it is, for a localized name (absent on older answers). */
  label?: SourceLabel | null;
  /** The record it concerns (team, player, contract number…), shown after the label. */
  subject?: string | null;
  /** Web page, or a dashboard path for platform data; null for user-provided context. */
  url: string | null;
  /** Web results: when the page was last updated, as reported by the search provider. */
  pageAge: string | null;
  retrievedAt: string;
  /** Short quoted text the answer relied on (web citations), when available. */
  excerpt: string | null;
}

export interface GuardrailFlagDto {
  code: GuardrailCode;
  detail: string | null;
}

export interface GeneralAnswer {
  kind: 'general';
  reply: string;
  claims: ClaimDto[];
  /** What isn't known or couldn't be found (spec: "gap acknowledged, not guessed"). */
  gaps: string[];
  followUps: string[];
}

/** The finished message only, no preamble (spec §8.2.2). */
export interface FormalMessageAnswer {
  kind: 'formal_message';
  message: string;
}

export interface EmailAnswer {
  kind: 'email';
  to: { name: string | null; email: string | null }[];
  cc: { name: string | null; email: string | null }[];
  subject: string;
  body: string;
  /** Points to check before sending (e.g. a missing address). Not part of the email. */
  notes: string[];
}

export interface OfferAlternativeDto {
  label: string;
  terms: OfferTerms;
  rationale: string;
  risk: RiskLevel;
  riskExplanation: string;
  tradeoffs: string;
  financialImpact: string;
  /** Computed by the platform from `terms` (never by the model). */
  cost: OfferCost;
  deltaVsPreferred: Amount | null;
  deltaVsRequested: Amount | null;
}

export interface OfferAnswer {
  kind: 'offer_optimizer';
  summary: string;
  differences: { term: string; preferred: string; requested: string; note: string }[];
  constraints: string[];
  alternatives: OfferAlternativeDto[];
  recommendation: string;
  claims: ClaimDto[];
  gaps: string[];
  preferredCost: OfferCost;
  requestedCost: OfferCost;
}

export interface AnalystScenarioDto {
  name: AnalystScenarioName;
  narrative: string;
  assumptions: string[];
  estimatedCost: string;
  potentialReturn: string;
  keyRisks: string[];
}

/** Reasoned scenarios, never guaranteed predictions (spec §8.2.5). */
export interface AnalystAnswer {
  kind: 'player_analyst';
  summary: string;
  performance: string;
  cost: string;
  risk: string;
  potentialReturn: string;
  scenarios: AnalystScenarioDto[];
  claims: ClaimDto[];
  gaps: string[];
}

export type AssistantAnswer =
  GeneralAnswer | FormalMessageAnswer | EmailAnswer | OfferAnswer | AnalystAnswer;

export interface ToolCallSummaryDto {
  id: string;
  tool: string;
  kind: ToolCallKind;
  /** What was looked up, for display (the query, or the tool's arguments). */
  input: Record<string, unknown>;
  outcome: ToolCallOutcome;
  createdAt: string;
}

export interface ProposalActionDto {
  id: string;
  action: ProposalAction;
  detail: Record<string, unknown>;
  createdAt: string;
  user: { id: string; displayName: string };
}

export interface AssistantMessageDto {
  id: string;
  role: 'user' | 'assistant';
  status: AssistantMessageStatus;
  language: AnswerLanguage | null;
  /** The user's message (user role). */
  text: string | null;
  /** The proposal or answer (assistant role, once complete). */
  answer: AssistantAnswer | null;
  sources: SourceDto[];
  flags: GuardrailFlagDto[];
  toolCalls: ToolCallSummaryDto[];
  actions: ProposalActionDto[];
  errorCode: string | null;
  model: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ConversationSummaryDto {
  id: string;
  assistant: AssistantKey;
  title: string;
  replyLanguage: ReplyLanguage;
  webSearch: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  /** A reply is being prepared. */
  pending: boolean;
}

export interface ConversationDto extends ConversationSummaryDto {
  context: Record<string, unknown>;
  messages: AssistantMessageDto[];
}

export interface AssistantInfoDto {
  key: AssistantKey;
  /** The caller holds this assistant's permission. */
  allowed: boolean;
  tools: boolean;
  webSearchDefault: boolean;
  proposal: ProposalKind;
}

export interface AssistantsOverviewDto {
  configured: boolean;
  provider: string | null;
  model: string | null;
  /** Web search is switched on for this deployment. */
  webSearch: boolean;
  canSendEmail: boolean;
  assistants: AssistantInfoDto[];
}

/** One entry of the tool-call log (spec §8.1 guardrail 4). */
export interface ToolCallLogDto extends ToolCallSummaryDto {
  conversationId: string;
  messageId: string;
  assistant: AssistantKey;
  user: { id: string; displayName: string };
  resultSummary: { count?: number; sourceIds?: string[]; error?: string };
  durationMs: number | null;
}

/** Terms read from a contract the caller can see, to prefill the Offer Optimizer. */
export interface ContractOfferTermsDto {
  contractId: string;
  number: string;
  title: string;
  status: string;
  terms: OfferTerms;
}
