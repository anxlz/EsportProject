import { Logger } from '@nestjs/common';
import { AppError } from '../common/errors.js';
import type { Env } from '../config/env.js';
import type {
  AiConverseRequest,
  AiConverseResult,
  AiJsonRequest,
  AiJsonResult,
  AiOutputBlock,
  AiProvider,
  AiStopReason,
  AiUsage,
} from './ai.provider.js';
import { cleanModelText, UNPARSEABLE_ARGUMENTS } from './qwen.provider.js';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAiToolCall[];
}

export interface LlmChatRequest {
  messages: LlmMessage[];
  maxTokens?: number;
  temperature?: number;
  tools?: { name: string; description: string; inputSchema: Record<string, unknown> }[];
  responseFormat?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface LlmStreamChunk {
  text?: string;
  toolCalls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
  finishReason?: string | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
}

export interface LlmChatResponse {
  content: string;
  toolCalls: OpenAiToolCall[];
  finishReason: string | null;
  model: string;
  usage: { prompt_tokens: number; completion_tokens: number };
}

export interface LlmHealth {
  ok: boolean;
  model: string;
  latencyMs: number;
  reason?: 'unreachable' | 'unauthorized' | 'server_error';
}

export type FetchImpl = (input: Request | URL | string, init?: RequestInit) => Promise<Response>;

export interface LlmProvider {
  chat(request: LlmChatRequest): Promise<LlmChatResponse>;
  stream(request: LlmChatRequest): AsyncIterable<LlmStreamChunk>;
  health(): Promise<LlmHealth>;
}

interface OpenAiToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAiChunk {
  model?: string;
  choices?: {
    delta?: { content?: string | null; tool_calls?: LlmStreamChunk['toolCalls'] };
    finish_reason?: string | null;
  }[];
  usage?: LlmStreamChunk['usage'];
}

const localUnavailable = () =>
  new AppError(
    'ai_local_unavailable',
    503,
    'The local AI model server could not be reached. Check the server URL and that the model is running.',
  );
const unavailable = (message: string) => new AppError('ai_unavailable', 502, message);

function sseData(block: string): string | null {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart());
  return data.length ? data.join('\n') : null;
}

export class LocalLlmProvider implements AiProvider, LlmProvider {
  readonly name = 'local';
  readonly configured = true;
  readonly supportsWebSearch = false;
  private readonly logger = new Logger('LocalLlmProvider');

  constructor(
    private readonly env: Pick<
      Env,
      | 'LLM_BASE_URL'
      | 'LLM_MODEL'
      | 'LLM_API_KEY'
      | 'LLM_TIMEOUT_MS'
      | 'LLM_MAX_TOKENS'
      | 'LLM_TEMPERATURE'
    >,
    private readonly fetchImpl: FetchImpl = fetch,
  ) {}

  get model() {
    return this.env.LLM_MODEL;
  }

