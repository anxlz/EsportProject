/**
 * A local HTTP stand-in that answers in BOTH providers' documented wire formats, so the real
 * adapters (AnthropicProvider, QwenProvider) and the real assistant engine run end to end:
 *
 * - Anthropic Messages API: POST /v1/messages — structured output (`output_config.format`)
 *   returns JSON text; a tool-enabled call returns a `tool_use` block, then text once it gets
 *   `tool_result` blocks back.
 * - OpenAI-compatible chat completions (DeepInfra's Qwen3 endpoint): POST
 *   /v1/openai/chat/completions — `response_format` json_schema returns JSON (wrapped in a code
 *   fence, which real models sometimes do), a tool call comes back as `tool_calls` with
 *   `arguments` as a JSON string, then text once it gets role "tool" messages.
 *
 * It is NOT a model: answers are mechanical, built from the requested JSON schema. What this
 * proves is the plumbing and the provider-neutral guardrails, not answer quality.
 */

type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
  enum?: string[];
};

/** A value matching a structured-output schema: strings filled, arrays with one item. */
export function instance(schema: Schema, key = ''): unknown {
  if (schema.enum) return schema.enum[0];
  switch (schema.type) {
    case 'object':
      return Object.fromEntries(
        Object.entries(schema.properties ?? {}).map(([k, s]) => [k, instance(s, k)]),
      );
    case 'array':
      return key === 'claims' || key === 'sources' || key === 'to' || key === 'cc'
        ? []
        : [instance(schema.items ?? { type: 'string' }, key)];
    case 'string':
      return key === 'email' ? '' : `Stand-in ${key || 'text'} written in English for the test.`;
    default:
      return null;
  }
}

export class StandInModels {
  server!: ReturnType<typeof Bun.serve>;
  url = '';
  anthropic: Record<string, unknown>[] = [];
  openai: Record<string, unknown>[] = [];
  /** Name of the tool the stand-in asks for first (if offered). */
  tool = 'list_teams';
  /** Next OpenAI tool call's raw `arguments` string (e.g. invalid JSON). */
  nextArguments: string | null = null;

  start() {
    this.server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (req) => this.handle(req) });
    this.url = `http://127.0.0.1:${this.server.port}`;
    return this;
  }
  stop() {
    this.server.stop(true);
  }
  reset() {
    this.anthropic = [];
    this.openai = [];
    this.tool = 'list_teams';
    this.nextArguments = null;
  }

  private json(body: unknown) {
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  }

  private async handle(req: Request) {
    const u = new URL(req.url);
    const body = (await req.json()) as Record<string, unknown>;
    if (u.pathname === '/v1/messages') {
      this.anthropic.push(body);
      const usage = { input_tokens: 100, output_tokens: 20 };
      const fmt = (body.output_config as { format?: { schema?: Schema } } | undefined)?.format;
      if (fmt?.schema)
        return this.json({
          model: body.model,
          content: [{ type: 'text', text: JSON.stringify(instance(fmt.schema)) }],
          stop_reason: 'end_turn',
          usage,
        });
      const messages = body.messages as { role: string; content: unknown }[];
      const last = messages.at(-1)!;
      const gotResults =
        Array.isArray(last.content) &&
        (last.content as { type?: string }[]).some((b) => b.type === 'tool_result');
      const tools = ((body.tools as { name?: string; type?: string }[]) ?? []).filter(
        (t) => !t.type,
      );
      if (!gotResults && tools.some((t) => t.name === this.tool))
        return this.json({
          model: body.model,
          content: [
            { type: 'text', text: 'Let me check.' },
            { type: 'tool_use', id: 'toolu_standin_1', name: this.tool, input: {} },
          ],
          stop_reason: 'tool_use',
          usage,
        });
      return this.json({
        model: body.model,
        content: [{ type: 'text', text: 'Looked it up.' }],
        stop_reason: 'end_turn',
        usage,
      });
    }
    if (u.pathname === '/v1/openai/chat/completions') {
      this.openai.push(body);
      const usage = { prompt_tokens: 120, completion_tokens: 30 };
      const fmt = (body.response_format as { json_schema?: { schema?: Schema } } | undefined)
        ?.json_schema;
      if (fmt?.schema)
        return this.json({
          model: body.model,
          choices: [
            {
              message: {
                role: 'assistant',
                content: '```json\n' + JSON.stringify(instance(fmt.schema)) + '\n```',
              },
              finish_reason: 'stop',
            },
          ],
          usage,
        });
      const messages = body.messages as { role: string }[];
      const tools = ((body.tools as { function?: { name?: string } }[]) ?? []).map(
        (t) => t.function?.name,
      );
      if (messages.at(-1)!.role !== 'tool' && tools.includes(this.tool)) {
        const args = this.nextArguments ?? '{}';
        this.nextArguments = null;
        return this.json({
          model: body.model,
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_standin_1',
                    type: 'function',
                    function: { name: this.tool, arguments: args },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage,
        });
      }
      return this.json({
        model: body.model,
        choices: [
          { message: { role: 'assistant', content: 'Looked it up.' }, finish_reason: 'stop' },
        ],
        usage,
      });
    }
    return new Response('not found', { status: 404 });
  }
}
