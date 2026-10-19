/**
 * Phase 5 schema: AI assistant conversations, their messages (each assistant reply is a
 * proposal), the tool-call log (spec §8.1 guardrail 4) and the explicit human actions taken on
 * proposals (spec §8.1: Accept / Send / Save). Same rules as before: `app` schema, RLS on,
 * composite (organization_id, id) foreign keys.
 */
import type { AssistantAnswer, GuardrailFlagDto, SourceDto, ToolCallLogDto } from '@esports/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { appSchema, organizations, users } from './schema';

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => tstz('created_at').notNull().defaultNow();

/** A conversation belongs to one user and one assistant; nobody else can read it. */
export const aiConversations = appSchema.table(
  'ai_conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    assistant: text('assistant').notNull(),
    title: text('title').notNull().default(''),
    replyLanguage: text('reply_language').notNull().default('auto'),
    webSearch: boolean('web_search').notNull().default(false),
    /** Context the user provided (offer terms, player profile, email brief…). */
    context: jsonb('context').$type<Record<string, unknown>>().notNull().default({}),
    archivedAt: tstz('archived_at'),
    createdAt: createdAt(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('ai_conversations_org_id_unique').on(t.organizationId, t.id),
    index('ai_conversations_owner_idx').on(t.organizationId, t.userId, t.assistant, t.updatedAt),
  ],
);

/**
 * User messages and assistant replies. A reply starts `pending` and becomes `complete` (with
 * its answer, sources and guardrail flags) or `failed`; after that it never changes.
 */
export const aiMessages = appSchema.table(
  'ai_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    seq: integer('seq').notNull(),
    role: text('role').notNull(),
    status: text('status').notNull(),
    language: text('language'),
    text: text('text'),
    answer: jsonb('answer').$type<AssistantAnswer>(),
    sources: jsonb('sources').$type<SourceDto[]>().notNull().default([]),
    flags: jsonb('flags').$type<GuardrailFlagDto[]>().notNull().default([]),
    errorCode: text('error_code'),
    provider: text('provider'),
    model: text('model'),
    usage: jsonb('usage').$type<{
      inputTokens: number;
      outputTokens: number;
      webSearchRequests: number;
      calls: number;
    }>(),
    createdAt: createdAt(),
    completedAt: tstz('completed_at'),
  },
  (t) => [
    unique('ai_messages_org_id_unique').on(t.organizationId, t.id),
    unique('ai_messages_conversation_seq_unique').on(t.conversationId, t.seq),
    // One reply in progress per conversation.
    uniqueIndex('ai_messages_one_pending')
      .on(t.conversationId)
      .where(sql`${t.status} = 'pending'`),
    check(
      'ai_messages_complete_answer',
      sql`${t.role} <> 'assistant' or ${t.status} <> 'complete' or ${t.answer} is not null`,
    ),
    check('ai_messages_user_text', sql`${t.role} <> 'user' or ${t.text} is not null`),
    foreignKey({
      name: 'ai_messages_conversation_fk',
      columns: [t.organizationId, t.conversationId],
      foreignColumns: [aiConversations.organizationId, aiConversations.id],
    }).onDelete('restrict'),
  ],
);

/** Every tool call an assistant made: what, for whom, when, and what came of it. Append-only. */
export const aiToolCalls = appSchema.table(
  'ai_tool_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    messageId: uuid('message_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    assistant: text('assistant').notNull(),
    tool: text('tool').notNull(),
    kind: text('kind').notNull(),
    input: jsonb('input').$type<Record<string, unknown>>().notNull(),
    outcome: text('outcome').notNull(),
    resultSummary: jsonb('result_summary')
      .$type<ToolCallLogDto['resultSummary']>()
      .notNull()
      .default({}),
    durationMs: integer('duration_ms'),
    createdAt: createdAt(),
  },
  (t) => [
    index('ai_tool_calls_org_time_idx').on(t.organizationId, t.createdAt),
    index('ai_tool_calls_message_idx').on(t.messageId),
    foreignKey({
      name: 'ai_tool_calls_message_fk',
      columns: [t.organizationId, t.messageId],
      foreignColumns: [aiMessages.organizationId, aiMessages.id],
    }).onDelete('restrict'),
  ],
);

/** An explicit human action on a proposal: the email was sent, the offer applied. */
export const aiProposalActions = appSchema.table(
  'ai_proposal_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    messageId: uuid('message_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    action: text('action').notNull(),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index('ai_proposal_actions_message_idx').on(t.messageId),
    foreignKey({
      name: 'ai_proposal_actions_message_fk',
      columns: [t.organizationId, t.messageId],
      foreignColumns: [aiMessages.organizationId, aiMessages.id],
    }).onDelete('restrict'),
  ],
);
