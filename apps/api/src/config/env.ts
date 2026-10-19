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
    /** Let the research-capable assistants search the web (Anthropic web search tool). */
    ASSISTANT_WEB_SEARCH: z.enum(['on', 'off']).default('on'),
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
  allowedOrigins: string[];
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
    allowedOrigins: [...new Set([webOrigin, ...extra])],
  };
}

export const ENV = Symbol('ENV');
