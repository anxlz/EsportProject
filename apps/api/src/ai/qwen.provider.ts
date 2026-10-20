/**
 * Second AI provider (Phase 6): Qwen3, open weights under Apache 2.0, through a hosted
 * OpenAI-compatible inference API. Default host: DeepInfra (chosen on 20 Oct 2026, see
 * DECISIONS.md "Qwen3 provider"); any OpenAI-compatible host serving Qwen3 works by changing
 * QWEN_API_URL and QWEN_MODEL.
 *
 * Checked against DeepInfra's documentation (read 20 Oct 2026):
 * - https://docs.deepinfra.com/chat/overview — POST {base}/chat/completions; most models cap
 *   output at 16,384 tokens; "may not be 100% compatible with all OpenAI parameters".
 * - https://docs.deepinfra.com/chat/tool-calling — `tools` of type "function"; `tool_choice`
 *   "auto" or "none" only (no forced tool use); parallel calls supported ("quality may vary");
 *   `arguments` is a JSON-encoded STRING; results go back as role "tool" with `tool_call_id`;
 *   "avoid system messages when using tool calling".
 * - https://docs.deepinfra.com/chat/structured-outputs — `response_format`
 *   {type: "json_schema", json_schema: {name, strict: true, schema}}; validate the output, since
 *   a response cut off by max_tokens may be incomplete.
 * - Model page Qwen/Qwen3-235B-A22B-Instruct-2507: tagged JSON + Function, zero retention,
 *   262K context, non-thinking (no <think> blocks), Apache-2.0 on Hugging Face.
 *
 * Differences from the Anthropic adapter, handled here so the assistant engine stays the same:
 * - no server-side web search (`supportsWebSearch = false`): the engine then skips web search
 *   and flags it, rather than this adapter pretending;
 * - with tools, the system text is sent at the top of the first user turn (DeepInfra's advice);
 * - tool arguments that aren't valid JSON are passed on as an explicit marker, and the engine
 *   refuses to run them (never as an empty lookup);
 * - finish reasons map: stop → end_turn, tool_calls → tool_use, length → max_tokens,
 *   content_filter → refusal;
 * - any <think>…</think> block (thinking-capable Qwen3 models) and Markdown fences around JSON
 *   are stripped before parsing.
 *
 * Providers only produce text; all guardrails (proposal-only, permissions, citations,
 * anti-fabrication, tool-call log) are enforced by the engine, the same for every provider.
 */
import { Logger } from '@nestjs/common';
import { AppError } from '../common/errors';
import type { Env } from '../config/env';
import type {
  AiConverseRequest,
  AiConverseResult,
  AiJsonRequest,
  AiJsonResult,
  AiOutputBlock,
  AiProvider,
  AiStopReason,
  AiUsage,
} from './ai.provider';

/** Marker key on a tool call whose arguments couldn't be read (the engine won't run it). */
export const UNPARSEABLE_ARGUMENTS = '__unparseable_arguments';

/** DeepInfra's hard cap for most models. */
const MAX_OUTPUT_TOKENS = 16_384;

interface OpenAiToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAiMessage {
  role: string;
  content: string | null;
  tool_calls?: OpenAiToolCall[];
}

interface OpenAiResponse {
  model?: string;
  choices?: { message?: OpenAiMessage; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string } | string;
}

const unavailable = (message: string) => new AppError('ai_unavailable', 502, message);

/** Removes a leading thinking block and Markdown code fences. */
export function cleanModelText(s: string): string {
  let t = s.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(t);
  if (fence) t = fence[1]!.trim();
  return t;
}

export class QwenProvider implements AiProvider {
  readonly name = 'qwen';
  readonly configured = true;
  readonly supportsWebSearch = false;
  private readonly logger = new Logger('QwenProvider');

