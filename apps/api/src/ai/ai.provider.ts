/**
 * The one AI provider interface (spec §2: "a lightweight provider-abstraction interface, single
 * adapter module"). Assistants ask for JSON matching a schema; the adapter does the transport.
 *
 * Anthropic adapter: Messages API with structured outputs (`output_config.format` of type
 * `json_schema`), which current models support and which returns the JSON in the text block.
 * Forced tool use is not used: Claude Opus 5.5 / Sonnet 5.5 reject `tool_choice` "tool"/"any".
 * References: https://platform.claude.com/docs/en/build-with-claude/structured-outputs and
 * https://platform.claude.com/docs/en/api/errors (checked 17 Oct 2026).
 *
 * Phase 5 adds `converse()`: one model call with tools. Platform tools are defined by the caller
 * and run by the platform (read-only lookups, permission-checked per user); web search is the
 * Anthropic server tool `web_search_20250305` (run by the provider, results returned with
 * citations). The caller runs the loop: it executes requested tools and sends their results
 * back, and re-sends a paused turn (`pause_turn`) unchanged. Structured outputs can't be used in
 * the same call, because they're incompatible with citations (docs checked 18 Oct 2026:
 * https://platform.claude.com/docs/en/build-with-claude/structured-outputs#feature-compatibility,
 * https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool,
 * https://platform.claude.com/docs/en/agents-and-tools/tool-use/server-tools).
 *
 * Providers only produce text. Nothing they return is saved anywhere until a user accepts it.
 */
import { Logger } from '@nestjs/common';
import { AppError } from '../common/errors';
import type { Env } from '../config/env';

export interface AiJsonRequest {
  system: string;
  prompt: string;
  /** JSON Schema of the expected object (structured-output subset: no min/max constraints). */
  schema: Record<string, unknown>;
  maxTokens: number;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  webSearchRequests: number;
}

export interface AiJsonResult {
  data: unknown;
  model: string;
  usage?: AiUsage;
}

// ---------- Tool calling (Phase 5) ----------

/** A tool the platform runs itself (read-only platform data lookups). */
export interface AiToolDef {
  name: string;
  description: string;
  /** JSON Schema of the tool's input. */
  inputSchema: Record<string, unknown>;
}

export interface AiCitation {
  url: string;
  title: string | null;
  /** The quoted text the claim rests on (as returned by the search provider). */
  citedText: string | null;
}

/** What the model produced, provider-neutral. */
export type AiOutputBlock =
  | { type: 'text'; text: string; citations: AiCitation[] }
  /** A request to run one of the platform's tools. */
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  /** A web search the provider ran itself (server-side). */
  | { type: 'web_search'; id: string; query: string }
  | {
      type: 'web_search_result';
      toolUseId: string;
      results: { url: string; title: string; pageAge: string | null }[];
      errorCode: string | null;
    };

export type AiConverseMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string }
  /** The provider's own output from earlier in this exchange, passed back unchanged. */
  | { role: 'assistant_turn'; raw: unknown }
  /** Results of the platform tools requested in the previous assistant turn. */
  | {
      role: 'tool_results';
      results: { toolUseId: string; content: string; isError: boolean }[];
    };

export interface AiConverseRequest {
  system: string;
  messages: AiConverseMessage[];
  tools: AiToolDef[];
  /** Let the provider search the web (null: no web search). */
  webSearch: { maxUses: number } | null;
  maxTokens: number;
}

export type AiStopReason =
  'end_turn' | 'tool_use' | 'pause_turn' | 'max_tokens' | 'refusal' | 'other';

export interface AiConverseResult {
  blocks: AiOutputBlock[];
  /** Opaque provider content to send back as an `assistant_turn` message. */
  raw: unknown;
  stopReason: AiStopReason;
  model: string;
  usage: AiUsage;
}

export interface AiProvider {
  readonly name: string;
  readonly model: string | null;
  readonly configured: boolean;
  /**
   * Whether `converse()` can search the web itself (Anthropic: yes). A provider without it
   * (Qwen3 hosts) sets false; the engine then skips web search and says so. Unset = true.
   */
  readonly supportsWebSearch?: boolean;
  generateJson(req: AiJsonRequest): Promise<AiJsonResult>;
  /** One model call that may request tools; the caller runs the loop. */
  converse(req: AiConverseRequest): Promise<AiConverseResult>;
}


