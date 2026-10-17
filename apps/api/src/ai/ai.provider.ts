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

export interface AiJsonResult {
  data: unknown;
  model: string;
}

export interface AiProvider {
  readonly name: string;
  readonly model: string | null;
  readonly configured: boolean;
  generateJson(req: AiJsonRequest): Promise<AiJsonResult>;
}

export const AI_PROVIDER = Symbol('AI_PROVIDER');

const unavailable = (message: string) => new AppError('ai_unavailable', 502, message);

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

  async generateJson(req: AiJsonRequest): Promise<AiJsonResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(new URL('/v1/messages', this.env.ANTHROPIC_API_URL), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.env.ANTHROPIC_API_KEY!,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.env.ANTHROPIC_MODEL,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: [{ role: 'user', content: req.prompt }],
          output_config: { format: { type: 'json_schema', schema: req.schema } },
        }),
        signal: AbortSignal.timeout(this.env.ANTHROPIC_TIMEOUT_MS),
      });
    } catch (e) {
      this.logger.warn(`Request failed: ${(e as Error).name}`);
      throw unavailable('The assistant could not be reached. Try again in a moment.');
    }
    const body = (await res.json().catch(() => null)) as {
      content?: { type: string; text?: string }[];
      stop_reason?: string;
      model?: string;
      error?: { type?: string };
      request_id?: string;
    } | null;
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
      throw unavailable('The assistant returned an error.');
    }
    if (body?.stop_reason === 'refusal')
      throw unavailable('The assistant declined this request. Rephrase what the clause should do.');
    if (body?.stop_reason === 'max_tokens')
      throw unavailable('The assistant ran out of space. Try a narrower request.');
    const text = body?.content?.find((b) => b.type === 'text')?.text;
    if (!text) throw unavailable('The assistant returned no proposal.');
    try {
      return { data: JSON.parse(text), model: body?.model ?? this.env.ANTHROPIC_MODEL };
    } catch {
      throw unavailable('The assistant returned an unreadable proposal.');
    }
  }
}

/** Used when no API key is set: the assistant says it is not configured; nothing else changes. */
export class UnconfiguredProvider implements AiProvider {
  readonly name = 'none';
  readonly model = null;
  readonly configured = false;
  generateJson(): Promise<AiJsonResult> {
    return Promise.reject(
      new AppError(
        'ai_not_configured',
        503,
        'The AI assistant is not configured (ANTHROPIC_API_KEY is not set).',
      ),
    );
  }
}

export function aiProviderFromEnv(env: Env): AiProvider {
  return env.ANTHROPIC_API_KEY ? new AnthropicProvider(env) : new UnconfiguredProvider();
}
