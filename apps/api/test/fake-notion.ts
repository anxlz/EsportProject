/**
 * A stand-in for the parts of Notion's API (version 2026-03-11) the integration uses:
 * databases → data sources, data source schema updates, pages (create / update / get /
 * in_trash) and data source queries with filters and pagination, plus 429 with Retry-After.
 * Built from Notion's reference; it is NOT Notion. Like Notion, last_edited_time is rounded
 * down to the minute (which is why the adapter versions pages by content hash).
 */
type Props = Record<string, unknown>;
interface Page {
  id: string;
  url: string;
  in_trash: boolean;
  last_edited_time: string;
  properties: Props;
  parent: { data_source_id: string };
}

const minute = (d = new Date()) =>
  new Date(Math.floor(d.getTime() / 60000) * 60000).toISOString().replace(':00.000Z', ':00.000Z');

export class FakeNotion {
  server!: ReturnType<typeof Bun.serve>;
  url = '';
  token = 'secret_test_notion_token_0123456789';
  databaseId = '1a2b3c4d5e6f47a8b9c0d1e2f3a4b5c6';
  dataSourceId = 'ds-0000-1111';
  properties: Record<string, { type: string }> = {};
  pages = new Map<string, Page>();
  requests: { method: string; path: string; headers: Record<string, string>; body: unknown }[] = [];
  private failures: { status: number; headers?: Record<string, string>; times: number }[] = [];
  private n = 0;

