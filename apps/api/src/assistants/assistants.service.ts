/**
 * AI assistants (spec §8): conversations, messages, and the explicit human actions on proposals.
 *
 * - Access is per assistant (`assistants.<key>`), checked on every request. Conversations are
 *   private to the user who started them (anyone else gets 404).
 * - Sending a message stores it with a pending reply and starts the turn in the background; the
 *   dashboard polls. One reply in progress per conversation; a per-user hourly limit.
 * - Proposal only (spec §8.1 hard rule): an assistant turn writes nothing but its own reply and
 *   the tool-call log. Real data changes only through these separate, explicit requests:
 *     send-email  — sends the email the user reviewed (and may have edited), with
 *                   `assistants.send_email`, recorded and audited;
 *     apply-offer — saves one Offer Optimizer alternative into a draft contract as a new version,
 *                   through ContractsService.save, so every contract permission and status rule
 *                   applies; recorded and audited.
 * - The tool-call log is readable by `audit.view` holders.
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  type ApplyOfferInput,
  ASSISTANT_CONTEXT_SCHEMAS,
  ASSISTANT_FEATURES,
  ASSISTANT_KEYS,
  ASSISTANT_LIMITS,
  ASSISTANT_PERMISSION,
  type AssistantAnswer,
  type AssistantKey,
  type AssistantMessageDto,
  type AssistantsOverviewDto,
  type ContractDetailsInput,
  type ContractDto,
  type ContractOfferTermsDto,
  contractLength,
  contractSaveSchema,
  type ConversationDto,
  type ConversationSummaryDto,
  type CreateConversationInput,
  detectLanguage,
  EDITABLE_STATUSES,
  type ContractStatus,
  type OfferAnswer,
  type OfferTerms,
  type ProposalAction,
  type ReplyLanguage,
  type SendProposedEmailInput,
  type ToolCallLogDto,
  type UpdateConversationInput,
} from '@esports/shared';
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AiRouter } from '../ai/ai.router.js';
import type { TenantContext } from '../authz/context.js';
import { AuditService } from '../audit/audit.service.js';
import { AppError, Errors } from '../common/errors.js';
import { RateLimitService } from '../common/rate-limit.js';
import { DB, type Database } from '../db/client.js';
import { users } from '../db/schema.js';
import {
  aiConversations,
  aiMessages,
  aiProposalActions,
  aiToolCalls,
} from '../db/schema-assistants.js';
import { ContractsService } from '../contracts/contracts.service.js';
import { MailService } from '../mail/mail.service.js';
import { AssistantEngine, normalizeTerms } from './assistant-engine.js';

type ConversationRow = typeof aiConversations.$inferSelect;
type MessageRow = typeof aiMessages.$inferSelect;

const busy = () =>
  new AppError('assistant_busy', 409, 'A reply is still being prepared in this conversation.');

@Injectable()
export class AssistantsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly router: AiRouter,
    private readonly engine: AssistantEngine,
    private readonly limiter: RateLimitService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly contracts: ContractsService,
  ) {}

  // ---------------------------------------------------------------- access

  private allowed(ctx: TenantContext, key: AssistantKey) {
    return ctx.access.has(ASSISTANT_PERMISSION[key]);
  }

  private requireAssistant(ctx: TenantContext, key: AssistantKey) {
    if (!this.allowed(ctx, key))
      throw new AppError('assistant_not_allowed', 403, 'You do not have access to this assistant');
  }

  /** The caller's own conversation (and they still have that assistant), else 404 / 403. */
  private async own(ctx: TenantContext, id: string): Promise<ConversationRow> {
    const [c] = await this.db
      .select()
      .from(aiConversations)
      .where(
        and(
          eq(aiConversations.id, id),
          eq(aiConversations.organizationId, ctx.organizationId),
          eq(aiConversations.userId, ctx.user.id),
        ),
      );
    if (!c) throw Errors.notFound('Conversation');
    this.requireAssistant(ctx, c.assistant as AssistantKey);
    return c;
  }

  private parseContext(key: AssistantKey, raw: unknown) {
    const r = ASSISTANT_CONTEXT_SCHEMAS[key].safeParse(raw ?? {});
    if (!r.success) throw Errors.validation(r.error.issues);
    return r.data as Record<string, unknown>;
  }

  overview(ctx: TenantContext): AssistantsOverviewDto {
    const assistants = ASSISTANT_KEYS.map((key) => {
      const d = this.router.describe(key);
      return {
        key,
        allowed: this.allowed(ctx, key),
        tools: ASSISTANT_FEATURES[key].tools,
        webSearchDefault: ASSISTANT_FEATURES[key].webSearchDefault,
        proposal: ASSISTANT_FEATURES[key].proposal,
        provider: d.provider,
        configured: d.configured,
        model: d.model,
        // Web search needs both the deployment switch and a provider that can search.
        webSearchAvailable:
          this.engine.webSearchEnabled && d.webSearch && ASSISTANT_FEATURES[key].tools,
      };
    });
    const first = assistants.find((a) => a.configured);
    return {
      configured: !!first,
      provider: first?.provider ?? null,
      model: first?.model ?? null,
      webSearch: this.engine.webSearchEnabled,
      canSendEmail: ctx.access.has('assistants.send_email'),
      assistants,
    };
  }

  // ---------------------------------------------------------------- conversations

  async list(
    ctx: TenantContext,
    assistant: AssistantKey,
    archived: boolean,
  ): Promise<ConversationSummaryDto[]> {
    this.requireAssistant(ctx, assistant);
    const rows = await this.db
      .select({
        c: aiConversations,
        pending: sql<boolean>`exists (select 1 from app.ai_messages m where m.conversation_id = ${aiConversations.id} and m.status = 'pending')`,
      })
      .from(aiConversations)
      .where(
        and(
          eq(aiConversations.organizationId, ctx.organizationId),
          eq(aiConversations.userId, ctx.user.id),
          eq(aiConversations.assistant, assistant),
          archived
            ? sql`${aiConversations.archivedAt} is not null`
            : isNull(aiConversations.archivedAt),
        ),
      )
      .orderBy(desc(aiConversations.updatedAt))
      .limit(100);
    return rows.map((r) => this.summary(r.c, !!r.pending));
  }

  async create(ctx: TenantContext, input: CreateConversationInput): Promise<ConversationDto> {
    this.requireAssistant(ctx, input.assistant);
    const features = ASSISTANT_FEATURES[input.assistant];
    const [c] = await this.db
      .insert(aiConversations)
      .values({
        organizationId: ctx.organizationId,
        userId: ctx.user.id,
        assistant: input.assistant,
        title: input.title ?? '',
        replyLanguage: input.replyLanguage,
        webSearch: features.tools && (input.webSearch ?? features.webSearchDefault),
        context: this.parseContext(input.assistant, input.context),
      })
      .returning();
    return this.get(ctx, c!.id);
  }

  async update(ctx: TenantContext, id: string, input: UpdateConversationInput) {
    const c = await this.own(ctx, id);
    const key = c.assistant as AssistantKey;
    await this.db
      .update(aiConversations)
      .set({
        ...(input.title !== undefined ? { title: input.title ?? '' } : {}),
        ...(input.replyLanguage ? { replyLanguage: input.replyLanguage } : {}),
        ...(input.webSearch !== undefined
          ? { webSearch: ASSISTANT_FEATURES[key].tools && input.webSearch }
          : {}),
        ...(input.context !== undefined ? { context: this.parseContext(key, input.context) } : {}),
        ...(input.archived !== undefined ? { archivedAt: input.archived ? new Date() : null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(aiConversations.id, id));
    return this.get(ctx, id);
  }

  async get(ctx: TenantContext, id: string): Promise<ConversationDto> {
    const c = await this.own(ctx, id);
    await this.expireStale(c.id);
    const messages = await this.db
      .select()
      .from(aiMessages)
      .where(eq(aiMessages.conversationId, c.id))
      .orderBy(aiMessages.seq);
    const ids = messages.map((m) => m.id);
    const calls = ids.length
      ? await this.db
          .select()
          .from(aiToolCalls)
          .where(inArray(aiToolCalls.messageId, ids))
          .orderBy(aiToolCalls.createdAt)
      : [];
    const actions = ids.length
      ? await this.db
          .select({ a: aiProposalActions, name: users.displayName })
          .from(aiProposalActions)
          .innerJoin(users, eq(users.id, aiProposalActions.userId))
          .where(inArray(aiProposalActions.messageId, ids))
          .orderBy(aiProposalActions.createdAt)
      : [];
    return {
      ...this.summary(
        c,
        messages.some((m) => m.status === 'pending'),
      ),
      context: c.context,
      messages: messages.map((m): AssistantMessageDto => ({
        id: m.id,
        role: m.role as 'user' | 'assistant',
        status: m.status as AssistantMessageDto['status'],
        language: (m.language as 'ar' | 'en' | null) ?? null,
        text: m.text,
        answer: m.answer ?? null,
        sources: m.sources,
        flags: m.flags,
        toolCalls: calls
          .filter((t) => t.messageId === m.id)
          .map((t) => ({
            id: t.id,
            tool: t.tool,
            kind: t.kind as 'platform' | 'web_search',
            input: t.input,
            outcome: t.outcome as ToolCallLogDto['outcome'],
            createdAt: t.createdAt.toISOString(),
          })),
        actions: actions
          .filter((a) => a.a.messageId === m.id)
          .map((a) => ({
            id: a.a.id,
            action: a.a.action as ProposalAction,
            detail: a.a.detail,
            createdAt: a.a.createdAt.toISOString(),
            user: { id: a.a.userId, displayName: a.name },
          })),
        errorCode: m.errorCode,
        model: m.model,
        createdAt: m.createdAt.toISOString(),
        completedAt: m.completedAt?.toISOString() ?? null,
      })),
    };
  }

  /** A reply left pending past the limit (e.g. the server restarted mid-turn) is failed. */
  private async expireStale(conversationId: string) {
    await this.db
      .update(aiMessages)
      .set({ status: 'failed', errorCode: 'timeout', completedAt: new Date() })
      .where(
        and(
          eq(aiMessages.conversationId, conversationId),
          eq(aiMessages.status, 'pending'),
          lt(aiMessages.createdAt, new Date(Date.now() - ASSISTANT_LIMITS.pendingTimeoutMs)),
        ),
      );
  }

  private summary(c: ConversationRow, pending: boolean): ConversationSummaryDto {
    return {
      id: c.id,
      assistant: c.assistant as AssistantKey,
      title: c.title,
      replyLanguage: c.replyLanguage as ReplyLanguage,
      webSearch: c.webSearch,
      archived: !!c.archivedAt,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
      pending,
    };
  }

  // ---------------------------------------------------------------- messages

  async send(ctx: TenantContext, id: string, text: string): Promise<ConversationDto> {
    const c = await this.own(ctx, id);
    const key = c.assistant as AssistantKey;
    if (!this.router.for(key).configured)
      throw new AppError(
        'ai_not_configured',
        503,
        `The AI assistants are not configured (${this.router.keyVar(key)} is not set).`,
      );
    if (c.archivedAt) throw Errors.conflict('conflict', 'This conversation is archived');
    const wait = await this.limiter.consume(
      `assistants:turns:${ctx.user.id}`,
      ASSISTANT_LIMITS.turnsPerHour,
      3600,
    );
    if (wait !== null)
      throw new AppError('rate_limited', 429, 'Too many messages; try again later', {
        retryAfterSeconds: wait,
      });
    await this.expireStale(c.id);

    const assistantMessageId = await this.db.transaction(async (tx) => {
      await tx
        .select({ id: aiConversations.id })
        .from(aiConversations)
        .where(eq(aiConversations.id, c.id))
        .for('update');
      const [state] = await tx
        .select({
          max: sql<number>`coalesce(max(${aiMessages.seq}), 0)::int`,
          pending: sql<number>`count(*) filter (where ${aiMessages.status} = 'pending')::int`,
        })
        .from(aiMessages)
        .where(eq(aiMessages.conversationId, c.id));
      if (state!.pending > 0) throw busy();
      await tx.insert(aiMessages).values({
        organizationId: ctx.organizationId,
        conversationId: c.id,
        seq: state!.max + 1,
        role: 'user',
        status: 'complete',
        language: detectLanguage(text),
        text,
        completedAt: new Date(),
      });
      const [pending] = await tx
        .insert(aiMessages)
        .values({
          organizationId: ctx.organizationId,
          conversationId: c.id,
          seq: state!.max + 2,
          role: 'assistant',
          status: 'pending',
        })
        .returning({ id: aiMessages.id });
      await tx
        .update(aiConversations)
        .set({
          updatedAt: new Date(),
          ...(c.title ? {} : { title: titleFrom(text) }),
        })
        .where(eq(aiConversations.id, c.id));
      return pending!.id;
    });
    this.engine.start(
      ctx,
      {
        id: c.id,
        organizationId: c.organizationId,
        assistant: c.assistant,
        replyLanguage: c.replyLanguage,
        webSearch: c.webSearch,
        context: c.context,
      },
      assistantMessageId,
      text,
    );
    return this.get(ctx, c.id);
  }

  /** A completed reply of the caller's own conversation with the given assistant. */
  private async ownAnswer<K extends AssistantAnswer['kind']>(
    ctx: TenantContext,
    messageId: string,
    kind: K,
  ): Promise<{ m: MessageRow; c: ConversationRow; answer: Extract<AssistantAnswer, { kind: K }> }> {
    const [r] = await this.db
      .select({ m: aiMessages, c: aiConversations })
      .from(aiMessages)
      .innerJoin(aiConversations, eq(aiConversations.id, aiMessages.conversationId))
      .where(
        and(
          eq(aiMessages.id, messageId),
          eq(aiMessages.organizationId, ctx.organizationId),
          eq(aiConversations.userId, ctx.user.id),
        ),
      );
    if (!r || r.m.role !== 'assistant' || r.m.answer?.kind !== kind)
      throw Errors.notFound('Proposal');
    this.requireAssistant(ctx, r.c.assistant as AssistantKey);
    if (r.m.status !== 'complete') throw Errors.conflict('conflict', 'This reply is not complete');
    return { ...r, answer: r.m.answer as Extract<AssistantAnswer, { kind: K }> };
  }

  private async record(
    ctx: TenantContext,
    messageId: string,
    action: ProposalAction,
    detail: Record<string, unknown>,
  ) {
    await this.db.insert(aiProposalActions).values({
      organizationId: ctx.organizationId,
      messageId,
      userId: ctx.user.id,
      action,
      detail,
    });
  }

  /** Sends the email the user reviewed. Only ever triggered by this explicit request. */
  async sendEmail(ctx: TenantContext, messageId: string, input: SendProposedEmailInput) {
    if (!ctx.access.has('assistants.send_email')) throw Errors.forbidden();
    const { c } = await this.ownAnswer(ctx, messageId, 'email');
    const wait = await this.limiter.consume(
      `assistants:emails:${ctx.user.id}`,
      ASSISTANT_LIMITS.emailsPerHour,
      3600,
    );
    if (wait !== null)
      throw new AppError('rate_limited', 429, 'Too many emails; try again later', {
        retryAfterSeconds: wait,
      });
    const to = input.to.map((r) => r.email);
    const cc = input.cc.map((r) => r.email);
    const ok = await this.mail.send({
      to: to.join(', '),
      cc,
      replyTo: ctx.user.email,
      subject: input.subject,
      text: input.body,
      template: 'assistant_email',
    });
    if (!ok) throw new AppError('email_send_failed', 502, 'The email could not be sent.');
    const detail = { to, cc, subject: input.subject };
    await this.record(ctx, messageId, 'email_sent', detail);
    await this.audit.fromCtx(
      ctx,
      'assistant.email_sent',
      { type: 'ai_message', id: messageId },
      {
        conversationId: c.id,
        recipients: to.length + cc.length,
        subject: input.subject,
      },
    );
    return this.get(ctx, c.id);
  }

  /** Applies one alternative to a draft contract as a new version (all contract rules apply). */
  async applyOffer(
    ctx: TenantContext,
    messageId: string,
    input: ApplyOfferInput,
  ): Promise<ContractDto> {
    const { c, answer } = await this.ownAnswer(ctx, messageId, 'offer_optimizer');
    const alt = (answer as OfferAnswer).alternatives[input.alternative];
    if (!alt) throw Errors.notFound('Alternative');
    const contract = await this.contracts.get(ctx, input.contractId);
    if (!EDITABLE_STATUSES.includes(contract.status as ContractStatus))
      throw Errors.conflict(
        'contract_not_editable',
        'Only drafts and contracts with requested changes can be edited',
      );
    const details = applyTerms(contract.snapshot.details, alt.terms);
    const parsed = contractSaveSchema.safeParse({
      teamId: contract.snapshot.teamId,
      rosterMemberId: contract.snapshot.rosterMemberId,
      details,
      clauses: contract.snapshot.clauses,
      note: `Offer Optimizer: applied “${alt.label}”`.slice(0, 500),
    });
    if (!parsed.success) throw Errors.validation(parsed.error.issues);
    const saved = await this.contracts.save(ctx, input.contractId, parsed.data);
    const detail = {
      contractId: saved.id,
      number: saved.number,
      version: saved.currentVersion,
      alternative: input.alternative,
      label: alt.label,
      unchanged: !!saved.unchanged,
    };
    await this.record(ctx, messageId, 'offer_applied', detail);
    await this.audit.fromCtx(
      ctx,
      'assistant.offer_applied',
      { type: 'contract', id: saved.id },
      {
        conversationId: c.id,
        messageId,
        ...detail,
      },
    );
    return saved;
  }

  /** A visible contract's current terms, to prefill the Offer Optimizer's preferred side. */
  async contractTerms(ctx: TenantContext, contractId: string): Promise<ContractOfferTermsDto> {
    this.requireAssistant(ctx, 'offer_optimizer');
    const c = await this.contracts.get(ctx, contractId);
    const d = c.snapshot.details;
    const months =
      d.startDate && d.endDate && d.startDate <= d.endDate
        ? contractLength(d.startDate, d.endDate)
        : null;
    const terms: OfferTerms = normalizeTerms(
      {
        salaryAmount: d.compensation.amount ?? null,
        currency: d.compensation.currency,
        frequency: d.compensation.frequency,
        durationMonths: months ? months.months + (months.days >= 15 ? 1 : 0) : null,
        signingBonus: null,
        bonuses: d.bonuses.map((b) => ({ description: b.description, amount: b.amount ?? null })),
        revenueSharePercent: d.revenueShare?.percent ?? null,
        buyoutAmount: d.buyout?.amount ?? null,
        otherTerms: null,
      },
      d.compensation.currency,
    );
    return {
      contractId: c.id,
      number: c.number,
      title: c.title || c.typeNameEn,
      status: c.status,
      terms,
    };
  }

  // ---------------------------------------------------------------- tool-call log

  async toolCalls(
    ctx: TenantContext,
    q: { assistant?: AssistantKey; userId?: string; before?: string; limit: number },
  ): Promise<ToolCallLogDto[]> {
    if (!ctx.access.has('audit.view')) throw Errors.forbidden();
    const rows = await this.db
      .select({ t: aiToolCalls, name: users.displayName })
      .from(aiToolCalls)
      .innerJoin(users, eq(users.id, aiToolCalls.userId))
      .where(
        and(
          eq(aiToolCalls.organizationId, ctx.organizationId),
          q.assistant ? eq(aiToolCalls.assistant, q.assistant) : undefined,
          q.userId ? eq(aiToolCalls.userId, q.userId) : undefined,
          q.before ? lt(aiToolCalls.createdAt, new Date(q.before)) : undefined,
        ),
      )
      .orderBy(desc(aiToolCalls.createdAt))
      .limit(q.limit);
    return rows.map(({ t, name }) => ({
      id: t.id,
      conversationId: t.conversationId,
      messageId: t.messageId,
      assistant: t.assistant as AssistantKey,
      user: { id: t.userId, displayName: name },
      tool: t.tool,
      kind: t.kind as ToolCallLogDto['kind'],
      input: t.input,
      outcome: t.outcome as ToolCallLogDto['outcome'],
      resultSummary: t.resultSummary,
      durationMs: t.durationMs,
      createdAt: t.createdAt.toISOString(),
    }));
  }
}

const positive = (v: string | null | undefined) => (v && Number(v) > 0 ? v : null);

/** End date for a term of `months` starting on `start` (inclusive: 1 Jan + 12 months = 31 Dec). */
export function endDateFor(start: string, months: number): string {
  const [y, m, d] = start.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const end = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d, last)));
  end.setUTCDate(end.getUTCDate() - 1);
  return end.toISOString().slice(0, 10);
}

