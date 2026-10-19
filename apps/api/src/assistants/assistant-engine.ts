/**
 * Runs one assistant turn (spec §8): research with tools, then compose the answer.
 *
 * 1. Research (assistants with tools only): the model may call the platform's read-only tools
 *    (run with the invoking user's own permissions, see assistant-tools.ts) and the provider's
 *    web search. Every call is logged to ai_tool_calls as it happens (tool, query, user,
 *    assistant, time, outcome). Results are registered as sources (P…, W…).
 * 2. Compose: the model writes the final answer as JSON (per-assistant schema), citing source
 *    ids from the evidence pack.
 * 3. Guardrails (guardrails.ts) check citations, confidence labels, links, guarantee wording and
 *    language; Offer Optimizer costs are computed here from the terms.
 *
 * The result is stored on the assistant message as a proposal. Nothing else is written: the
 * engine has no access to any service method that creates, changes or deletes data, and no
 * model output is ever used to call one.
 */
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import {
  type AnalystContext,
  type AnswerLanguage,
  ASSISTANT_FEATURES,
  ASSISTANT_LIMITS,
  type AssistantAnswer,
  type AssistantKey,
  costDelta,
  type EmailContext,
  type FormalContext,
  type GuardrailFlagDto,
  type OfferAnswer,
  type OfferContext,
  offerCost,
  type OfferTerms,
  offerTermsSchema,
  replyLanguageFor,
  type ReplyLanguage,
  type SourceDto,
  type ToolCallKind,
  type ToolCallOutcome,
} from '@esports/shared';
import { and, asc, eq, lt } from 'drizzle-orm';
import {
  AI_PROVIDER,
  type AiConverseMessage,
  type AiProvider,
  type AiUsage,
  WebSearchUnavailableError,
} from '../ai/ai.provider';
import type { TenantContext } from '../authz/context';
import { AppError } from '../common/errors';
import { type Env, ENV } from '../config/env';
import { DB, type Database } from '../db/client';
import { organizations } from '../db/schema';
import { aiMessages, aiToolCalls } from '../db/schema-assistants';
import {
  ANSWER_PARSERS,
  ANSWER_SCHEMAS,
  composePrompt,
  composeSystem,
  mainText,
  researchSystem,
} from './assistant-prompts';
import { AssistantTools, type PlatformTool, ToolDenied } from './assistant-tools';
import {
  checkClaims,
  checkGuarantees,
  Flags,
  languageMatches,
  mapStrings,
  scrubLinks,
  SourceRegistry,
  urlsIn,
} from './guardrails';

const MAX_RESEARCH_CALLS = 6;
const MAX_PLATFORM_TOOL_RUNS = 10;
const WEB_SEARCH_MAX_USES = 5;
const HISTORY_CHARS = 24_000;

export interface TurnConversation {
  id: string;
  organizationId: string;
  assistant: string;
  replyLanguage: string;
  webSearch: boolean;
  context: Record<string, unknown>;
}

export interface TurnResult {
  answer: AssistantAnswer;
  sources: SourceDto[];
  flags: GuardrailFlagDto[];
  language: AnswerLanguage;
  model: string;
  usage: AiUsage & { calls: number };
}

const NOT_AVAILABLE = {
  error: 'not_available',
  message: 'This data is not available to this user, or it does not exist.',
};

