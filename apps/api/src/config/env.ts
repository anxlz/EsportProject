/**
 * Environment configuration, validated once at startup. Every value comes from the environment;
 * nothing secret has a default. Missing optional integrations (Discord, SMTP) disable the
 * corresponding feature instead of failing startup.
 */
import { z } from 'zod';

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? fallback : v === 'true' || v === '1'));

/** Features whose AI provider can be chosen (the clause assistant and the five assistants). */
export const AI_FEATURES = [
  'clause_assistant',
  'general',
  'formal_message',
  'email',
  'offer_optimizer',
  'player_analyst',
] as const;
export type AiFeature = (typeof AI_FEATURES)[number];
export type AiProviderName = 'anthropic' | 'qwen';

/** "player_analyst=qwen, email=anthropic" → map; throws on anything unknown. */
export function parseProviderOverrides(raw: string | undefined): Map<AiFeature, AiProviderName> {
  const out = new Map<AiFeature, AiProviderName>();
  for (const part of (raw ?? '').split(',').map((p) => p.trim()).filter(Boolean)) {
    const [feature, provider] = part.split('=').map((x) => x?.trim());
    if (!feature || !(AI_FEATURES as readonly string[]).includes(feature))
      throw new Error(`unknown feature "${feature ?? ''}"`);
    if (provider !== 'anthropic' && provider !== 'qwen')
      throw new Error(`unknown provider "${provider ?? ''}" for ${feature}`);
    out.set(feature as AiFeature, provider);
  }
  return out;
}

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().default(4000),

    DATABASE_URL: z.string().min(1),
    /** Set to false when connecting through Supabase's transaction-mode pooler (port 6543). */
    DATABASE_PREPARE: bool(true),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    REDIS_URL: z.string().min(1),

    /** Public URL of the web app, used for links in emails and for CORS/Origin checks. */
    WEB_APP_URL: z.url(),
    /** Extra allowed origins, comma separated. WEB_APP_URL's origin is always allowed. */
    ALLOWED_ORIGINS: z.string().optional(),

    /** HMAC key for session-id hashing. Generate with: openssl rand -base64 48 */
    SESSION_SECRET: z.string().min(32),
    SESSION_IDLE_TTL_HOURS: z.coerce.number().positive().default(72),
    SESSION_ABSOLUTE_TTL_DAYS: z.coerce.number().positive().default(30),
    /** Defaults to true in production. Only disable for local http development. */
    COOKIE_SECURE: z.enum(['true', 'false']).optional(),
    /** Number of reverse proxies in front of the API (Vercel rewrite + host proxy, etc.). */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),

    ORG_SIGNUP_ENABLED: bool(true),
    ENABLE_API_DOCS: z.enum(['true', 'false']).optional(),

    DISCORD_CLIENT_ID: z.string().optional(),
    DISCORD_CLIENT_SECRET: z.string().optional(),
    /** Must match the redirect registered in the Discord developer portal. */
    DISCORD_REDIRECT_URI: z.url().optional(),

    MAIL_TRANSPORT: z.enum(['outbox', 'smtp']).default('outbox'),
    MAIL_FROM: z.string().optional(),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().optional(),
    SMTP_SECURE: z.enum(['true', 'false']).optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),

    /**
     * Exchange-rate provider. "frankfurter" (free, no key, historical rates, 200+ currencies incl.
     * SAR) or "none" (every non-reporting-currency transaction needs a manually typed rate).
     */
    FX_PROVIDER: z.enum(['frankfurter', 'none']).default('frankfurter'),
    FX_PROVIDER_URL: z.url().default('https://api.frankfurter.dev'),
    /** Chromium for PDF exports. Unset: the bundled @sparticuz/chromium build is used. */
    CHROMIUM_EXECUTABLE_PATH: z.string().optional(),

    /**
     * Anthropic API (Custom Clause Assistant, Phase 3; all assistants, Phase 5). Unset: the
     * assistant reports "not configured" and nothing else is affected. Never commit a real key.
     */
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_MODEL: z.string().min(1).default('claude-sonnet-5-5'),
    ANTHROPIC_API_URL: z.url().default('https://api.anthropic.com'),
    ANTHROPIC_TIMEOUT_MS: z.coerce.number().int().min(5000).max(600000).default(120000),
    /**
     * Let the research-capable assistants search the web (Anthropic web search tool). Off by
     * default (Phase 6): web search is billed per search, so it stays off until there's a budget.
     */
    ASSISTANT_WEB_SEARCH: z.enum(['on', 'off']).default('off'),

    /**
     * Phase 6: a second AI provider. Qwen3 (open weights, Apache 2.0) through a hosted
     * OpenAI-compatible inference API — DeepInfra by default (see DECISIONS.md for the choice).
     * Unset key: Qwen is "not configured" and anything routed to it says so.
     */
    QWEN_API_KEY: z.string().optional(),
    QWEN_MODEL: z.string().min(1).default('Qwen/Qwen3-235B-A22B-Instruct-2507'),
    QWEN_API_URL: z.url().default('https://api.deepinfra.com/v1/openai'),
    QWEN_TIMEOUT_MS: z.coerce.number().int().min(5000).max(600000).default(120000),
    /** Which provider answers by default: anthropic (default) or qwen. */
    AI_PROVIDER_DEFAULT: z.enum(['anthropic', 'qwen']).default('anthropic'),
    /**
     * Per-feature overrides, e.g. "player_analyst=qwen,email=qwen". Features: clause_assistant,
     * general, formal_message, email, offer_optimizer, player_analyst.
     */
    AI_PROVIDER_OVERRIDES: z.string().optional(),

    // ---------- Phase 6: meetings and integrations ----------

    /** How often reminders and integration jobs are processed. 0 turns the scheduler off. */
    SCHEDULER_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(3600).default(30),
    /**
     * Public URL at which outside services reach this API (webhooks, Google push
     * notifications). Defaults to WEB_APP_URL + "/api" (the Next.js proxy).
     */
    PUBLIC_API_URL: z.url().optional(),
    /** Key for encrypting integration secrets. Unset: derived from SESSION_SECRET (HKDF). */
    INTEGRATIONS_ENCRYPTION_KEY: z.string().min(32).optional(),
    /** Google Calendar OAuth app (all three or none). Redirect: <web>/api/integrations/google/callback */
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GOOGLE_REDIRECT_URI: z.url().optional(),
    GOOGLE_API_URL: z.url().default('https://www.googleapis.com'),
    GOOGLE_TOKEN_URL: z.url().default('https://oauth2.googleapis.com/token'),
    GOOGLE_AUTH_URL: z.url().default('https://accounts.google.com/o/oauth2/v2/auth'),
    NOTION_API_URL: z.url().default('https://api.notion.com'),
    NOTION_VERSION: z.string().default('2026-03-11'),
    /**
     * Outgoing webhooks to private/loopback addresses are refused (SSRF). Only for local
     * development and tests.
     */
    WEBHOOK_ALLOW_PRIVATE_URLS: bool(false),
    INTEGRATIONS_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(20000),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.MAIL_TRANSPORT === 'outbox') {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_TRANSPORT'],
        message:
          'The outbox mail transport stores reset links in plain text and is not allowed in production. Configure SMTP.',
      });
    }
    if (env.MAIL_TRANSPORT === 'smtp' && (!env.SMTP_HOST || !env.MAIL_FROM)) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMTP_HOST'],
        message: 'MAIL_TRANSPORT=smtp requires SMTP_HOST and MAIL_FROM.',
      });
    }
    const discordVars = [
      env.DISCORD_CLIENT_ID,
      env.DISCORD_CLIENT_SECRET,
      env.DISCORD_REDIRECT_URI,
    ];
    const googleVars = [env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REDIRECT_URI];
    if (googleVars.some(Boolean) && !googleVars.every(Boolean)) {
      ctx.addIssue({
        code: 'custom',
        path: ['GOOGLE_CLIENT_ID'],
        message:
          'Google Calendar needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI together.',
      });
    }
    try {
      parseProviderOverrides(env.AI_PROVIDER_OVERRIDES);
    } catch (e) {
      ctx.addIssue({
        code: 'custom',
        path: ['AI_PROVIDER_OVERRIDES'],
        message: `AI_PROVIDER_OVERRIDES: ${(e as Error).message}. Use e.g. "player_analyst=qwen,email=anthropic".`,
      });
    }
    if (env.NODE_ENV === 'production' && env.WEBHOOK_ALLOW_PRIVATE_URLS) {
      ctx.addIssue({
        code: 'custom',
        path: ['WEBHOOK_ALLOW_PRIVATE_URLS'],
        message: 'Webhooks to private addresses are not allowed in production.',
      });
    }
    if (discordVars.some(Boolean) && !discordVars.every(Boolean)) {
      ctx.addIssue({
        code: 'custom',
        path: ['DISCORD_CLIENT_ID'],
        message:
          'Discord login needs DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET and DISCORD_REDIRECT_URI together.',
      });
    }
  });

