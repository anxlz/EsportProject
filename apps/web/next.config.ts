import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

/**
 * The browser only ever talks to this app's own origin, at `/api/*`, which keeps the session
 * cookie first-party (HttpOnly, SameSite=Lax, __Host- prefixed in production).
 *
 * - On Vercel (one project, `web` and `api` services; see vercel.json) the platform routes
 *   `/api/*` to the API service before requests reach Next.js, so no rewrite is needed here.
 * - Everywhere else (local `bun run dev:web`, the API on Railway/Fly.io/Docker) Next.js proxies
 *   `/api/*` to API_URL, stripping the `/api` prefix — the same path the API sees on Vercel.
 */
const onVercel = process.env.VERCEL === '1';
const apiUrl = process.env.API_URL ?? 'http://localhost:4000';

const nextConfig: NextConfig = {
  transpilePackages: ['@esports/shared'],
  poweredByHeader: false,
  async rewrites() {
    return onVercel ? [] : [{ source: '/api/:path*', destination: `${apiUrl}/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // Invitation and reset links carry tokens in the URL; never leak them cross-origin.
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
