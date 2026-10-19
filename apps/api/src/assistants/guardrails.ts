/**
 * Source verification guardrails (spec §8.1), applied by code, not left to the model:
 *
 * 1. Citations point only at sources the platform registered while running tools (platform
 *    records, web search results) or at context the user typed in. The model refers to them by
 *    id (P1, W1, U1); an id that wasn't registered is removed and flagged — a fabricated source
 *    can't survive into an answer.
 * 2. Every claim carries a confidence label. "Confirmed" must rest on a cited source that has
 *    content behind it (platform data, the user's context, or a quoted web excerpt); otherwise it
 *    is downgraded to "uncertain" and flagged.
 * 3. Links in the answer text must be ones a tool returned or the user wrote; any other link is
 *    replaced with a marker and flagged.
 * 4. Scenario wording is checked for guarantees ("guaranteed", "مضمون"…) and flagged.
 * The answer's language is checked against the conversation's reply language.
 */
import {
  type AnswerLanguage,
  type ClaimDto,
  detectLanguage,
  type GuardrailCode,
  type GuardrailFlagDto,
  type SourceDto,
  type SourceLabel,
} from '@esports/shared';

const EVIDENCE_MAX = 6000;
const EXCERPT_MAX = 300;

interface RegisteredSource extends SourceDto {
  evidence: string;
  excerpts: string[];
}

/** The sources consulted for one answer, numbered per kind in the order they were found. */
export class SourceRegistry {
  private readonly items: RegisteredSource[] = [];
  private readonly n = { P: 0, W: 0, U: 0 };
  private readonly byUrl = new Map<string, RegisteredSource>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  private push(prefix: 'P' | 'W' | 'U', s: Omit<RegisteredSource, 'id' | 'retrievedAt'>) {
    this.n[prefix] += 1;
    const src = { ...s, id: `${prefix}${this.n[prefix]}`, retrievedAt: this.now().toISOString() };
    this.items.push(src);
    return src;
  }

  addPlatform(
    title: string,
    url: string | null,
    data: unknown,
    label: { key: SourceLabel; subject?: string | null } | null = null,
  ): string {
    const json = JSON.stringify(data);
    return this.push('P', {
      kind: 'platform',
      title,
      label: label?.key ?? null,
      subject: label?.subject ?? null,
      url,
      pageAge: null,
      excerpt: null,
      evidence: json.length > EVIDENCE_MAX ? `${json.slice(0, EVIDENCE_MAX)}…(truncated)` : json,
      excerpts: [],
    }).id;
  }

  addUser(title: string, content: string, label: SourceLabel | null = null): string {
    return this.push('U', {
      kind: 'user',
      title,
      label,
      subject: null,
      url: null,
      pageAge: null,
      excerpt: null,
      evidence: content.slice(0, EVIDENCE_MAX * 2),
      excerpts: [],
    }).id;
  }

  /** A web search result (deduplicated by URL). */
  addWeb(url: string, title: string, pageAge: string | null): string {
    const existing = this.byUrl.get(url);
    if (existing) return existing.id;
    const src = this.push('W', {
      kind: 'web',
      title: title || url,
      label: null,
      subject: null,
      url,
      pageAge,
      excerpt: null,
      evidence: '',
      excerpts: [],
    });
    this.byUrl.set(url, src);
    return src.id;
  }

  /** Text the provider quoted from a web result when citing it. */
  addWebExcerpt(url: string, title: string | null, text: string | null): string {
    const id = this.addWeb(url, title ?? url, null);
    const src = this.byUrl.get(url)!;
    const t = (text ?? '').trim();
    if (t && !src.excerpts.includes(t)) src.excerpts.push(t);
    return id;
  }

  has(id: string) {
    return this.items.some((s) => s.id === id);
  }

  /** The source has content an answer could rest on (not just a search-result title). */
  hasEvidence(id: string) {
    const s = this.items.find((x) => x.id === id);
    return !!s && (s.kind !== 'web' || s.excerpts.length > 0);
  }

  urls(): string[] {
    return this.items.map((s) => s.url).filter((u): u is string => !!u && /^https?:/.test(u));
  }

  get size() {
    return this.items.length;
  }

  /** Public view stored with the answer. */
  list(): SourceDto[] {
    return this.items.map(({ evidence: _e, excerpts, ...s }) => ({
      ...s,
      excerpt: excerpts[0] ? excerpts[0].slice(0, EXCERPT_MAX) : null,
    }));
  }

