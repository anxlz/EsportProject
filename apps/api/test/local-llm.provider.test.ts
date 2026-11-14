import { describe, expect, test } from 'bun:test';
import { AnthropicProvider } from '../src/ai/ai.provider';
import { aiProvidersFromEnv, AiRouter } from '../src/ai/ai.router';
import { LocalLlmProvider, type FetchImpl } from '../src/ai/local-llm.provider';
import { QwenProvider } from '../src/ai/qwen.provider';
import { loadEnv } from '../src/config/env';

const env = loadEnv({
  DATABASE_URL: 'postgres://localhost/test',
  REDIS_URL: 'redis://localhost',
  WEB_APP_URL: 'http://localhost:3000',
  SESSION_SECRET: 'test-secret-with-more-than-thirty-two-characters',
  LLM_BASE_URL: 'http://localhost:11434/v1',
  LLM_MODEL: 'test-model',
});

function provider(fetchImpl: FetchImpl) {
  return new LocalLlmProvider(env, fetchImpl);
}

function sseResponse(...events: string[]) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(event));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

describe('LocalLlmProvider', () => {
  test('validates local model limits', () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: 'postgres://localhost/test',
        REDIS_URL: 'redis://localhost',
        WEB_APP_URL: 'http://localhost:3000',
        SESSION_SECRET: 'test-secret-with-more-than-thirty-two-characters',
        LLM_TIMEOUT_MS: '499',
      }),
    ).toThrow(/LLM_TIMEOUT_MS/);
    expect(() =>
      loadEnv({
        DATABASE_URL: 'postgres://localhost/test',
        REDIS_URL: 'redis://localhost',
        WEB_APP_URL: 'http://localhost:3000',
        SESSION_SECRET: 'test-secret-with-more-than-thirty-two-characters',
        LLM_TEMPERATURE: '2.1',
      }),
    ).toThrow(/LLM_TEMPERATURE/);
  });

  test('selects local by default without Anthropic credentials and preserves explicit routing', () => {
    const localEnv = loadEnv({
      DATABASE_URL: 'postgres://localhost/test',
      REDIS_URL: 'redis://localhost',
      WEB_APP_URL: 'http://localhost:3000',
      SESSION_SECRET: 'test-secret-with-more-than-thirty-two-characters',
    });
    const localRouter = new AiRouter(localEnv, aiProvidersFromEnv(localEnv));
    expect(localRouter.for('general')).toBeInstanceOf(LocalLlmProvider);

    const legacyEnv = loadEnv({
      DATABASE_URL: 'postgres://localhost/test',
      REDIS_URL: 'redis://localhost',
      WEB_APP_URL: 'http://localhost:3000',
      SESSION_SECRET: 'test-secret-with-more-than-thirty-two-characters',
      ANTHROPIC_API_KEY: 'test-key-not-real',
    });
    expect(new AiRouter(legacyEnv, aiProvidersFromEnv(legacyEnv)).for('general')).toBeInstanceOf(
      AnthropicProvider,
    );

    const explicitLocalEnv = loadEnv({
      DATABASE_URL: 'postgres://localhost/test',
      REDIS_URL: 'redis://localhost',
      WEB_APP_URL: 'http://localhost:3000',
      SESSION_SECRET: 'test-secret-with-more-than-thirty-two-characters',
      ANTHROPIC_API_KEY: 'test-key-not-real',
      LLM_PROVIDER: 'local',
    });
    expect(
      new AiRouter(explicitLocalEnv, aiProvidersFromEnv(explicitLocalEnv)).for('general'),
    ).toBeInstanceOf(LocalLlmProvider);

    const qwenEnv = loadEnv({
      DATABASE_URL: 'postgres://localhost/test',
      REDIS_URL: 'redis://localhost',
      WEB_APP_URL: 'http://localhost:3000',
      SESSION_SECRET: 'test-secret-with-more-than-thirty-two-characters',
      QWEN_API_KEY: 'test-key-not-real',
      AI_PROVIDER_DEFAULT: 'qwen',
    });
    expect(new AiRouter(qwenEnv, aiProvidersFromEnv(qwenEnv)).for('general')).toBeInstanceOf(
      QwenProvider,
    );
  });

  test('chat parses streamed completion and usage', async () => {
    const fetchImpl: FetchImpl = async () =>
      sseResponse(
        'data: {"model":"test-model","choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}\n\n',
        'data: {"usage":{"prompt_tokens":12,"completion_tokens":3},"choices":[]}\n\n',
        'data: [DONE]\n\n',
      );
    const result = await provider(fetchImpl).chat({
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(result).toMatchObject({
      content: 'Hello world',
      finishReason: 'stop',
      model: 'test-model',
      usage: { prompt_tokens: 12, completion_tokens: 3 },
    });
  });

  test('generates validated JSON through the same stream and usage pipeline', async () => {
    const fetchImpl: FetchImpl = async () =>
      sseResponse(
        'data: {"choices":[{"delta":{"content":"{\\"answer\\":\\"ready\\"}"}}]}\n\n',
        'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
        'data: {"usage":{"prompt_tokens":4,"completion_tokens":2},"choices":[]}\n\n',
        'data: [DONE]\n\n',
      );
    const result = await provider(fetchImpl).generateJson({
      system: 'Return an answer.',
      prompt: 'Check the service.',
      schema: { type: 'object', properties: { answer: { type: 'string' } } },
      maxTokens: 50,
    });
    expect(result).toMatchObject({
      data: { answer: 'ready' },
      model: 'test-model',
      usage: { inputTokens: 4, outputTokens: 2 },
    });
  });

  test('stream parses SSE events even when the network splits an event', async () => {
    const fetchImpl: FetchImpl = async () =>
      sseResponse(
        'data: {"choices":[{"delta":{"content":"first "}}]}\n',
        '\ndata: {"choices":[{"delta":{"content":"second"},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      );
    const parts: string[] = [];
    for await (const chunk of provider(fetchImpl).stream({
      messages: [{ role: 'user', content: 'hello' }],
    }))
      if (chunk.text) parts.push(chunk.text);
    expect(parts).toEqual(['first ', 'second']);
  });

  test('maps request timeout to a friendly local-server error', async () => {
    const fetchImpl: FetchImpl = async () => {
      throw new DOMException('Timed out', 'TimeoutError');
    };
    await expect(
      provider(fetchImpl).chat({ messages: [{ role: 'user', content: 'hello' }] }),
    ).rejects.toMatchObject({ code: 'ai_local_unavailable' });
  });

  test('maps a stopped model server without crashing the assistant request', async () => {
    const fetchImpl: FetchImpl = async () => {
      throw new TypeError('fetch failed');
    };
    await expect(
      provider(fetchImpl).chat({ messages: [{ role: 'user', content: 'hello' }] }),
    ).rejects.toMatchObject({
      code: 'ai_local_unavailable',
      message: expect.stringContaining('model server'),
    });
  });

  test('health reports reachability without throwing', async () => {
    const fetchImpl: FetchImpl = async () => new Response(null, { status: 200 });
    await expect(provider(fetchImpl).health()).resolves.toMatchObject({
      ok: true,
      model: 'test-model',
    });
  });
});