export type Env = z.infer<typeof envSchema> & {
  cookieSecure: boolean;
  apiDocsEnabled: boolean;
  discordEnabled: boolean;
  googleEnabled: boolean;
  allowedOrigins: string[];
  /** Where outside services call this API (no trailing slash). */
  publicApiUrl: string;
};

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  // `KEY=` in a .env file means "not set" (so optional values fall back to their defaults).
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, v]) => v !== undefined && v.trim() !== ''),
  );
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;
  const webOrigin = new URL(env.WEB_APP_URL).origin;
  const extra = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => new URL(s).origin);
  return {
    ...env,
    cookieSecure:
      env.COOKIE_SECURE !== undefined
        ? env.COOKIE_SECURE === 'true'
        : env.NODE_ENV === 'production',
    apiDocsEnabled:
      env.ENABLE_API_DOCS !== undefined
        ? env.ENABLE_API_DOCS === 'true'
        : env.NODE_ENV !== 'production',
    discordEnabled: !!(
      env.DISCORD_CLIENT_ID &&
      env.DISCORD_CLIENT_SECRET &&
      env.DISCORD_REDIRECT_URI
    ),
    googleEnabled: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI),
    allowedOrigins: [...new Set([webOrigin, ...extra])],
    publicApiUrl: (env.PUBLIC_API_URL ?? `${env.WEB_APP_URL.replace(/\/$/, '')}/api`).replace(
      /\/$/,
      '',
    ),
  };
}

export const ENV = Symbol('ENV');