  /** The evidence block given to the model when it writes the final answer. */
  evidencePack(): string {
    if (!this.items.length) return '(no sources were consulted)';
    return this.items
      .map((s) => {
        const head = `[${s.id}] ${s.kind} — ${s.title}${s.url && s.kind === 'web' ? ` <${s.url}>` : ''}${s.pageAge ? ` (page updated ${s.pageAge})` : ''}`;
        if (s.kind === 'web')
          return `${head}\n${s.excerpts.length ? s.excerpts.map((e) => `  quoted: "${e}"`).join('\n') : '  (search result only: no quoted text)'}`;
        return `${head}\n  data: ${s.evidence}`;
      })
      .join('\n');
  }
}

export class Flags {
  private readonly list: GuardrailFlagDto[] = [];
  add(code: GuardrailCode, detail: string | null = null) {
    if (!this.list.some((f) => f.code === code && f.detail === detail))
      this.list.push({ code, detail });
  }
  has(code: GuardrailCode) {
    return this.list.some((f) => f.code === code);
  }
  all() {
    return [...this.list];
  }
}

/** Removes unknown source ids and downgrades unsupported "confirmed" claims (guardrails 1–2). */
export function checkClaims(
  claims: ClaimDto[],
  registry: SourceRegistry,
  flags: Flags,
): ClaimDto[] {
  return claims.map((c) => {
    const unknown = c.sourceIds.filter((id) => !registry.has(id));
    if (unknown.length) flags.add('unknown_source_removed', [...new Set(unknown)].join(', '));
    const sourceIds = [...new Set(c.sourceIds.filter((id) => registry.has(id)))];
    let confidence = c.confidence;
    if (confidence === 'confirmed' && !sourceIds.some((id) => registry.hasEvidence(id))) {
      confidence = 'uncertain';
      flags.add('unsupported_confirmation', c.text.slice(0, 120));
    }
    return { ...c, sourceIds, confidence };
  });
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'()[\]{}]+/gi;
export const LINK_REMOVED = '[link removed: not from a verified source]';

/** URLs that appear in text the user wrote (allowed back in the answer). */
export function urlsIn(texts: (string | null | undefined)[]): string[] {
  return texts.flatMap((t) => (t ?? '').match(URL_RE) ?? []).map(trimUrl);
}

const trimUrl = (u: string) => u.replace(/[.,;:!?]+$/, '');

/** Replaces links that no tool returned and the user didn't write (guardrail 3). */
export function scrubLinks(text: string, allowed: string[], flags: Flags): string {
  const ok = new Set(allowed.map(trimUrl));
  return text.replace(URL_RE, (raw) => {
    const u = trimUrl(raw);
    if (ok.has(u)) return raw;
    flags.add('link_removed', u.slice(0, 200));
    return LINK_REMOVED + raw.slice(u.length);
  });
}

/** Applies a string transform to every string inside a JSON-like value. */
export function mapStrings<T>(value: T, f: (s: string) => string): T {
  if (typeof value === 'string') return f(value) as T;
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, f)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, mapStrings(v, f)]),
    ) as T;
  }
  return value;
}

/**
 * Promise wording. "Guaranteed pay / salary / minimum" is ordinary contract vocabulary (the fixed
 * part of an offer, as opposed to bonuses), so it isn't treated as a promise about outcomes.
 */
const PAY_TERM_EN =
  '(?:base|pay|salary|salaries|minimum|amount|money|income|payment|compensation|portion|part|component|wage)s?';
const PAY_TERM_AR =
  '(?:راتب|راتبًا|الراتب|أجر|أجرًا|الأجر|مبلغ|مبلغًا|المبلغ|دخل|دخلًا|الدخل|حد أدنى|حدًا أدنى|الحد الأدنى)';
const GUARANTEE_RE = new RegExp(
  [
    `\\b(?:guarantee[ds]?|guaranteeing)\\b(?!\\s+${PAY_TERM_EN}\\b)`,
    '\\b(?:certain to|will definitely|risk[- ]free|sure to)\\b',
    `(?<!${PAY_TERM_AR}\\s)(?:مضمونة|مضمون)`,
    'نضمن|بكل تأكيد|خالٍ من المخاطر|خال من المخاطر',
  ].join('|'),
  'i',
);

/** Scenarios must not read as guarantees (spec §8.2.5). */
export function checkGuarantees(texts: string[], flags: Flags) {
  for (const t of texts) {
    const m = t.match(GUARANTEE_RE);
    if (m) flags.add('guarantee_language', m[0]);
  }
}

/** The answer is written in the expected language (on its main text). */
export function languageMatches(text: string, expected: AnswerLanguage): boolean {
  const letters = text.replace(/\s+/g, '');
  if (letters.length < 12) return true;
  return detectLanguage(text) === expected;
}
