# Esports Organization Management Platform

Multi-tenant platform for running esports organizations: people, custom roles with team and
department scoping, teams and games (Phase 1), followed by accounting and investment analysis,
contracts with approvals and e-signatures, bilingual AI assistants, meetings and integrations.

**Status: Phase 2 (Accounting & Investment Analysis) complete.** See
[`docs/PHASE-2-SUMMARY.md`](docs/PHASE-2-SUMMARY.md) and
[`docs/PHASE-1-SUMMARY.md`](docs/PHASE-1-SUMMARY.md) for what was built and what's deferred,
[`DECISIONS.md`](DECISIONS.md) for technical decisions and open questions, and
[`docs/PERMISSIONS.md`](docs/PERMISSIONS.md) for the generated permission matrix.

## Repository layout

```
apps/api         NestJS 12 on Bun. REST API, auth, authorization, all business logic.
  src/authz        Permission resolution, guards, scope filters (the core security layer)
  src/auth         Sessions, sign-in, password recovery, Discord OAuth
  src/db           Drizzle schema, migration runner     drizzle/  SQL migrations
  src/finance      Ledger, exchange rates, budgets + alerts, reports, exports (PDF/CSV/XLSX/TXT)
  src/rosters      Team rosters and pay terms         src/tournaments  Tournament research
  test/            Integration tests (real Postgres + Redis) and unit tests
apps/web         Next.js 16 dashboard, Arabic/English with right-to-left support
packages/shared  Permission catalog, request schemas, response types (used by both apps)
  src/finance      Money math, payroll projection, the report engine and export table model
docs/            Phase summaries and the generated permission matrix
```

## Local development

Prerequisites: [Bun](https://bun.sh) 1.4+, plus Postgres 16 and Redis 7 (the included
`docker-compose.yml` starts both, with an `esports_test` database for the test suite).

```bash
bun install
docker compose up -d                       # or use your own Postgres + Redis

cp apps/api/.env.example apps/api/.env     # then fill in DATABASE_URL, REDIS_URL, SESSION_SECRET
cp apps/web/.env.example apps/web/.env.local

bun run db:migrate
bun run dev:api                            # http://localhost:4000  (API docs at /docs)
bun run dev:web                            # http://localhost:3000
```

For local development with docker compose, these values work in `apps/api/.env`:

```
DATABASE_URL=postgres://postgres:devpass@127.0.0.1:5432/esports_dev
REDIS_URL=redis://127.0.0.1:6379/0
SESSION_SECRET=<output of: openssl rand -base64 48>
COOKIE_SECURE=false
MAIL_TRANSPORT=outbox
```

Open http://localhost:3000, choose **Create one** to register the first organization. In
development, invitation and reset emails are printed to the API console and stored in
`app.dev_outbox`; the invite dialog also shows the link to copy.

### Platform admin

Platform (super) admins are granted from the command line only:

```bash
bun run --cwd apps/api platform-admin grant you@example.com
bun run --cwd apps/api platform-admin list
```

## Checks

```bash
bun run lint            # ESLint (includes a rule against authorizing by role name)
bun run format:check    # Prettier
bun run typecheck       # all workspaces
bun run test            # shared + API integration tests + web catalog tests
```

API tests need Postgres and Redis. The PDF export test also needs Chromium (the bundled
`@sparticuz/chromium` is used unless `CHROMIUM_EXECUTABLE_PATH` points to one) and `pdftotext` /
`pdffonts` from poppler-utils. They default to
`postgres://postgres:devpass@127.0.0.1:5432/esports_test` and `redis://127.0.0.1:6379/1`; override
with `TEST_DATABASE_URL` / `TEST_REDIS_URL`. **They truncate that database**, so never point them at
real data. CI (`.github/workflows/ci.yml`) runs all of the above plus the web build.

`bun run docs:permissions` regenerates `docs/PERMISSIONS.md` after changing the catalog.

## Deployment

| Piece    | Where                    | Notes                                                                                                                     |
| -------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Web      | Vercel                   | Root directory `apps/web`. Set `API_URL` to the API's public URL.                                                         |
| API      | Railway or Fly.io        | Build with `apps/api/Dockerfile` **from the repo root**. Run `bun src/db/migrate.ts` as the release / pre-deploy command. |
| Database | Supabase Postgres        | Use the direct or session-pooler connection string; with the transaction pooler set `DATABASE_PREPARE=false`.             |
| Redis    | Upstash or Railway Redis | `rediss://` URL.                                                                                                          |

Production checklist:

1. Every variable in `apps/api/.env.example` marked REQUIRED is set; `SESSION_SECRET` freshly
   generated; `COOKIE_SECURE` left unset (defaults on).
2. `WEB_APP_URL` is the exact public web URL.
3. `MAIL_TRANSPORT=smtp` with a provider (the API refuses to start in production with the outbox).
4. `TRUST_PROXY_HOPS` matches the real number of proxies; check the audit log shows real client
   IPs after the first sign-in.
5. `ORG_SIGNUP_ENABLED=false` once your own organization exists, unless you want public signup.
6. Exchange rates: the Frankfurter terms are reviewed (or `FX_PROVIDER=none`), and the API can
   reach `FX_PROVIDER_URL`.
7. The API image includes Chromium for PDF exports (the Dockerfile installs it); try one PDF
   download after deploying.

The browser only talks to the web origin; Next.js forwards `/api/*` to the API, which keeps the
session cookie first-party. Don't expose the API's own URL to users.
