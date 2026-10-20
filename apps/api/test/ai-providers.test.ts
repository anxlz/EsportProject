/**
 * Phase 6 — the second AI provider (Qwen3 through an OpenAI-compatible host) next to Anthropic.
 *
 * 1. Adapter unit tests: the Qwen adapter's requests and response parsing, checked against
 *    DeepInfra's documented shapes (read 20 Oct 2026) with a mocked fetch.
 * 2. Routing: default, per-feature overrides, no silent fallback.
 * 3. End to end: the five assistants through the REAL Anthropic and Qwen adapters, talking HTTP
 *    to a local stand-in that speaks both wire formats (standin-models.ts). Everything on the
 *    platform side is real; the "model" is mechanical. No call goes to Anthropic or DeepInfra.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { AssistantsOverviewDto, ConversationDto, ToolCallLogDto } from '@esports/shared';
import { eq, sql } from 'drizzle-orm';
import {
  AnthropicProvider,
  type AiConverseRequest,
  UnconfiguredProvider,
} from '../src/ai/ai.provider';
import { aiProvidersFromEnv, AiRouter } from '../src/ai/ai.router';
import { cleanModelText, QwenProvider, UNPARSEABLE_ARGUMENTS } from '../src/ai/qwen.provider';
import { AssistantEngine } from '../src/assistants/assistant-engine';
import { AppError } from '../src/common/errors';
import { loadEnv } from '../src/config/env';
import { aiMessages, aiToolCalls } from '../src/db/schema-assistants';
import { financeOrg, withRole } from './finance-fixtures';
import { type Client, startApp, type TestApp } from './harness';
import { StandInModels } from './standin-models';

const qenv = {
  QWEN_API_KEY: 'test-key-not-real',
  QWEN_MODEL: 'Qwen/Qwen3-235B-A22B-Instruct-2507',
  QWEN_API_URL: 'https://api.deepinfra.test/v1/openai',
  QWEN_TIMEOUT_MS: 30_000,
};

function mockFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  const impl = (async (url: URL | string, init: RequestInit) => {
    calls.push({ url: String(url), init, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const tools: AiConverseRequest['tools'] = [
  {
    name: 'list_teams',
    description: 'Teams the user can see.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_roster',
    description: 'A roster.',
    inputSchema: {
      type: 'object',
      properties: { teamId: { type: 'string' } },
      required: ['teamId'],
    },
  },
];

describe('Qwen adapter (OpenAI-compatible, DeepInfra) — request and response shapes', () => {
  test('generateJson: json_schema strict, system role, output capped at 16,384 tokens; fences and thinking blocks are stripped', async () => {
    const f = mockFetch(200, {
      model: 'Qwen/Qwen3-235B-A22B-Instruct-2507',
      choices: [
        {
          message: {
            role: 'assistant',
            content: '<think>plan</think>\n```json\n{"message":"مرحبا"}\n```',
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 9 },
    });
    const r = await new QwenProvider(qenv, f.impl).generateJson({
      system: 'SYS',
      prompt: 'P',
      schema: { type: 'object' },
      maxTokens: 20000,
    });
    expect(r).toEqual({
      data: { message: 'مرحبا' },
      model: 'Qwen/Qwen3-235B-A22B-Instruct-2507',
      usage: { inputTokens: 50, outputTokens: 9, webSearchRequests: 0 },
    });
    const sent = f.calls[0]!;
    expect(sent.url).toBe('https://api.deepinfra.test/v1/openai/chat/completions');
    expect((sent.init.headers as Record<string, string>).authorization).toBe(
      'Bearer test-key-not-real',
    );
    expect(sent.body).toEqual({
      model: 'Qwen/Qwen3-235B-A22B-Instruct-2507',
      max_tokens: 16384,
      temperature: 0.6,
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'P' },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'answer', strict: true, schema: { type: 'object' } },
      },
    });
  });

  test('generateJson: truncation, refusal, unreadable output and HTTP errors map to the same errors as Anthropic', async () => {
    const code = async (status: number, body: unknown) => {
      const e = await new QwenProvider(qenv, mockFetch(status, body).impl)
        .generateJson({ system: 's', prompt: 'p', schema: {}, maxTokens: 10 })
        .catch((x) => x);
      return [(e as AppError).code, (e as AppError).message];
    };
    expect(
      await code(200, { choices: [{ message: { content: '{"a"' }, finish_reason: 'length' }] }),
    ).toEqual(['ai_unavailable', 'The assistant ran out of space. Try a narrower request.']);
    expect(
      (
        await code(200, {
          choices: [{ message: { content: '' }, finish_reason: 'content_filter' }],
        })
      )[1],
    ).toContain('declined');
    expect(
      (
        await code(200, { choices: [{ message: { content: 'not json' }, finish_reason: 'stop' }] })
      )[1],
    ).toContain('unreadable');
    expect((await code(401, { error: { message: 'bad key' } }))[1]).toContain('QWEN_API_KEY');
    expect((await code(429, {}))[1]).toContain('busy');
    expect((await code(500, {}))[0]).toBe('ai_unavailable');
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(
      (
        (await new QwenProvider(qenv, failing)
          .generateJson({ system: 's', prompt: 'p', schema: {}, maxTokens: 1 })
          .catch((x) => x)) as AppError
      ).message,
    ).toContain('could not be reached');
  });

  test('converse: functions with tool_choice auto; system text folded into the first user turn (DeepInfra’s advice); no web search', async () => {
    const f = mockFetch(200, {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'get_roster', arguments: '{"teamId":"t-1"}' },
              },
              { type: 'function', function: { name: 'list_teams', arguments: '{oops' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    const r = await new QwenProvider(qenv, f.impl).converse({
      system: 'RULES',
      messages: [{ role: 'user', text: 'Who is on team 1?' }],
      tools,
      webSearch: { maxUses: 5 },
      maxTokens: 3000,
    });
    const sent = f.calls[0]!.body;
    expect(sent.messages).toEqual([
      { role: 'user', content: '<instructions>\nRULES\n</instructions>\n\nWho is on team 1?' },
    ]);
    expect(sent.tool_choice).toBe('auto');
    expect(sent.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'list_teams',
          description: 'Teams the user can see.',
          parameters: tools[0]!.inputSchema,
        },
      },
      {
        type: 'function',
        function: {
          name: 'get_roster',
          description: 'A roster.',
          parameters: tools[1]!.inputSchema,
        },
      },
    ]);
    expect(JSON.stringify(sent)).not.toContain('web_search');
    expect(r.stopReason).toBe('tool_use');
    expect(r.blocks).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'get_roster', input: { teamId: 't-1' } },
      // A missing id gets a unique one (results must pair with calls); bad arguments are marked.
      {
        type: 'tool_use',
        id: 'qwen_call_1',
        name: 'list_teams',
        input: { [UNPARSEABLE_ARGUMENTS]: true },
      },
    ]);
    expect((r.raw as { tool_calls: { id: string }[] }).tool_calls.map((t) => t.id)).toEqual([
      'call_1',
      'qwen_call_1',
    ]);
  });

  test('converse: the assistant turn goes back unchanged and tool results as role "tool"; finish reasons map', async () => {
    const f = mockFetch(200, {
      choices: [{ message: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }],
    });
    const raw = {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_9', type: 'function', function: { name: 'list_teams', arguments: '{}' } },
      ],
    };
    const r = await new QwenProvider(qenv, f.impl).converse({
      system: 'RULES',
      messages: [
        { role: 'user', text: 'Q' },
        { role: 'assistant_turn', raw },
        {
          role: 'tool_results',
          results: [
            { toolUseId: 'call_9', content: '{"teams":[]}', isError: false },
            { toolUseId: 'call_10', content: '{"error":"not_available"}', isError: true },
          ],
        },
      ],
      tools,
      webSearch: null,
      maxTokens: 100,
    });
    expect(f.calls[0]!.body.messages).toEqual([
      { role: 'user', content: '<instructions>\nRULES\n</instructions>\n\nQ' },
      raw,
      { role: 'tool', tool_call_id: 'call_9', content: '{"teams":[]}' },
      {
        role: 'tool',
        tool_call_id: 'call_10',
        content: '{"error":true,"result":{"error":"not_available"}}',
      },
    ]);
    expect(r).toMatchObject({
      stopReason: 'end_turn',
      blocks: [{ type: 'text', text: 'Done.', citations: [] }],
    });
    const plain = mockFetch(200, {
      choices: [{ message: { content: 'x' }, finish_reason: 'length' }],
    });
    expect(
      (
        await new QwenProvider(qenv, plain.impl).converse({
          system: 'S',
          messages: [{ role: 'user', text: 'Q' }],
          tools: [],
          webSearch: null,
          maxTokens: 9,
        })
      ).stopReason,
    ).toBe('max_tokens');
    expect(plain.calls[0]!.body.messages).toEqual([
      { role: 'system', content: 'S' },
      { role: 'user', content: 'Q' },
    ]);
    expect(plain.calls[0]!.body.tools).toBeUndefined();
    expect(cleanModelText('```\n{"a":1}\n```')).toBe('{"a":1}');
  });
});

describe('provider routing', () => {
  const BASE = {
    DATABASE_URL: 'postgres://x',
    REDIS_URL: 'redis://x',
    WEB_APP_URL: 'http://localhost:3000',
    SESSION_SECRET: 'x'.repeat(40),
  };
  test('Anthropic by default; overrides per feature; bad overrides refuse to start', () => {
    const env = loadEnv({
      ...BASE,
      ANTHROPIC_API_KEY: 'a',
      QWEN_API_KEY: 'q',
      AI_PROVIDER_OVERRIDES: 'player_analyst=qwen, email=qwen',
    });
    const router = new AiRouter(env, aiProvidersFromEnv(env));
    expect(router.for('general')).toBeInstanceOf(AnthropicProvider);
    expect(router.for('clause_assistant')).toBeInstanceOf(AnthropicProvider);
    expect(router.for('player_analyst')).toBeInstanceOf(QwenProvider);
    expect(router.describe('player_analyst')).toEqual({
      provider: 'qwen',
      configured: true,
      model: 'Qwen/Qwen3-235B-A22B-Instruct-2507',
      webSearch: false,
    });
    expect(router.describe('general')).toMatchObject({ provider: 'anthropic', webSearch: true });
    const all = new AiRouter(
      loadEnv({ ...BASE, QWEN_API_KEY: 'q', AI_PROVIDER_DEFAULT: 'qwen' }),
      aiProvidersFromEnv(loadEnv({ ...BASE, QWEN_API_KEY: 'q' })),
    );
    expect(all.for('formal_message')).toBeInstanceOf(QwenProvider);
    expect(() => loadEnv({ ...BASE, AI_PROVIDER_OVERRIDES: 'chef=qwen' })).toThrow(
      /unknown feature/,
    );
    expect(() => loadEnv({ ...BASE, AI_PROVIDER_OVERRIDES: 'email=gpt' })).toThrow(
      /unknown provider/,
    );
    expect(loadEnv(BASE).ASSISTANT_WEB_SEARCH).toBe('off'); // Phase 6 default
  });

  test('no silent fallback: a feature routed to an unconfigured provider is "not configured"', async () => {
    const env = loadEnv({ ...BASE, ANTHROPIC_API_KEY: 'a', AI_PROVIDER_OVERRIDES: 'email=qwen' });
    const router = new AiRouter(env, aiProvidersFromEnv(env));
    expect(router.for('email')).toBeInstanceOf(UnconfiguredProvider);
    expect(router.describe('email')).toMatchObject({ provider: 'qwen', configured: false });
    const e = (await router
      .for('email')
      .generateJson({ system: '', prompt: '', schema: {}, maxTokens: 1 })
      .catch((x) => x)) as AppError;
    expect(e.code).toBe('ai_not_configured');
    expect(e.message).toContain('QWEN_API_KEY');
  });
});

// ---------------------------------------------------------------- end to end

const models = new StandInModels().start();
let t: TestApp;

beforeAll(async () => {
  t = await startApp({
    ai: new AnthropicProvider({
      ANTHROPIC_API_KEY: 'test-key-not-real',
      ANTHROPIC_MODEL: 'claude-sonnet-5-5',
      ANTHROPIC_API_URL: models.url,
      ANTHROPIC_TIMEOUT_MS: 30_000,
    }),
    qwen: new QwenProvider({ ...qenv, QWEN_API_URL: `${models.url}/v1/openai` }),
    env: {
      ANTHROPIC_API_KEY: 'test-key-not-real',
      QWEN_API_KEY: 'test-key-not-real',
      AI_PROVIDER_OVERRIDES: 'player_analyst=qwen,offer_optimizer=qwen,email=qwen',
      ASSISTANT_WEB_SEARCH: 'on',
    },
  });
});
afterAll(async () => {
  await t.close();
  models.stop();
});
beforeEach(async () => {
  await t.reset();
  models.reset();
});

async function fingerprint() {
  const tables = (await t.db.execute(
    sql`select tablename from pg_tables where schemaname = 'app' and tablename not like 'ai\\_%' and tablename <> '__drizzle_migrations' order by tablename`,
  )) as unknown as { tablename: string }[];
  const out: Record<string, string> = {};
  for (const { tablename } of tables) {
    const [r] = (await t.db.execute(
      sql.raw(
        `select count(*)::int as n, coalesce(md5(string_agg(x::text, '|' order by x::text)), '') as h from app."${tablename}" x`,
      ),
    )) as unknown as { n: number; h: string }[];
    out[tablename] = `${r!.n}:${r!.h}`;
  }
  return out;
}

async function converse(c: Client, assistant: string, text: string, webSearch?: boolean) {
  const conv = await c.post<ConversationDto>('/assistants/conversations', {
    assistant,
    replyLanguage: 'en',
    webSearch,
  });
  expect(conv.status).toBe(201);
  expect(
    (await c.post(`/assistants/conversations/${conv.body.id}/messages`, { text })).status,
  ).toBe(202);
  await t.app.get(AssistantEngine).idle();
  const done = (await c.get<ConversationDto>(`/assistants/conversations/${conv.body.id}`)).body;
  return done.messages.at(-1)!;
}

describe('the five assistants through the real Anthropic and Qwen adapters', () => {
  test('each provider answers the assistants routed to it; proposals only; lookups logged; guardrails are the same', async () => {
    const f = await financeOrg(t);
    const manager = await withRole(t, f.owner, 'manager@example.com', 'esports_manager', {
      type: 'team',
      id: f.teamA.id,
    });
    const overview = (await manager.client.get<AssistantsOverviewDto>('/assistants')).body;
    expect(
      Object.fromEntries(
        overview.assistants.map((a) => [a.key, [a.provider, a.configured, a.webSearchAvailable]]),
      ),
    ).toEqual({
      general: ['anthropic', true, true],
      formal_message: ['anthropic', true, false],
      email: ['qwen', true, false],
      offer_optimizer: ['qwen', true, false],
      player_analyst: ['qwen', true, false], // Qwen hosts have no server-side search
    });

    const before = await fingerprint();
    const replies: Record<string, Awaited<ReturnType<typeof converse>>> = {};
    for (const key of ['general', 'formal_message', 'email', 'offer_optimizer', 'player_analyst'])
      replies[key] = await converse(
        manager.client,
        key,
        'Please help with our Valorant team.',
        key === 'player_analyst' ? true : undefined,
      );
    expect(await fingerprint()).toEqual(before); // nothing changed outside the assistants' own tables

    for (const [key, r] of Object.entries(replies))
      expect([key, r.status, r.answer?.kind as string]).toEqual([key, 'complete', key]);
    const stored = await t.db
      .select({ provider: aiMessages.provider, model: aiMessages.model })
      .from(aiMessages)
      .where(eq(aiMessages.role, 'assistant'));
    expect(stored.map((s) => s.provider).sort()).toEqual([
      'anthropic',
      'anthropic',
      'qwen',
      'qwen',
      'qwen',
    ]);
    expect(stored.find((s) => s.provider === 'qwen')!.model).toBe(
      'Qwen/Qwen3-235B-A22B-Instruct-2507',
    );

    // The Qwen path: an OpenAI-format tool call ran the platform lookup with the user's own
    // permissions, was logged, and its result went back as a role "tool" message.
    const followUp = models.openai.find((b) =>
      (b.messages as { role: string }[]).some((m) => m.role === 'tool'),
    )!;
    const toolMsg = (
      followUp.messages as { role: string; tool_call_id?: string; content?: string }[]
    ).find((m) => m.role === 'tool')!;
    expect(toolMsg.tool_call_id).toBe('call_standin_1');
    expect(JSON.parse(toolMsg.content!).teams.map((x: { name: string }) => x.name)).toEqual([
      'Valorant Team A',
    ]); // team B is outside scope
    expect((followUp.messages as { role: string }[]).some((m) => m.role === 'system')).toBe(false); // folded into the user turn
    const logs = (await f.owner.get<ToolCallLogDto[]>('/assistants/tool-calls')).body;
    expect(
      logs
        .filter((l) => l.tool === 'list_teams' && l.outcome === 'ok')
        .map((l) => l.assistant)
        .sort(),
    ).toEqual(['general', 'offer_optimizer', 'player_analyst']);

    // Web search asked for on a Qwen-routed assistant: skipped and flagged, never faked.
    expect(replies.player_analyst!.flags).toContainEqual({
      code: 'web_search_unavailable',
      detail: null,
    });
    expect(JSON.stringify(models.openai)).not.toContain('web_search');
    // Anthropic still gets its web search tool where it's on.
    const general = models.anthropic.find((b) => Array.isArray(b.tools))!;
    expect(
      (general.tools as { type?: string }[]).some((x) => x.type === 'web_search_20250305'),
    ).toBe(true);
  });

  test('a tool call with unreadable arguments is refused and logged, never run on a guess', async () => {
    const f = await financeOrg(t);
    models.nextArguments = '{"teamId": ';
    const reply = await converse(f.owner, 'player_analyst', 'How is the team doing?');
    expect(reply.status).toBe('complete');
    const [log] = await t.db.select().from(aiToolCalls).where(eq(aiToolCalls.tool, 'list_teams'));
    expect(log).toMatchObject({ outcome: 'error', resultSummary: { error: 'invalid_arguments' } });
    const back = models.openai.find((b) =>
      (b.messages as { role: string }[]).some((m) => m.role === 'tool'),
    )!;
    expect(JSON.stringify(back.messages)).toContain('invalid_arguments');
  });

  test('no silent fallback in the app: a feature routed to Qwen without a key says so', async () => {
    const plain = await startApp({
      ai: new AnthropicProvider({
        ANTHROPIC_API_KEY: 'test-key-not-real',
        ANTHROPIC_MODEL: 'claude-sonnet-5-5',
        ANTHROPIC_API_URL: models.url,
        ANTHROPIC_TIMEOUT_MS: 30_000,
      }),
      env: { AI_PROVIDER_OVERRIDES: 'email=qwen' },
    });
    try {
      const f = await financeOrg(plain);
      const conv = await f.owner.post<ConversationDto>('/assistants/conversations', {
        assistant: 'email',
      });
      const sent = await f.owner.post(`/assistants/conversations/${conv.body.id}/messages`, {
        text: 'Draft an email.',
      });
      expect(sent.status).toBe(503);
      expect(sent.body.error).toMatchObject({ code: 'ai_not_configured' });
      expect(sent.body.error.message).toContain('QWEN_API_KEY');
      expect(models.anthropic).toHaveLength(0); // nothing was sent to the other provider instead
      const overview = (await f.owner.get<AssistantsOverviewDto>('/assistants')).body;
      expect(overview.assistants.find((a) => a.key === 'email')).toMatchObject({
        provider: 'qwen',
        configured: false,
      });
      expect(overview.assistants.find((a) => a.key === 'general')).toMatchObject({
        provider: 'anthropic',
        configured: true,
      });
    } finally {
      await plain.close();
    }
  });
});