const unavailable = (message: string) => new AppError('ai_unavailable', 502, message);

/** The provider refused the web search tool (switched off for the API account). */
export class WebSearchUnavailableError extends AppError {
  constructor() {
    super('ai_unavailable', 502, 'Web search is not available for this API account.');
  }
}

/** The basic web search tool: direct calls, eligible for zero data retention. */
export const WEB_SEARCH_TOOL_TYPE = 'web_search_20250305';

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  citations?: { type?: string; url?: string; title?: string; cited_text?: string }[];
}

interface AnthropicResponse {
  content?: AnthropicBlock[];
  stop_reason?: string;
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    server_tool_use?: { web_search_requests?: number };
  };
  error?: { type?: string; message?: string };
  request_id?: string;
}

const usageOf = (b: AnthropicResponse | null): AiUsage => ({
  inputTokens: b?.usage?.input_tokens ?? 0,
  outputTokens: b?.usage?.output_tokens ?? 0,
  webSearchRequests: b?.usage?.server_tool_use?.web_search_requests ?? 0,
});

export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  readonly configured = true;
  private readonly logger = new Logger('AnthropicProvider');

  constructor(
    private readonly env: Pick<
      Env,
      'ANTHROPIC_API_KEY' | 'ANTHROPIC_MODEL' | 'ANTHROPIC_API_URL' | 'ANTHROPIC_TIMEOUT_MS'
    >,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get model() {
    return this.env.ANTHROPIC_MODEL;
  }

  /** POST /v1/messages; maps transport and HTTP errors to ai_unavailable (never logs content). */
  private async post(payload: Record<string, unknown>): Promise<AnthropicResponse> {
    let res: Response;
    try {
      res = await this.fetchImpl(new URL('/v1/messages', this.env.ANTHROPIC_API_URL), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.env.ANTHROPIC_API_KEY!,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model: this.env.ANTHROPIC_MODEL, ...payload }),
        signal: AbortSignal.timeout(this.env.ANTHROPIC_TIMEOUT_MS),
      });
    } catch (e) {
      this.logger.warn(`Request failed: ${(e as Error).name}`);
      throw unavailable('The assistant could not be reached. Try again in a moment.');
    }
    const body = (await res.json().catch(() => null)) as AnthropicResponse | null;
    if (!res.ok) {
      // Never log the key or the prompt; the status, error type and request id are enough.
      this.logger.warn(
        `Anthropic API ${res.status} ${body?.error?.type ?? ''} ${body?.request_id ?? res.headers.get('request-id') ?? ''}`.trim(),
      );
      if (res.status === 401 || res.status === 403)
        throw unavailable(
          'The assistant is misconfigured (API key rejected). Ask the Owner to check ANTHROPIC_API_KEY.',
        );
      if (res.status === 429 || res.status === 529)
        throw unavailable('The assistant is busy. Try again in a moment.');
      if (
        res.status === 400 &&
        Array.isArray(payload.tools) &&
        (payload.tools as { type?: string }[]).some((t) => t.type === WEB_SEARCH_TOOL_TYPE) &&
        /web.?search/i.test(body?.error?.message ?? '')
      )
        throw new WebSearchUnavailableError();
      throw unavailable('The assistant returned an error.');
    }
    return body ?? {};
  }

  async generateJson(req: AiJsonRequest): Promise<AiJsonResult> {
    const body = await this.post({
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: 'user', content: req.prompt }],
      output_config: { format: { type: 'json_schema', schema: req.schema } },
    });
    if (body.stop_reason === 'refusal')
      throw unavailable('The assistant declined this request. Rephrase what the clause should do.');
    if (body.stop_reason === 'max_tokens')
      throw unavailable('The assistant ran out of space. Try a narrower request.');
    const text = body.content?.find((b) => b.type === 'text')?.text;
    if (!text) throw unavailable('The assistant returned no proposal.');
    try {
      return {
        data: JSON.parse(text),
        model: body.model ?? this.env.ANTHROPIC_MODEL,
        usage: usageOf(body),
      };
    } catch {
      throw unavailable('The assistant returned an unreadable proposal.');
    }
  }

  async converse(req: AiConverseRequest): Promise<AiConverseResult> {
    const messages = req.messages.map((m) => {
      switch (m.role) {
        case 'user':
        case 'assistant':
          return { role: m.role, content: m.text };
        case 'assistant_turn':
          return { role: 'assistant', content: m.raw };
        case 'tool_results':
          // Only tool_result blocks: anything else would end the assistant's turn.
          return {
            role: 'user',
            content: m.results.map((r) => ({
              type: 'tool_result',
              tool_use_id: r.toolUseId,
              content: r.content,
              ...(r.isError ? { is_error: true } : {}),
            })),
          };
      }
    });
    const tools: Record<string, unknown>[] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
    if (req.webSearch)
      tools.push({
        type: WEB_SEARCH_TOOL_TYPE,
        name: 'web_search',
        max_uses: req.webSearch.maxUses,
      });
    const body = await this.post({
      max_tokens: req.maxTokens,
      system: req.system,
      messages,
      ...(tools.length ? { tools } : {}),
    });
    const blocks: AiOutputBlock[] = [];
    for (const b of body.content ?? []) {
      if (b.type === 'text' && typeof b.text === 'string') {
        blocks.push({
          type: 'text',
          text: b.text,
          citations: (b.citations ?? [])
            .filter((c) => c.type === 'web_search_result_location' && typeof c.url === 'string')
            .map((c) => ({ url: c.url!, title: c.title ?? null, citedText: c.cited_text ?? null })),
        });
      } else if (b.type === 'tool_use' && b.id && b.name) {
        blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} });
      } else if (b.type === 'server_tool_use' && b.id && b.name === 'web_search') {
        const q = b.input?.query;
        blocks.push({ type: 'web_search', id: b.id, query: typeof q === 'string' ? q : '' });
      } else if (b.type === 'web_search_tool_result' && b.tool_use_id) {
        const c = b.content;
        if (Array.isArray(c)) {
          blocks.push({
            type: 'web_search_result',
            toolUseId: b.tool_use_id,
            results: (c as { type?: string; url?: string; title?: string; page_age?: string }[])
              .filter((r) => r.type === 'web_search_result' && typeof r.url === 'string')
              .map((r) => ({ url: r.url!, title: r.title ?? r.url!, pageAge: r.page_age ?? null })),
            errorCode: null,
          });
        } else {
          blocks.push({
            type: 'web_search_result',
            toolUseId: b.tool_use_id,
            results: [],
            errorCode: (c as { error_code?: string } | null)?.error_code ?? 'unavailable',
          });
        }
      }
    }
    const stop = body.stop_reason;
    return {
      blocks,
      raw: body.content ?? [],
      stopReason:
        stop === 'end_turn' ||
        stop === 'tool_use' ||
        stop === 'pause_turn' ||
        stop === 'max_tokens' ||
        stop === 'refusal'
          ? stop
          : 'other',
      model: body.model ?? this.env.ANTHROPIC_MODEL,
      usage: usageOf(body),
    };
  }
}

const KEY_VAR = { anthropic: 'ANTHROPIC_API_KEY', qwen: 'QWEN_API_KEY' } as const;

/** Used when no API key is set: the assistant says it is not configured; nothing else changes. */
export class UnconfiguredProvider implements AiProvider {
  readonly name = 'none';
  readonly model = null;
  readonly configured = false;
  constructor(private readonly slot: keyof typeof KEY_VAR = 'anthropic') {}
  private error() {
    return new AppError(
      'ai_not_configured',
      503,
      `The AI assistant is not configured (${KEY_VAR[this.slot]} is not set).`,
    );
  }
  generateJson(): Promise<AiJsonResult> {
    return Promise.reject(this.error());
  }
  converse(): Promise<AiConverseResult> {
    return Promise.reject(this.error());
  }
}

/** The Anthropic slot (kept for Phase 3–5 callers and tests). */
export function aiProviderFromEnv(env: Env): AiProvider {
  return env.ANTHROPIC_API_KEY ? new AnthropicProvider(env) : new UnconfiguredProvider('anthropic');
}