@Injectable()
export class AssistantEngine implements OnModuleDestroy {
  private readonly logger = new Logger('Assistants');
  private readonly inflight = new Set<Promise<void>>();

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(AI_PROVIDER) private readonly ai: AiProvider,
    @Inject(ENV) private readonly env: Env,
    private readonly tools: AssistantTools,
  ) {}

  get webSearchEnabled() {
    return this.env.ASSISTANT_WEB_SEARCH === 'on';
  }

  /** Starts a turn in the background; the client polls the conversation for the result. */
  start(ctx: TenantContext, conv: TurnConversation, messageId: string, text: string) {
    const p: Promise<void> = this.run(ctx, conv, messageId, text).finally(() =>
      this.inflight.delete(p),
    );
    this.inflight.add(p);
  }

  /** Lets running turns finish on shutdown (bounded). */
  async onModuleDestroy() {
    if (!this.inflight.size) return;
    await Promise.race([
      Promise.allSettled([...this.inflight]),
      new Promise((r) => setTimeout(r, 15_000)),
    ]);
  }

  /** For tests: resolves when no turn is running. */
  async idle() {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  private async run(ctx: TenantContext, conv: TurnConversation, messageId: string, text: string) {
    try {
      const r = await this.turn(ctx, conv, messageId, text);
      await this.db
        .update(aiMessages)
        .set({
          status: 'complete',
          answer: r.answer,
          sources: r.sources,
          flags: r.flags,
          language: r.language,
          provider: this.ai.name,
          model: r.model,
          usage: r.usage,
          completedAt: new Date(),
        })
        .where(and(eq(aiMessages.id, messageId), eq(aiMessages.status, 'pending')));
    } catch (e) {
      const code = e instanceof AppError ? e.code : 'internal_error';
      if (!(e instanceof AppError))
        this.logger.error(`Assistant turn failed: ${e instanceof Error ? e.message : String(e)}`);
      await this.db
        .update(aiMessages)
        .set({ status: 'failed', errorCode: code, provider: this.ai.name, completedAt: new Date() })
        .where(and(eq(aiMessages.id, messageId), eq(aiMessages.status, 'pending')))
        .catch(() => undefined);
    }
  }

  async turn(
    ctx: TenantContext,
    conv: TurnConversation,
    messageId: string,
    text: string,
  ): Promise<TurnResult> {
    const key = conv.assistant as AssistantKey;
    const features = ASSISTANT_FEATURES[key];
    const language = replyLanguageFor(conv.replyLanguage as ReplyLanguage, text);
    const registry = new SourceRegistry();
    const flags = new Flags();
    const usage = { inputTokens: 0, outputTokens: 0, webSearchRequests: 0, calls: 0 };
    const add = (u: AiUsage | undefined) => {
      usage.calls += 1;
      if (!u) return;
      usage.inputTokens += u.inputTokens;
      usage.outputTokens += u.outputTokens;
      usage.webSearchRequests += u.webSearchRequests;
    };
    const log = this.toolLogger(ctx, conv, messageId);

    const [org] = await this.db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, ctx.organizationId));
    const orgName = org?.name ?? 'the organization';
    const history = await this.history(conv.id, messageId);
    const userContext = await this.userContext(ctx, key, conv.context, registry, log);

    // 1. Research.
    let notes: string | null = null;
    const tools = features.tools ? this.tools.forUser(ctx, key) : [];
    const webSearch = features.tools && conv.webSearch && this.webSearchEnabled;
    if (tools.length || webSearch) {
      notes = await this.research({
        ctx,
        key,
        orgName,
        language,
        history,
        text,
        userContext,
        tools,
        webSearch,
        registry,
        flags,
        log,
        add,
      });
    }

    // 2. Compose (one retry if the answer comes back in the wrong language).
    const userTexts = [
      text,
      ...history.filter((h) => h.role === 'user').map((h) => h.text),
      JSON.stringify(conv.context),
    ];
    let answer: AssistantAnswer | null = null;
    let model = this.ai.model ?? this.ai.name;
    for (let attempt = 0; attempt < 2 && !answer; attempt++) {
      const res = await this.ai.generateJson({
        system: composeSystem(key, orgName, language),
        prompt: composePrompt({
          history,
          message: text,
          userContext,
          evidence: registry.evidencePack(),
          notes,
          language,
          extraInstruction:
            attempt > 0
              ? `IMPORTANT: your previous answer was not in ${language === 'ar' ? 'Arabic' : 'English'}. Write every field in ${language === 'ar' ? 'Arabic' : 'English'}.`
              : undefined,
        }),
        schema: ANSWER_SCHEMAS[key],
        maxTokens: 8000,
      });
      add(res.usage);
      model = res.model;
      const parsed = ANSWER_PARSERS[key].safeParse(res.data);
      if (!parsed.success)
        throw new AppError('ai_unavailable', 502, 'The assistant returned an unreadable answer.');
      const candidate = this.finalize(key, parsed.data, conv.context, registry, flags);
      if (attempt === 0 && !languageMatches(mainText(candidate as never), language)) continue;
      if (!languageMatches(mainText(candidate as never), language))
        flags.add('language_mismatch', language);
      answer = candidate;
    }
    // 3. Links: only ones a tool returned or the user wrote.
    const allowed = [...registry.urls(), ...urlsIn(userTexts)];
    answer = mapStrings(answer!, (s) => scrubLinks(s, allowed, flags));

    return { answer, sources: registry.list(), flags: flags.all(), language, model, usage };
  }

  // ------------------------------------------------------------------------------------------

  private toolLogger(ctx: TenantContext, conv: TurnConversation, messageId: string) {
    return async (e: {
      tool: string;
      kind: ToolCallKind;
      input: Record<string, unknown>;
      outcome: ToolCallOutcome;
      summary?: { count?: number; sourceIds?: string[]; error?: string };
      startedAt: number;
    }) => {
      const input = JSON.stringify(e.input ?? {});
      await this.db.insert(aiToolCalls).values({
        organizationId: ctx.organizationId,
        conversationId: conv.id,
        messageId,
        userId: ctx.user.id,
        assistant: conv.assistant,
        tool: e.tool,
        kind: e.kind,
        input: input.length > 2000 ? { truncated: input.slice(0, 2000) } : (e.input ?? {}),
        outcome: e.outcome,
        resultSummary: e.summary ?? {},
        durationMs: Date.now() - e.startedAt,
      });
    };
  }

  private async research(p: {
    ctx: TenantContext;
    key: AssistantKey;
    orgName: string;
    language: AnswerLanguage;
    history: { role: 'user' | 'assistant'; text: string }[];
    text: string;
    userContext: string | null;
    tools: PlatformTool[];
    webSearch: boolean;
    registry: SourceRegistry;
    flags: Flags;
    log: ReturnType<AssistantEngine['toolLogger']>;
    add: (u: AiUsage) => void;
  }): Promise<string | null> {
    const byName = new Map(p.tools.map((t) => [t.name, t]));
    const messages: AiConverseMessage[] = [
      ...p.history.map((h) => ({ role: h.role, text: h.text })),
      {
        role: 'user',
        text: p.userContext
          ? `${p.text}\n\n<user_context>\n${p.userContext}\n</user_context>`
          : p.text,
      },
    ];
    let web = p.webSearch;
    let toolRuns = 0;
    const notes: string[] = [];
    const queries = new Map<string, { query: string; at: number }>();

    for (let call = 0; call < MAX_RESEARCH_CALLS; call++) {
      let res;
      try {
        res = await this.ai.converse({
          system: researchSystem(p.key, p.orgName, p.language),
          messages,
          tools: p.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
          webSearch: web ? { maxUses: WEB_SEARCH_MAX_USES } : null,
          maxTokens: 3000,
        });
      } catch (e) {
        if (e instanceof WebSearchUnavailableError && web) {
          web = false;
          p.flags.add('web_search_unavailable');
          continue;
        }
        throw e;
      }
      p.add(res.usage);
      const toolUses: { id: string; name: string; input: Record<string, unknown> }[] = [];
      for (const b of res.blocks) {
        if (b.type === 'text') {
          const cited = b.citations.map((c) =>
            p.registry.addWebExcerpt(c.url, c.title, c.citedText),
          );
          const line = b.text.trim();
          if (line) notes.push(cited.length ? `${line} [${[...new Set(cited)].join(', ')}]` : line);
        } else if (b.type === 'web_search') {
          queries.set(b.id, { query: b.query, at: Date.now() });
        } else if (b.type === 'web_search_result') {
          const q = queries.get(b.toolUseId);
          queries.delete(b.toolUseId);
          const ids = b.results.map((r) => p.registry.addWeb(r.url, r.title, r.pageAge));
          await p.log({
            tool: 'web_search',
            kind: 'web_search',
            input: { query: q?.query ?? '' },
            outcome: b.errorCode ? 'error' : 'ok',
            summary: b.errorCode
              ? { error: b.errorCode }
              : { count: b.results.length, sourceIds: ids },
            startedAt: q?.at ?? Date.now(),
          });
        } else if (b.type === 'tool_use') {
          toolUses.push(b);
        }
      }
      messages.push({ role: 'assistant_turn', raw: res.raw });
      if (res.stopReason === 'pause_turn') continue;
      if (res.stopReason !== 'tool_use' || !toolUses.length) break;

      const results: { toolUseId: string; content: string; isError: boolean }[] = [];
      for (const tu of toolUses) {
        const startedAt = Date.now();
        const tool = byName.get(tu.name);
        if (!tool) {
          // Not one of this assistant's tools for this user — in particular, nothing that writes.
          p.flags.add('unknown_tool', tu.name.slice(0, 80));
          await p.log({
            tool: tu.name.slice(0, 80),
            kind: 'platform',
            input: tu.input,
            outcome: 'unknown_tool',
            startedAt,
          });
          results.push({
            toolUseId: tu.id,
            isError: true,
            content: JSON.stringify({
              error: 'unknown_tool',
              message:
                'There is no such tool. You can only look things up; you cannot change, save or send anything.',
            }),
          });
          continue;
        }
        if (toolRuns >= MAX_PLATFORM_TOOL_RUNS) {
          results.push({
            toolUseId: tu.id,
            isError: true,
            content: JSON.stringify({
              error: 'limit',
              message: 'Lookup limit reached for this message.',
            }),
          });
          continue;
        }
        toolRuns += 1;
        try {
          const r = await this.tools.run(tool, { ctx: p.ctx, registry: p.registry }, tu.input);
          await p.log({
            tool: tool.name,
            kind: 'platform',
            input: tu.input,
            outcome: 'ok',
            summary: { count: r.count, sourceIds: r.sourceId ? [r.sourceId] : [] },
            startedAt,
          });
          results.push({ toolUseId: tu.id, isError: false, content: JSON.stringify(r.data) });
        } catch (e) {
          const outcome = e instanceof ToolDenied ? e.outcome : 'error';
          if (!(e instanceof ToolDenied))
            this.logger.warn(
              `Tool ${tool.name} failed: ${e instanceof Error ? e.message : String(e)}`,
            );
          if (outcome === 'denied' || outcome === 'not_found')
            p.flags.add('tool_denied', tool.name);
          await p.log({ tool: tool.name, kind: 'platform', input: tu.input, outcome, startedAt });
          results.push({
            toolUseId: tu.id,
            isError: true,
            content: JSON.stringify(
              outcome === 'error'
                ? { error: 'failed', message: 'The lookup failed.' }
                : NOT_AVAILABLE,
            ),
          });
        }
      }
      messages.push({ role: 'tool_results', results });
    }
    // Searches that never returned a result block.
    for (const [, q] of queries)
      await p.log({
        tool: 'web_search',
        kind: 'web_search',
        input: { query: q.query },
        outcome: 'error',
        summary: { error: 'no_result' },
        startedAt: q.at,
      });
    return notes.join('\n').trim() || null;
  }

  /** Earlier messages of the conversation, as plain text (newest last, bounded). */
  private async history(conversationId: string, beforeMessageId: string) {
    const [current] = await this.db
      .select({ seq: aiMessages.seq })
      .from(aiMessages)
      .where(eq(aiMessages.id, beforeMessageId));
    const rows = await this.db
      .select()
      .from(aiMessages)
      .where(
        and(
          eq(aiMessages.conversationId, conversationId),
          lt(aiMessages.seq, (current?.seq ?? 1) - 1),
        ),
      )
      .orderBy(asc(aiMessages.seq));
    const out: { role: 'user' | 'assistant'; text: string }[] = [];
    for (const m of rows) {
      if (m.role === 'user' && m.text) out.push({ role: 'user', text: m.text });
      if (m.role === 'assistant' && m.status === 'complete' && m.answer)
        out.push({ role: 'assistant', text: historyText(m.answer) });
    }
    // Keep the most recent messages within the limits; pairs stay in order.
    let total = 0;
    const kept: typeof out = [];
    for (const m of out.reverse()) {
      if (kept.length >= ASSISTANT_LIMITS.historyMessages || total + m.text.length > HISTORY_CHARS)
        break;
      kept.unshift(m);
      total += m.text.length;
    }
    while (kept.length && kept[0]!.role === 'assistant') kept.shift();
    return kept;
  }

  /**
   * Context the user provided for this conversation, as evidence (U…). Platform records the user
   * picked (a roster member, a contract) are fetched through the same permission-checked tools
   * and logged like any other tool call.
   */
  private async userContext(
    ctx: TenantContext,
    key: AssistantKey,
    raw: Record<string, unknown>,
    registry: SourceRegistry,
    log: ReturnType<AssistantEngine['toolLogger']>,
  ): Promise<string | null> {
    const lines = (pairs: [string, string | null | undefined][]) =>
      pairs
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n');
    const pick = async (name: string, input: Record<string, unknown>) => {
      const tool = this.tools.all.find((t) => t.name === name)!;
      const startedAt = Date.now();
      try {
        const r = await this.tools.run(tool, { ctx, registry }, input);
        await log({
          tool: name,
          kind: 'platform',
          input,
          outcome: 'ok',
          summary: { count: r.count, sourceIds: r.sourceId ? [r.sourceId] : [] },
          startedAt,
        });
        return r.sourceId;
      } catch (e) {
        const outcome = e instanceof ToolDenied ? e.outcome : 'error';
        await log({ tool: name, kind: 'platform', input, outcome, startedAt });
        return null;
      }
    };

    if (key === 'formal_message') {
      const c = raw as FormalContext;
      const t = lines([
        ['Recipient', c.recipient],
        ['Sender', c.sender],
        ['Purpose and context', c.purpose],
      ]);
      if (!t) return null;
      const id = registry.addUser('Context you provided', t, 'user_context');
      return `[${id}] Context provided by the user:\n${t}`;
    }
    if (key === 'email') {
      const c = raw as EmailContext;
      const t = lines([
        ['Recipient name', c.recipientName],
        ['Recipient email', c.recipientEmail],
        ['Recipient role', c.recipientRole],
        ['Game or team', c.gameOrTeam],
        ['Purpose and context', c.purpose],
        ['Requested tone', c.tone],
      ]);
      if (!t) return null;
      const id = registry.addUser('Email brief you provided', t, 'user_email_brief');
      return `[${id}] Email brief provided by the user:\n${t}`;
    }
    if (key === 'offer_optimizer') {
      const c = raw as Partial<OfferContext>;
      const preferred = normalizeTerms(c.preferred);
      const requested = normalizeTerms(c.requested);
      const parts: string[] = [];
      if (c.contractId) {
        const id = await pick('get_contract_terms', { contractId: c.contractId });
        if (id) parts.push(`The preferred terms were loaded from the contract in ${id}.`);
      }
      const describe = (label: string, t: OfferTerms) => {
        const cost = offerCost(t);
        return `${label}:\n${termsText(t)}\nCalculated by the platform: monthly ${cost.monthly ?? 'n/a'} ${t.currency}; pay over the term ${cost.base ?? 'n/a'}; signing bonus ${cost.signingBonus}; all bonuses ${cost.bonusesMax}; total upper bound ${cost.totalUpperBound ?? 'n/a'} ${t.currency}${cost.notes.length ? ` (notes: ${cost.notes.join(', ')})` : ''}.`;
      };
      const t = [
        c.counterparty ? `Other party: ${c.counterparty}` : '',
        describe("The organization's preferred terms", preferred),
        describe("The other party's requested terms", requested),
        c.notes ? `Notes: ${c.notes}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      const id = registry.addUser('Terms you provided', t, 'user_terms');
      parts.unshift(`[${id}] Terms provided by the user (costs calculated by the platform):\n${t}`);
      return parts.join('\n\n');
    }
    if (key === 'player_analyst') {
      const c = raw as Partial<AnalystContext>;
      const parts: string[] = [];
      if (c.rosterMemberId) {
        const id = await pick('get_roster_member', { rosterMemberId: c.rosterMemberId });
        if (id) parts.push(`The player selected by the user is the roster member in ${id}.`);
      }
      const t = lines([
        ['Player profile', c.profile],
        ['Evidence', c.evidence],
      ]);
      if (t) {
        const id = registry.addUser('Profile and evidence you provided', t, 'user_profile');
        parts.unshift(`[${id}] Player profile and evidence provided by the user:\n${t}`);
      }
      return parts.length ? parts.join('\n\n') : null;
    }
    return null;
  }

  /** Per-assistant post-processing: claims checked, offer costs computed, recipients filled. */
  private finalize(
    key: AssistantKey,
    parsed: unknown,
    rawContext: Record<string, unknown>,
    registry: SourceRegistry,
    flags: Flags,
  ): AssistantAnswer {
    if (key === 'offer_optimizer') {
      const p = parsed as z_offer;
      const ctx = rawContext as Partial<OfferContext>;
      const preferred = normalizeTerms(ctx.preferred);
      const requested = normalizeTerms(ctx.requested);
      const preferredCost = offerCost(preferred);
      const requestedCost = offerCost(requested);
      const alternatives = p.alternatives.map((a) => {
        const terms = normalizeTerms(a.terms, preferred.currency);
        const cost = offerCost(terms);
        return {
          label: a.label,
          terms,
          rationale: a.rationale,
          risk: a.risk,
          riskExplanation: a.riskExplanation,
          tradeoffs: a.tradeoffs,
          financialImpact: a.financialImpact,
          cost,
          deltaVsPreferred: costDelta(cost, preferredCost),
          deltaVsRequested: costDelta(cost, requestedCost),
        };
      });
      checkGuarantees(
        alternatives
          .flatMap((a) => [a.rationale, a.financialImpact, a.tradeoffs])
          .concat(p.recommendation),
        flags,
      );
      const answer: OfferAnswer = {
        kind: 'offer_optimizer',
        summary: p.summary,
        differences: p.differences,
        constraints: p.constraints,
        alternatives,
        recommendation: p.recommendation,
        claims: checkClaims(p.claims, registry, flags),
        gaps: p.gaps,
        preferredCost,
        requestedCost,
      };
      return answer;
    }
    const a = parsed as AssistantAnswer;
    if (a.kind === 'general') return { ...a, claims: checkClaims(a.claims, registry, flags) };
    if (a.kind === 'player_analyst') {
      checkGuarantees(
        [
          a.summary,
          a.potentialReturn,
          ...a.scenarios.flatMap((s) => [s.narrative, s.potentialReturn]),
        ],
        flags,
      );
      return { ...a, claims: checkClaims(a.claims, registry, flags) };
    }
    if (a.kind === 'email') {
      // A recipient address the user typed in is theirs to use; the model never invents one.
      const c = rawContext as Partial<EmailContext>;
      if (c.recipientEmail && !a.to.some((r) => r.email)) {
        const to = a.to.length ? a.to : [{ name: c.recipientName ?? null, email: null }];
        to[0] = { ...to[0]!, email: c.recipientEmail };
        return { ...a, to };
      }
    }
    return a;
  }
}

type z_offer = {
  summary: string;
  differences: { term: string; preferred: string; requested: string; note: string }[];
  constraints: string[];
  alternatives: {
    label: string;
    terms: Record<string, unknown>;
    rationale: string;
    risk: 'low' | 'medium' | 'high';
    riskExplanation: string;
    tradeoffs: string;
    financialImpact: string;
  }[];
  recommendation: string;
  claims: {
    text: string;
    confidence: 'confirmed' | 'estimated' | 'uncertain';
    sourceIds: string[];
  }[];
  gaps: string[];
};

/** Terms from user input or model output: empty strings become null, invalid values dropped. */
export function normalizeTerms(raw: unknown, fallbackCurrency = 'SAR'): OfferTerms {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const clean = (v: unknown) => (typeof v === 'string' ? v.trim().replace(/,/g, '') || null : v);
  const n = (v: unknown) => {
    const x = typeof v === 'string' ? Number.parseInt(v, 10) : typeof v === 'number' ? v : NaN;
    return Number.isInteger(x) && x >= 1 && x <= 120 ? x : null;
  };
  const candidate = {
    salaryAmount: clean(r.salaryAmount),
    currency:
      typeof r.currency === 'string' && r.currency
        ? r.currency.trim().toUpperCase()
        : fallbackCurrency,
    frequency: r.frequency ?? 'monthly',
    durationMonths: n(r.durationMonths),
    signingBonus: clean(r.signingBonus),
    bonuses: Array.isArray(r.bonuses)
      ? r.bonuses
          .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object')
          .map((b) => ({
            description: String(b.description ?? '').slice(0, 300) || '—',
            amount: clean(b.amount),
          }))
      : [],
    revenueSharePercent: clean(r.revenueSharePercent),
    buyoutAmount: clean(r.buyoutAmount),
    otherTerms: clean(r.otherTerms),
  };
  // Field by field, so one bad value doesn't discard the rest.
  const shape = offerTermsSchema.shape;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(candidate)) {
    const f = shape[k as keyof typeof shape].safeParse(v);
    out[k] = f.success
      ? (f.data ?? null)
      : k === 'currency'
        ? fallbackCurrency
        : k === 'frequency'
          ? 'monthly'
          : k === 'bonuses'
            ? []
            : null;
  }
  return out as unknown as OfferTerms;
}

function termsText(t: OfferTerms) {
  return [
    `- salary: ${t.salaryAmount ?? 'not set'} ${t.currency} (${t.frequency})`,
    `- duration: ${t.durationMonths ? `${t.durationMonths} months` : 'not set'}`,
    `- signing bonus: ${t.signingBonus ?? 'none'}`,
    `- bonuses: ${t.bonuses.length ? t.bonuses.map((b) => `${b.description}${b.amount ? ` (${b.amount})` : ''}`).join('; ') : 'none'}`,
    `- revenue share: ${t.revenueSharePercent ? `${t.revenueSharePercent}%` : 'none'}`,
    `- buyout: ${t.buyoutAmount ?? 'none'}`,
    t.otherTerms ? `- other: ${t.otherTerms}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** An earlier answer as conversation history. */
function historyText(a: AssistantAnswer): string {
  switch (a.kind) {
    case 'general':
      return a.reply;
    case 'formal_message':
      return a.message;
    case 'email':
      return `Subject: ${a.subject}\n\n${a.body}`;
    case 'offer_optimizer':
      return `${a.summary}\nAlternatives proposed: ${a.alternatives.map((x, i) => `${i + 1}. ${x.label}`).join('; ')}\n${a.recommendation}`;
    case 'player_analyst':
      return `${a.summary}\n${a.scenarios.map((s) => `${s.name}: ${s.narrative}`).join('\n')}`;
  }
}
