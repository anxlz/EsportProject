/** Unit tests for Phase 3 building blocks that don't need the app running. */
import { describe, expect, test } from 'bun:test';
import type { ContractClause } from '@esports/shared';
import { AnthropicProvider, aiProviderFromEnv, UnconfiguredProvider } from '../src/ai/ai.provider';
import { AppError } from '../src/common/errors';
import { loadEnv } from '../src/config/env';
import { mergeClauses } from '../src/contracts/contracts.service';
import { sniffContentType } from '../src/files/files.service';
import { canonicalJson, sha256Hex } from '../src/versioning/versioning.service';

const BASE = {
  DATABASE_URL: 'postgres://x',
  REDIS_URL: 'redis://x',
  WEB_APP_URL: 'http://localhost:3000',
  SESSION_SECRET: 'x'.repeat(40),
};

describe('AI provider', () => {
  test('no key → unconfigured provider; empty KEY= in .env counts as unset', () => {
    expect(aiProviderFromEnv(loadEnv(BASE))).toBeInstanceOf(UnconfiguredProvider);
    expect(aiProviderFromEnv(loadEnv({ ...BASE, ANTHROPIC_API_KEY: '' }))).toBeInstanceOf(UnconfiguredProvider);
    const env = loadEnv({ ...BASE, ANTHROPIC_API_KEY: 'test-key-not-real', ANTHROPIC_MODEL: '' });
    expect(env.ANTHROPIC_MODEL).toBe('claude-sonnet-5-5');
    expect(aiProviderFromEnv(env)).toBeInstanceOf(AnthropicProvider);
  });

  test('unconfigured provider refuses with ai_not_configured', async () => {
    const e = await new UnconfiguredProvider().generateJson().catch((x) => x);
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).code).toBe('ai_not_configured');
  });

  const env = { ANTHROPIC_API_KEY: 'test-key-not-real', ANTHROPIC_MODEL: 'claude-sonnet-5-5', ANTHROPIC_API_URL: 'https://api.anthropic.example', ANTHROPIC_TIMEOUT_MS: 10000 };
  const req = { system: 'sys', prompt: 'hello', schema: { type: 'object', properties: {}, additionalProperties: false }, maxTokens: 1000 };

  test('Anthropic adapter: Messages API with structured output, JSON read from the text block', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fake = (async (url: URL | string, init?: RequestInit) => {
      seen = { url: String(url), init: init! };
      return new Response(
        JSON.stringify({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"ok":true}' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const out = await new AnthropicProvider(env, fake).generateJson(req);
    expect(out).toEqual({ data: { ok: true }, model: 'claude-sonnet-5-5' });
    expect(seen!.url).toBe('https://api.anthropic.example/v1/messages');
    const headers = seen!.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('test-key-not-real');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(seen!.init.body as string);
    expect(body).toMatchObject({
      model: 'claude-sonnet-5-5',
      max_tokens: 1000,
      system: 'sys',
      messages: [{ role: 'user', content: 'hello' }],
      output_config: { format: { type: 'json_schema', schema: req.schema } },
    });
    // No forced tool use (rejected by current models).
    expect(body.tool_choice).toBeUndefined();
  });

  test('Anthropic adapter: errors, refusals and truncation become ai_unavailable', async () => {
    const respond = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    const code = async (f: typeof fetch) => ((await new AnthropicProvider(env, f).generateJson(req).catch((e) => e)) as AppError).code;
    expect(await code(respond(401, { type: 'error', error: { type: 'authentication_error' } }))).toBe('ai_unavailable');
    expect(await code(respond(529, { type: 'error', error: { type: 'overloaded_error' } }))).toBe('ai_unavailable');
    expect(await code(respond(200, { stop_reason: 'refusal', content: [] }))).toBe('ai_unavailable');
    expect(await code(respond(200, { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"a":' }] }))).toBe('ai_unavailable');
    expect(await code(respond(200, { stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] }))).toBe('ai_unavailable');
    expect(await code((async () => { throw new TypeError('network'); }) as unknown as typeof fetch)).toBe('ai_unavailable');
  });
});

describe('clause rules', () => {
  const clause = (over: Partial<ContractClause>): ContractClause => ({
    id: crypto.randomUUID(),
    templateClauseId: null,
    source: 'template',
    required: false,
    included: true,
    titleEn: 'T',
    titleAr: 'ت',
    bodyEn: 'B',
    bodyAr: 'ب',
    ...over,
  });

  test('origin and required flag come from the stored version; new clauses are custom and optional', () => {
    const req = clause({ required: true, templateClauseId: crypto.randomUUID() });
    const opt = clause({});
    const added = clause({ source: 'template', required: true, templateClauseId: req.templateClauseId });
    const out = mergeClauses([req, opt], [{ ...req, bodyEn: 'Edited' }, { ...opt, included: false }, added]);
    expect(out[0]).toMatchObject({ id: req.id, required: true, source: 'template', bodyEn: 'Edited', templateClauseId: req.templateClauseId });
    expect(out[1]).toMatchObject({ included: false });
    expect(out[2]).toMatchObject({ source: 'custom', required: false, templateClauseId: null });
  });

  test('required clauses cannot be excluded or removed', () => {
    const req = clause({ required: true });
    expect(() => mergeClauses([req], [{ ...req, included: false }])).toThrow(/required/);
    expect(() => mergeClauses([req], [])).toThrow(/cannot be removed/);
  });
});

describe('fingerprints and file sniffing', () => {
  test('canonical JSON ignores key order and undefined values', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: undefined, e: null }] })).toBe('{"a":[{"d":2,"e":null}],"b":1}');
    expect(sha256Hex(canonicalJson({ x: 1, y: 2 }))).toBe(sha256Hex(canonicalJson({ y: 2, x: 1 })));
  });

  test('files are typed by their bytes', () => {
    expect(sniffContentType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(sniffContentType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffContentType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffContentType(Buffer.from('%PDF-1.7\n'))).toBe('application/pdf');
    expect(sniffContentType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffContentType(Buffer.from('<html><script>'))).toBeNull();
  });
});
