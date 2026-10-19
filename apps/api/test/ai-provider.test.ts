/**
 * The Anthropic adapter's tool-calling path (Phase 5), checked against the request and response
 * shapes in Anthropic's documentation (web search tool, server tools, tool use; read 18 Oct 2026).
 * fetch is mocked: this never calls the real API (no key is available in this build).
 */
import { describe, expect, test } from 'bun:test';
import {
  AnthropicProvider,
  type AiConverseRequest,
  WEB_SEARCH_TOOL_TYPE,
  WebSearchUnavailableError,
} from '../src/ai/ai.provider';

const env = {
  ANTHROPIC_API_KEY: 'test-key-not-real',
  ANTHROPIC_MODEL: 'claude-sonnet-5-5',
  ANTHROPIC_API_URL: 'https://api.anthropic.test',
  ANTHROPIC_TIMEOUT_MS: 30_000,
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

const baseReq: AiConverseRequest = {
  system: 'You are a test.',
  messages: [{ role: 'user', text: 'When was Claude Shannon born?' }],
  tools: [
    {
      name: 'get_finance_summary',
      description: 'Finance report.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ],
  webSearch: { maxUses: 3 },
  maxTokens: 2000,
};

// The response example from the web search tool page, plus a client tool call.
const DOC_RESPONSE = {
  role: 'assistant',
  content: [
    { type: 'text', text: "I'll search for when Claude Shannon was born." },
    {
      type: 'server_tool_use',
      id: 'srvtoolu_01WYG3ziw53XMcoyKL4XcZmE',
      name: 'web_search',
      input: { query: 'claude shannon birth date' },
    },
    {
      type: 'web_search_tool_result',
      tool_use_id: 'srvtoolu_01WYG3ziw53XMcoyKL4XcZmE',
      content: [
        {
          type: 'web_search_result',
          url: 'https://en.wikipedia.org/wiki/Claude_Shannon',
          title: 'Claude Shannon - Wikipedia',
          encrypted_content: 'EqgfCioIARgBIiQ3YTAwMjY1Mi1mZjM5LTQ1NGUtODgxNC1kNjNjNTk1ZWI3Y',
          page_age: 'April 30, 2025',
        },
      ],
    },
    {
      type: 'text',
      text: 'Claude Shannon was born on April 30, 1916, in Petoskey, Michigan',
      citations: [
        {
          type: 'web_search_result_location',
          url: 'https://en.wikipedia.org/wiki/Claude_Shannon',
          title: 'Claude Shannon - Wikipedia',
          encrypted_index: 'Eo8BCioIAhgBIiQyYjQ0OWJmZi1lNm..',
          cited_text:
            'Claude Elwood Shannon (April 30, 1916 – February 24, 2001) was an American mathematician',
        },
      ],
    },
    {
      type: 'tool_use',
      id: 'toolu_01A',
      name: 'get_finance_summary',
      input: { scope: 'organization' },
    },
  ],
  model: 'claude-sonnet-5-5',
  usage: { input_tokens: 6039, output_tokens: 931, server_tool_use: { web_search_requests: 1 } },
  stop_reason: 'tool_use',
};

describe('Anthropic adapter: converse()', () => {
  test('sends client tools and the basic web search tool; maps every documented block', async () => {
    const f = mockFetch(200, DOC_RESPONSE);
    const r = await new AnthropicProvider(env, f.impl).converse(baseReq);
    const sent = f.calls[0]!;
    expect(sent.url).toBe('https://api.anthropic.test/v1/messages');
    expect((sent.init.headers as Record<string, string>)['x-api-key']).toBe('test-key-not-real');
    expect(sent.body).toMatchObject({
      model: 'claude-sonnet-5-5',
      max_tokens: 2000,
      system: 'You are a test.',
      messages: [{ role: 'user', content: 'When was Claude Shannon born?' }],
      tools: [
        {
          name: 'get_finance_summary',
          description: 'Finance report.',
          input_schema: { type: 'object', properties: {}, additionalProperties: false },
        },
        { type: WEB_SEARCH_TOOL_TYPE, name: 'web_search', max_uses: 3 },
      ],
    });
    expect(WEB_SEARCH_TOOL_TYPE).toBe('web_search_20250305');
    // No structured-output parameter in a tool call (incompatible with citations).
    expect(sent.body.output_config).toBeUndefined();

    expect(r.stopReason).toBe('tool_use');
    expect(r.usage).toEqual({ inputTokens: 6039, outputTokens: 931, webSearchRequests: 1 });
    expect(r.blocks).toEqual([
      { type: 'text', text: "I'll search for when Claude Shannon was born.", citations: [] },
      {
        type: 'web_search',
        id: 'srvtoolu_01WYG3ziw53XMcoyKL4XcZmE',
        query: 'claude shannon birth date',
      },
      {
        type: 'web_search_result',
        toolUseId: 'srvtoolu_01WYG3ziw53XMcoyKL4XcZmE',
        results: [
          {
            url: 'https://en.wikipedia.org/wiki/Claude_Shannon',
            title: 'Claude Shannon - Wikipedia',
            pageAge: 'April 30, 2025',
          },
        ],
        errorCode: null,
      },
      {
        type: 'text',
        text: 'Claude Shannon was born on April 30, 1916, in Petoskey, Michigan',
        citations: [
          {
            url: 'https://en.wikipedia.org/wiki/Claude_Shannon',
            title: 'Claude Shannon - Wikipedia',
            citedText:
              'Claude Elwood Shannon (April 30, 1916 – February 24, 2001) was an American mathematician',
          },
        ],
      },
      {
        type: 'tool_use',
        id: 'toolu_01A',
        name: 'get_finance_summary',
        input: { scope: 'organization' },
      },
    ]);
    // The raw content (with encrypted_content) is kept to be passed back unchanged.
    expect(r.raw).toEqual(DOC_RESPONSE.content);
  });

  test('continuation: the earlier turn goes back verbatim, then a message of only tool results', async () => {
    const f = mockFetch(200, {
      content: [{ type: 'text', text: 'Done.' }],
      stop_reason: 'end_turn',
    });
    await new AnthropicProvider(env, f.impl).converse({
      ...baseReq,
      messages: [
        { role: 'user', text: 'Q' },
        { role: 'assistant_turn', raw: DOC_RESPONSE.content },
        {
          role: 'tool_results',
          results: [
            { toolUseId: 'toolu_01A', content: '{"sourceId":"P1"}', isError: false },
            { toolUseId: 'toolu_01B', content: '{"error":"not_available"}', isError: true },
          ],
        },
      ],
    });
    expect(f.calls[0]!.body.messages).toEqual([
      { role: 'user', content: 'Q' },
      { role: 'assistant', content: DOC_RESPONSE.content },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_01A', content: '{"sourceId":"P1"}' },
          {
            type: 'tool_result',
            tool_use_id: 'toolu_01B',
            content: '{"error":"not_available"}',
            is_error: true,
          },
        ],
      },
    ]);
  });

  test('pause_turn, search errors and refusals are surfaced; no tools means no tools key', async () => {
    const paused = mockFetch(200, {
      content: [
        { type: 'server_tool_use', id: 'srvtoolu_x', name: 'web_search', input: { query: 'q' } },
      ],
      stop_reason: 'pause_turn',
    });
    const p = await new AnthropicProvider(env, paused.impl).converse({
      ...baseReq,
      tools: [],
      webSearch: null,
    });
    expect(p.stopReason).toBe('pause_turn');
    expect(paused.calls[0]!.body.tools).toBeUndefined();

    const err = mockFetch(200, {
      content: [
        {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_a93jad',
          content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' },
        },
      ],
      stop_reason: 'end_turn',
    });
    const e = await new AnthropicProvider(env, err.impl).converse(baseReq);
    expect(e.blocks).toEqual([
      {
        type: 'web_search_result',
        toolUseId: 'srvtoolu_a93jad',
        results: [],
        errorCode: 'max_uses_exceeded',
      },
    ]);

    const refusal = mockFetch(200, { content: [], stop_reason: 'refusal' });
    expect((await new AnthropicProvider(env, refusal.impl).converse(baseReq)).stopReason).toBe(
      'refusal',
    );
  });

  test('web search switched off for the account → a distinct error; other failures → ai_unavailable', async () => {
    const off = mockFetch(400, {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'Web search is not enabled for this organization',
      },
    });
    await expect(new AnthropicProvider(env, off.impl).converse(baseReq)).rejects.toBeInstanceOf(
      WebSearchUnavailableError,
    );
    // The same 400 without web search in the request is a plain error.
    await expect(
      new AnthropicProvider(env, off.impl).converse({ ...baseReq, webSearch: null }),
    ).rejects.toMatchObject({ code: 'ai_unavailable' });
    const busy = mockFetch(529, { type: 'error', error: { type: 'overloaded_error' } });
    await expect(new AnthropicProvider(env, busy.impl).converse(baseReq)).rejects.toMatchObject({
      code: 'ai_unavailable',
    });
  });
});