  start() {
    this.server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (req) => this.handle(req) });
    this.url = `http://127.0.0.1:${this.server.port}`;
    this.reset();
    return this;
  }
  stop() {
    this.server.stop(true);
  }
  reset() {
    this.pages.clear();
    this.requests = [];
    this.failures = [];
    this.properties = { Name: { type: 'title' }, Owner: { type: 'people' } };
  }
  failNext(status: number, times = 1, headers?: Record<string, string>) {
    this.failures.push({ status, times, headers });
  }
  calls(method: string, re: RegExp) {
    return this.requests.filter((r) => r.method === method && re.test(r.path));
  }

  // ---------- what a person does in Notion ----------

  userEdit(id: string, props: Props) {
    const p = this.pages.get(id)!;
    Object.assign(p.properties, props);
    p.last_edited_time = minute();
  }
  userTrash(id: string) {
    const p = this.pages.get(id)!;
    p.in_trash = true;
    p.last_edited_time = minute();
  }
  userCreate(props: Props) {
    const id = `page-${++this.n}`;
    this.pages.set(id, {
      id,
      url: `https://notion.example/${id}`,
      in_trash: false,
      last_edited_time: minute(),
      properties: props,
      parent: { data_source_id: this.dataSourceId },
    });
    return id;
  }

  // ---------- HTTP ----------

  private json(status: number, body: unknown, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  }
  private err(status: number, code: string, message = code) {
    return this.json(status, { object: 'error', status, code, message });
  }

  private async handle(req: Request): Promise<Response> {
    const u = new URL(req.url);
    const text = await req.text();
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    const headers = Object.fromEntries(req.headers.entries());
    this.requests.push({ method: req.method, path: u.pathname, headers, body });
    const f = this.failures.find((x) => x.times > 0);
    if (f) {
      f.times -= 1;
      return this.json(
        f.status,
        {
          object: 'error',
          status: f.status,
          code: f.status === 429 ? 'rate_limited' : 'internal_server_error',
          message: 'fake',
        },
        f.headers,
      );
    }
    if (headers.authorization !== `Bearer ${this.token}`)
      return this.err(401, 'unauthorized', 'API token is invalid.');
    if (!headers['notion-version']) return this.err(400, 'missing_version');

    const dash = (id: string) => id.replace(/-/g, '');
    let m: RegExpExecArray | null;
    if ((m = /^\/v1\/databases\/([^/]+)$/.exec(u.pathname)) && req.method === 'GET') {
      if (dash(m[1]!) !== this.databaseId) return this.err(404, 'object_not_found');
      return this.json(200, {
        object: 'database',
        id: m[1],
        title: [{ plain_text: 'Team meetings' }],
        data_sources: [{ id: this.dataSourceId, name: 'Team meetings' }],
      });
    }
    if ((m = /^\/v1\/data_sources\/([^/]+)$/.exec(u.pathname))) {
      if (m[1] !== this.dataSourceId) return this.err(404, 'object_not_found');
      if (req.method === 'GET')
        return this.json(200, { object: 'data_source', id: m[1], properties: this.properties });
      if (req.method === 'PATCH') {
        for (const [k, v] of Object.entries((body?.properties as Props) ?? {}))
          this.properties[k] = { type: Object.keys(v as object)[0]! };
        return this.json(200, { object: 'data_source', id: m[1], properties: this.properties });
      }
    }
    if ((m = /^\/v1\/data_sources\/([^/]+)\/query$/.exec(u.pathname)) && req.method === 'POST')
      return this.query(body ?? {});
    if (u.pathname === '/v1/pages' && req.method === 'POST') {
      const parent = body?.parent as { data_source_id?: string };
      if (parent?.data_source_id !== this.dataSourceId) return this.err(404, 'object_not_found');
      for (const k of Object.keys((body?.properties as Props) ?? {}))
        if (!this.properties[k])
          return this.err(400, 'validation_error', `${k} is not a property that exists.`);
      const id = `page-${++this.n}`;
      const page: Page = {
        id,
        url: `https://notion.example/${id}`,
        in_trash: false,
        last_edited_time: minute(),
        properties: this.read(body?.properties as Props),
        parent: { data_source_id: this.dataSourceId },
      };
      this.pages.set(id, page);
      return this.json(200, this.out(page));
    }
    if ((m = /^\/v1\/pages\/([^/]+)$/.exec(u.pathname))) {
      const page = this.pages.get(m[1]!);
      if (!page) return this.err(404, 'object_not_found');
      if (req.method === 'GET') return this.json(200, this.out(page));
      if (req.method === 'PATCH') {
        if (body?.properties) Object.assign(page.properties, this.read(body.properties as Props));
        if (typeof body?.in_trash === 'boolean') page.in_trash = body.in_trash;
        page.last_edited_time = minute();
        return this.json(200, this.out(page));
      }
    }
    return this.err(404, 'invalid_request_url');
  }

  /** Notion returns rich text with plain_text filled in. */
  private read(props: Props): Props {
    const out: Props = {};
    for (const [k, v] of Object.entries(props ?? {})) {
      const val = v as Record<string, unknown>;
      const rt = (arr: unknown) =>
        ((arr as { text?: { content: string } }[]) ?? []).map((x) => ({
          type: 'text',
          text: x.text,
          plain_text: x.text?.content ?? '',
        }));
      if ('title' in val) out[k] = { type: 'title', title: rt(val.title) };
      else if ('rich_text' in val) out[k] = { type: 'rich_text', rich_text: rt(val.rich_text) };
      else if ('date' in val) out[k] = { type: 'date', date: val.date };
      else if ('select' in val) out[k] = { type: 'select', select: val.select };
      else out[k] = val;
    }
    return out;
  }

  private out(p: Page) {
    return {
      object: 'page',
      id: p.id,
      url: p.url,
      in_trash: p.in_trash,
      last_edited_time: p.last_edited_time,
      parent: { type: 'data_source_id', ...p.parent },
      properties: p.properties,
    };
  }

  private query(body: Record<string, unknown>) {
    let pages = [...this.pages.values()].filter((p) => !p.in_trash);
    const filter = body.filter as Record<string, unknown> | undefined;
    if (filter?.property) {
      const want = (filter.rich_text as { equals: string }).equals;
      pages = pages.filter(
        (p) =>
          (
            (p.properties[filter.property as string] as { rich_text?: { plain_text: string }[] })
              ?.rich_text ?? []
          )
            .map((x) => x.plain_text)
            .join('') === want,
      );
    }
    if (filter?.timestamp === 'last_edited_time') {
      const since = (filter.last_edited_time as { on_or_after: string }).on_or_after;
      pages = pages.filter((p) => p.last_edited_time >= since);
    }
    pages.sort(
      (a, b) => a.last_edited_time.localeCompare(b.last_edited_time) || a.id.localeCompare(b.id),
    );
    const size = Number(body.page_size ?? 100);
    const offset = Number(body.start_cursor ?? 0);
    const slice = pages.slice(offset, offset + size);
    const more = offset + size < pages.length;
    return this.json(200, {
      object: 'list',
      results: slice.map((p) => this.out(p)),
      has_more: more,
      next_cursor: more ? String(offset + size) : null,
    });
  }
}

export const prop = {
  title: (s: string) => ({ title: [{ type: 'text', text: { content: s }, plain_text: s }] }),
  text: (s: string) => ({ rich_text: [{ type: 'text', text: { content: s }, plain_text: s }] }),
  when: (start: string, end: string, tz: string) => ({ date: { start, end, time_zone: tz } }),
  status: (name: string) => ({ select: { name } }),
};