/**
 * The contract details with an alternative's terms applied: salary, currency, frequency,
 * duration (end date, when a start date exists), signing and performance bonuses, revenue share
 * and buyout. Fields the alternative leaves empty keep the contract's current values.
 */
export function applyTerms(details: ContractDetailsInput, t: OfferTerms): ContractDetailsInput {
  const out: ContractDetailsInput = structuredClone(details);
  const salary = positive(t.salaryAmount);
  if (salary)
    out.compensation = {
      ...out.compensation,
      amount: salary,
      currency: t.currency,
      frequency: t.frequency,
    };
  if (t.durationMonths && out.startDate) out.endDate = endDateFor(out.startDate, t.durationMonths);
  const bonuses: ContractDetailsInput['bonuses'] = t.bonuses
    .filter((b) => b.description)
    .map((b) => ({
      description: b.description,
      amount: positive(b.amount),
      currency: t.currency,
      condition: null,
    }));
  const signing = positive(t.signingBonus);
  if (signing)
    bonuses.unshift({
      description: 'Signing bonus',
      amount: signing,
      currency: t.currency,
      condition: 'Paid on signing',
    });
  if (bonuses.length) out.bonuses = bonuses.slice(0, 20);
  if (t.revenueSharePercent && Number(t.revenueSharePercent) > 0)
    out.revenueShare = { ...out.revenueShare, percent: t.revenueSharePercent };
  const buyout = positive(t.buyoutAmount);
  if (buyout) out.buyout = { ...out.buyout, amount: buyout, currency: t.currency };
  return out;
}

/** A conversation's title from its first message: up to 80 characters, cut at a word. */
export function titleFrom(text: string, max = 80): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:،؛-]+$/, '')}…`;
}

export const listQuerySchema = z.object({
  assistant: z.enum(ASSISTANT_KEYS),
  archived: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});