  private endpoint(path: string) {
    return new URL(path, `${this.env.LLM_BASE_URL.replace(/\/+$/, '')}/`);
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.env.LLM_API_KEY ? { authorization: `Bearer ${this.env.LLM_API_KEY}` } : {}),
    };
  }

  async health(): Promise<LlmHealth> {
    const started = Date.now();
    try {
      const res = await this.fetchImpl(this.endpoint('models'), {
        headers: this.headers(),
        signal: AbortSignal.timeout(this.env.LLM_TIMEOUT_MS),
      });
      return {
        ok: res.ok,
        model: this.env.LLM_MODEL,
        latencyMs: Date.now() - started,
        ...(res.ok
          ? {}
          : { reason: res.status === 401 || res.status === 403 ? 'unauthorized' : 'server_error' }),
      };
    } catch {
      return {
        ok: false,
        model: this.env.LLM_MODEL,
        latencyMs: Date.now() - started,
        reason: 'unreachable',
      };
    }
  }

  async *stream(request: LlmChatRequest): AsyncIterable<LlmStreamChunk> {
    const started = Date.now();
    const timeout = AbortSignal.timeout(this.env.LLM_TIMEOUT_MS);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    let inputTokens = 0;
    let outputTokens = 0;
    let cancelReader: (() => Promise<void>) | undefined;
    let releaseReader: (() => void) | undefined;

    try {
      let res: Response;
      try {
        res = await this.fetchImpl(this.endpoint('chat/completions'), {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({
            model: this.env.LLM_MODEL,
            messages: request.messages,
            max_tokens: request.maxTokens ?? this.env.LLM_MAX_TOKENS,
            temperature: request.temperature ?? this.env.LLM_TEMPERATURE,
            stream: true,
            stream_options: { include_usage: true },
            ...(request.tools?.length
              ? {
                  tools: request.tools.map((tool) => ({
                    type: 'function',
                    function: {
                      name: tool.name,
                      description: tool.description,
                      parameters: tool.inputSchema,
                    },
                  })),
                  tool_choice: 'auto',
                }
              : {}),
            ...(request.responseFormat ? { response_format: request.responseFormat } : {}),
          }),
          signal,
        });
      } catch (error) {
        if (request.signal?.aborted) throw error;
        this.logger.warn(`Request failed: ${(error as Error).name}`);
        throw localUnavailable();
      }

      if (!res.ok) {
        this.logger.warn(`Local model API ${res.status}`);
        if (res.status === 401 || res.status === 403)
          throw unavailable('The local model server rejected its API key. Check LLM_API_KEY.');
        if (res.status === 429 || res.status >= 500)
          throw unavailable('The local model server is busy or unavailable. Try again shortly.');
        throw unavailable(
          'The local model server rejected the request. Check its model and settings.',
        );
      }
      if (!res.body) throw unavailable('The local model server returned an empty response.');

      const reader = res.body.getReader();
      cancelReader = () => reader.cancel();
      releaseReader = () => reader.releaseLock();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;
      while (!finished) {
        let next: Awaited<ReturnType<typeof reader.read>>;
        try {
          next = await reader.read();
        } catch (error) {
          if (request.signal?.aborted) throw error;
          if (timeout.aborted) {
            this.logger.warn(`Request timed out after ${Date.now() - started}ms`);
            throw localUnavailable();
          }
          throw localUnavailable();
        }
        buffer += decoder.decode(next.value, { stream: !next.done }).replace(/\r\n/g, '\n');
        let separator = buffer.indexOf('\n\n');
        while (separator !== -1) {
          const block = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          const data = sseData(block);
          if (data === '[DONE]') {
            finished = true;
            break;
          }
          if (data) {
            let chunk: OpenAiChunk;
            try {
              chunk = JSON.parse(data) as OpenAiChunk;
            } catch {
              throw unavailable('The local model server returned malformed streaming data.');
            }
            inputTokens = chunk.usage?.prompt_tokens ?? inputTokens;
            outputTokens = chunk.usage?.completion_tokens ?? outputTokens;
            const choice = chunk.choices?.[0];
            yield {
              ...(choice?.delta?.content ? { text: choice.delta.content } : {}),
              ...(choice?.delta?.tool_calls?.length ? { toolCalls: choice.delta.tool_calls } : {}),
              ...(choice?.finish_reason !== undefined
                ? { finishReason: choice.finish_reason }
                : {}),
              ...(chunk.usage ? { usage: chunk.usage } : {}),
              ...(chunk.model ? { model: chunk.model } : {}),
            };
          }
          separator = buffer.indexOf('\n\n');
        }
        if (next.done) {
          const data = sseData(buffer);
          if (data && data !== '[DONE]') {
            try {
              const chunk = JSON.parse(data) as OpenAiChunk;
              inputTokens = chunk.usage?.prompt_tokens ?? inputTokens;
              outputTokens = chunk.usage?.completion_tokens ?? outputTokens;
              const choice = chunk.choices?.[0];
              yield {
                ...(choice?.delta?.content ? { text: choice.delta.content } : {}),
                ...(choice?.delta?.tool_calls?.length
                  ? { toolCalls: choice.delta.tool_calls }
                  : {}),
                ...(choice?.finish_reason !== undefined
                  ? { finishReason: choice.finish_reason }
                  : {}),
                ...(chunk.usage ? { usage: chunk.usage } : {}),
                ...(chunk.model ? { model: chunk.model } : {}),
              };
            } catch {
              throw unavailable('The local model server returned malformed streaming data.');
            }
          }
          break;
        }
      }
    } finally {
      await cancelReader?.().catch(() => undefined);
      releaseReader?.();
      this.logger.log(
        `Completed in ${Date.now() - started}ms; input tokens ${inputTokens}; output tokens ${outputTokens}`,
      );
    }
  }

  async chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    let content = '';
    let model = this.env.LLM_MODEL;
    let finishReason: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    const calls = new Map<number, OpenAiToolCall>();
    for await (const chunk of this.stream(request)) {
      content += chunk.text ?? '';
      model = chunk.model ?? model;
      finishReason = chunk.finishReason ?? finishReason;
      inputTokens = chunk.usage?.prompt_tokens ?? inputTokens;
      outputTokens = chunk.usage?.completion_tokens ?? outputTokens;
      for (const delta of chunk.toolCalls ?? []) {
        const index = delta.index ?? calls.size;
        const current = calls.get(index) ?? { type: 'function', function: { arguments: '' } };
        if (delta.id) current.id = delta.id;
        if (delta.function?.name)
          current.function!.name = (current.function!.name ?? '') + delta.function.name;
        if (delta.function?.arguments)
          current.function!.arguments =
            (current.function!.arguments ?? '') + delta.function.arguments;
        calls.set(index, current);
      }
    }
    return {
      content,
      toolCalls: [...calls.values()],
      finishReason,
      model,
      usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens },
    };
  }

  async generateJson(req: AiJsonRequest): Promise<AiJsonResult> {
    const result = await this.chat({
      messages: [
        {
          role: 'system',
          content: `${req.system}\n\nReturn only a JSON object matching this schema:\n${JSON.stringify(req.schema)}`,
        },
        { role: 'user', content: req.prompt },
      ],
      maxTokens: Math.min(req.maxTokens, this.env.LLM_MAX_TOKENS),
      responseFormat: { type: 'json_object' },
    });
    if (result.finishReason === 'length')
      throw unavailable('The assistant ran out of space. Try a narrower request.');
    if (!result.content) throw unavailable('The assistant returned no proposal.');
    try {
      return {
        data: JSON.parse(cleanModelText(result.content)),
        model: result.model,
        usage: {
          inputTokens: result.usage.prompt_tokens,
          outputTokens: result.usage.completion_tokens,
          webSearchRequests: 0,
        },
      };
    } catch {
      throw unavailable('The assistant returned an unreadable proposal.');
    }
  }

  async converse(req: AiConverseRequest): Promise<AiConverseResult> {
    const withTools = req.tools.length > 0;
    const messages: LlmMessage[] = [];
    if (!withTools) messages.push({ role: 'system', content: req.system });
    let systemPending = withTools;
    for (const message of req.messages) {
      switch (message.role) {
        case 'user':
          messages.push({
            role: 'user',
            content: systemPending
              ? `<instructions>\n${req.system}\n</instructions>\n\n${message.text}`
              : message.text,
          });
          systemPending = false;
          break;
        case 'assistant':
          messages.push({ role: 'assistant', content: message.text });
          break;
        case 'assistant_turn':
          messages.push(message.raw as LlmMessage);
          break;
        case 'tool_results':
          for (const result of message.results)
            messages.push({
              role: 'tool',
              tool_call_id: result.toolUseId,
              content: result.isError ? JSON.stringify({ error: true }) : result.content,
            });
          break;
      }
    }
    if (systemPending)
      messages.unshift({
        role: 'user',
        content: `<instructions>\n${req.system}\n</instructions>`,
      });

    const response = await this.chat({
      messages,
      maxTokens: Math.min(req.maxTokens, this.env.LLM_MAX_TOKENS),
      tools: req.tools,
    });
    const blocks: AiOutputBlock[] = [];
    const text = cleanModelText(response.content);
    if (text) blocks.push({ type: 'text', text, citations: [] });
    const seen = new Set<string>();
    const toolCalls = response.toolCalls
      .filter((call) => call.function?.name)
      .map((call, index) => {
        const id = call.id && !seen.has(call.id) ? call.id : `local_call_${index}`;
        seen.add(id);
        return { ...call, id, type: 'function' };
      });
    for (const call of toolCalls) {
      let input: Record<string, unknown>;
      try {
        const parsed = JSON.parse(call.function!.arguments || '{}') as unknown;
        input =
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : { [UNPARSEABLE_ARGUMENTS]: true };
      } catch {
        input = { [UNPARSEABLE_ARGUMENTS]: true };
      }
      blocks.push({ type: 'tool_use', id: call.id, name: call.function!.name!, input });
    }
    const stopReason: AiStopReason =
      toolCalls.length || response.finishReason === 'tool_calls'
        ? 'tool_use'
        : response.finishReason === 'stop'
          ? 'end_turn'
          : response.finishReason === 'length'
            ? 'max_tokens'
            : response.finishReason === 'content_filter'
              ? 'refusal'
              : 'other';
    const usage: AiUsage = {
      inputTokens: response.usage.prompt_tokens,
      outputTokens: response.usage.completion_tokens,
      webSearchRequests: 0,
    };
    return {
      blocks,
      raw: {
        role: 'assistant',
        content: response.content || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      stopReason,
      model: response.model,
      usage,
    };
  }
}