  constructor(
    private readonly env: Pick<
      Env,
      'QWEN_API_KEY' | 'QWEN_MODEL' | 'QWEN_API_URL' | 'QWEN_TIMEOUT_MS'
    >,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get model() {
    return this.env.QWEN_MODEL;
  }

  private async post(payload: Record<string, unknown>): Promise<OpenAiResponse> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.env.QWEN_API_URL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.env.QWEN_API_KEY!}`,
        },
        body: JSON.stringify({ model: this.env.QWEN_MODEL, ...payload }),
        signal: AbortSignal.timeout(this.env.QWEN_TIMEOUT_MS),
      });
    } catch (e) {
      this.logger.warn(`Request failed: ${(e as Error).name}`);
      throw unavailable('The assistant could not be reached. Try again in a moment.');
    }
    const body = (await res.json().catch(() => null)) as OpenAiResponse | null;
    if (!res.ok) {
      // Never log the key or the prompt.
      const type = typeof body?.error === 'object' ? (body.error?.type ?? '') : '';
      this.logger.warn(`Qwen API ${res.status} ${type}`.trim());
      if (res.status === 401 || res.status === 403)
        throw unavailable(
          'The assistant is misconfigured (API key rejected). Ask the Owner to check QWEN_API_KEY.',
        );
      if (res.status === 429 || res.status === 503 || res.status === 529)
        throw unavailable('The assistant is busy. Try again in a moment.');
      throw unavailable('The assistant returned an error.');
    }
    return body ?? {};
  }

  private usage(b: OpenAiResponse): AiUsage {
    return {
      inputTokens: b.usage?.prompt_tokens ?? 0,
      outputTokens: b.usage?.completion_tokens ?? 0,
      webSearchRequests: 0,
    };
  }

  async generateJson(req: AiJsonRequest): Promise<AiJsonResult> {
    const body = await this.post({
      max_tokens: Math.min(req.maxTokens, MAX_OUTPUT_TOKENS),
      // DeepInfra: below 0.7 for consistent structure.
      temperature: 0.6,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.prompt },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'answer', strict: true, schema: req.schema },
      },
    });
    const choice = body.choices?.[0];
    if (choice?.finish_reason === 'content_filter')
      throw unavailable('The assistant declined this request. Rephrase it.');
    if (choice?.finish_reason === 'length')
      throw unavailable('The assistant ran out of space. Try a narrower request.');
    const text = choice?.message?.content;
    if (!text) throw unavailable('The assistant returned no proposal.');
    try {
      return {
        data: JSON.parse(cleanModelText(text)),
        model: body.model ?? this.env.QWEN_MODEL,
        usage: this.usage(body),
      };
    } catch {
      throw unavailable('The assistant returned an unreadable proposal.');
    }
  }

  async converse(req: AiConverseRequest): Promise<AiConverseResult> {
    const withTools = req.tools.length > 0;
    const messages: unknown[] = [];
    if (!withTools) messages.push({ role: 'system', content: req.system });
    let systemPending = withTools;
    for (const m of req.messages) {
      switch (m.role) {
        case 'user': {
          const content = systemPending
            ? `<instructions>\n${req.system}\n</instructions>\n\n${m.text}`
            : m.text;
          systemPending = false;
          messages.push({ role: 'user', content });
          break;
        }
        case 'assistant':
          messages.push({ role: 'assistant', content: m.text });
          break;
        case 'assistant_turn':
          messages.push(m.raw);
          break;
        case 'tool_results':
          for (const r of m.results)
            messages.push({
              role: 'tool',
              tool_call_id: r.toolUseId,
              content: r.isError
                ? JSON.stringify({ error: true, result: safeJson(r.content) })
                : r.content,
            });
          break;
      }
    }
    if (systemPending)
      messages.unshift({ role: 'user', content: `<instructions>\n${req.system}\n</instructions>` });
    // req.webSearch is ignored: this provider has no server-side search (supportsWebSearch).
    const body = await this.post({
      max_tokens: Math.min(req.maxTokens, MAX_OUTPUT_TOKENS),
      temperature: 0.7,
      messages,
      ...(withTools
        ? {
            tools: req.tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
            tool_choice: 'auto',
          }
        : {}),
    });
    const choice = body.choices?.[0];
    const msg: OpenAiMessage = choice?.message ?? { role: 'assistant', content: null };
    const blocks: AiOutputBlock[] = [];
    const text = typeof msg.content === 'string' ? cleanModelText(msg.content) : '';
    if (text) blocks.push({ type: 'text', text, citations: [] });
    // Ids are needed to pair results with calls; some hosts omit them (or repeat them).
    const seen = new Set<string>();
    const toolCalls = (msg.tool_calls ?? [])
      .filter((tc) => tc.function?.name)
      .map((tc, i) => {
        const id = tc.id && !seen.has(tc.id) ? tc.id : `qwen_call_${i}`;
        seen.add(id);
        return { ...tc, id, type: 'function' };
      });
    for (const tc of toolCalls) {
      let input: Record<string, unknown>;
      try {
        const parsed = JSON.parse(tc.function!.arguments || '{}') as unknown;
        input =
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : { [UNPARSEABLE_ARGUMENTS]: true };
      } catch {
        input = { [UNPARSEABLE_ARGUMENTS]: true };
      }
      blocks.push({ type: 'tool_use', id: tc.id, name: tc.function!.name!, input });
    }
    const fr = choice?.finish_reason;
    const stopReason: AiStopReason =
      toolCalls.length || fr === 'tool_calls'
        ? 'tool_use'
        : fr === 'stop'
          ? 'end_turn'
          : fr === 'length'
            ? 'max_tokens'
            : fr === 'content_filter'
              ? 'refusal'
              : 'other';
    return {
      blocks,
      raw: {
        role: 'assistant',
        content: msg.content ?? null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      stopReason,
      model: body.model ?? this.env.QWEN_MODEL,
      usage: this.usage(body),
    };
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
