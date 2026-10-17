# Technical decisions

A living record of decisions made during implementation that the implementation prompt did not
already specify. Newest phase at the bottom of each section. Each entry says what was decided,
why, and whether it is easy to reverse.

## Decisions taken with the user (Phase 1, 15 Oct 2026)

| Topic                                      | Decision                                                                                                                                                        |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account provisioning (§3.4 "ASK THE USER") | Invitation-based provisioning **and** member suspension in v1. **MFA deferred to v2.** Self-service signup only creates a _new_ organization (its first Owner). |
| Interface language                         | Arabic + English with right-to-left layout from Phase 1 (not only the AI assistants).                                                                           |
| Delivery                                   | Built in the Claude workspace and delivered as a zip per phase (no GitHub repo yet).                                                                            |

## Decisions taken with the user (Phase 2, 16 Oct 2026)

| Topic                  | Decision                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Shared services        | Accounting reuses the Phase 1 audit log, notification service and permission/scope guards; no parallel versions.               |
| Versioning service     | Stays in Phase 3 (contracts); Phase 2 does not need it.                                                                        |
| Production credentials | Still outstanding (SMTP, Supabase, Redis, SESSION_SECRET, Discord OAuth, hosting). Phase 2 is built against local equivalents. |
| Tax                    | Fields present but inert; no calculation logic (spec §6.7).                                                                    |

## Still open — needs your input

| Topic                           | Needed by                     | Notes                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Email provider (SMTP)           | Before production             | Invitations and password-reset emails need one. The code is provider-neutral SMTP (Resend, Postmark, Amazon SES, Mailgun, Brevo all offer SMTP). Until configured, Owners can still copy invitation links from the UI; password reset will not work in production.                                                                                                      |
| Railway vs Fly.io               | Deployment                    | Dockerfile is portable to both (and AWS).                                                                                                                                                                                                                                                                                                                               |
| Supabase project + environments | Deployment                    | Whether you want separate dev/staging/prod projects pre-launch.                                                                                                                                                                                                                                                                                                         |
| Discord OAuth app               | When you want Discord sign-in | Client id/secret + redirect URL; feature is fully built and hidden until configured.                                                                                                                                                                                                                                                                                    |
| Product name                    | Any time                      | "Club Manager / إدارة النادي" is a placeholder in `apps/web/src/messages/*.json` (`app.name`).                                                                                                                                                                                                                                                                          |
| Frankfurter terms               | Before production             | Phase 2 uses Frankfurter for exchange rates (no API key). Its documentation describes the rates as free to use, but its licence page could not be opened from the build environment, so the terms have **not** been reviewed. Please confirm they fit commercial use, or name another provider (the adapter is one file). `FX_PROVIDER=none` turns automatic rates off. |
| Docker image with Chromium      | Deployment                    | PDF export needs Chromium. The Dockerfile now installs Debian's `chromium`; the container could not be built here (no Docker daemon), so build it once before deploying. PDF rendering itself is tested against both the bundled and a standard Chromium build.                                                                                                         |

## Stack and runtime

- **Monorepo with Bun workspaces**: `apps/api` (NestJS), `apps/web` (Next.js), `packages/shared`
  (permission catalog, validation schemas, response types shared by both). Easy to reverse.
- **NestJS 12** (current major, released Aug 2026, ESM). Verified on Bun 1.4 before adoption:
  dependency injection with decorator metadata, guards, Swagger all work.
- **Bun reads `tsconfig.json` from the working directory.** The API's tsconfig enables the legacy
  decorators NestJS needs, so the API must always be started from `apps/api` (the Dockerfile sets
  `WORKDIR /app/apps/api`). Starting it from the repo root crashes on the first decorator — found
  while simulating the container image.
- **TypeScript pinned to 5.9.3.** TypeScript 7 (the native port) is the npm `latest` but its
  support for `experimentalDecorators`/`emitDecoratorMetadata` was not verified; NestJS depends on
  both. Revisit when upgrading.
- **Next.js 16** (Turbopack by default; `middleware.ts` renamed `proxy.ts`). Read from the version's
  bundled docs, not from memory.

## Data layer

- **Drizzle ORM + postgres.js**, SQL migrations generated into `apps/api/drizzle` and applied by
  `bun run db:migrate` (never `drizzle-kit push`). Hand-written migrations sit alongside generated
  ones (e.g. `0001_security_hardening.sql`).
- **All tables live in a Postgres schema named `app`, not `public`.** On Supabase, `public` is exposed
  through the auto-generated REST API to anyone holding the public anon key. In addition, RLS is
  enabled on every table with no policies, and `anon`/`authenticated` lose all access to the schema.
  The API connects as the table owner and enforces tenancy in code. A test fails if any table in
  `app` lacks RLS, so future migrations can't forget it.
- **Composite foreign keys `(organization_id, id)`** between tenant-owned tables, so the database
  itself rejects cross-tenant references (tested by inserting one directly).
- **Supabase Auth is not used.** Spec requires Redis-backed revocable sessions and custom RBAC;
  Supabase is used for Postgres (and Storage from Phase 3).
- Supabase transaction pooler (port 6543) needs `DATABASE_PREPARE=false`.

## Authentication and sessions

- Opaque 256-bit session id in an HttpOnly cookie; Redis key is `HMAC(SESSION_SECRET, id)`.
  Idle timeout 72 h (sliding), absolute lifetime 30 days. New session id on every sign-in.
- Cookie is `SameSite=Lax`, `Secure` and `__Host-` prefixed in production.
- **The browser never calls the API origin directly.** Next.js rewrites `/api/*` to the API, so the
  cookie is first-party on the web domain and no cross-site cookie or CORS setup is needed between
  Vercel and Railway/Fly.io. Discord's redirect URL therefore points at the web app
  (`https://<web>/api/auth/discord/callback`).
- CSRF: SameSite=Lax plus an Origin allow-list check on every state-changing request.
- Passwords: Argon2id via Bun's built-in implementation (no native addon). Unknown-email logins
  still run a hash comparison so timing doesn't reveal which emails exist. Minimum 10 characters,
  no composition rules.
- Password reset: single-use, 60-minute tokens stored as SHA-256 hashes; issuing a new link
  invalidates older ones; completing a reset signs the user out everywhere.
- **Email verification at org signup is not implemented** in v1 (not in the spec). Invited users
  prove their email by using the link.
- Rate limits (Redis, shared across instances): login 30/15 min per IP and 10/15 min per email;
  signup 5/hour per IP; forgot-password 10/hour per IP and 3/hour per email; token pages 30/15 min
  per IP. `TRUST_PROXY_HOPS` must match the real proxy count in production or limits key on the
  proxy's IP — verify after the first deployment.
- **Discord**: sign-in only works for accounts that already linked Discord from Settings. There is
  deliberately **no auto-linking by matching email** (an email match is not proof of ownership).
  OAuth `state` is single-use, consumed on any attempt, and bound to the starting browser by a
  nonce cookie (prevents login CSRF). Accepting an invitation creates a password account; Discord
  can be linked afterwards.

## Authorization model

- **Permission keys are the only thing code checks.** The catalog lives in
  `packages/shared/src/permissions.ts`; `docs/PERMISSIONS.md` is generated from it (and a test fails
  if it's stale). An ESLint rule rejects comparisons against role names or template keys in
  non-test code.
- The catalog grows per phase: a permission is added only when the resource it protects exists.
- **Scopable vs organization-level permissions.** Scopable ones (`teams.*` now; rosters, finance,
  contracts later) are narrowed by the assignment's team/department scope. Organization-level ones
  apply organization-wide whenever the role is held, even if the assignment is scoped. The access
  editor shows a warning listing those permissions when someone picks a scoped assignment.
- **A department scope covers every team in that department.** Creating a team (or moving one)
  requires the permission to cover the _destination_ department; "no department" requires an
  organization-wide grant.
- **Out-of-scope records return 404, not 403**, so their existence isn't revealed. Visible but not
  writable returns 403.
- **Owner-only permissions** (`roles.manage`, `members.invite`, `members.manage`,
  `org.ownership.manage`, `org.settings.edit_sensitive`) can never be put on a custom role — checked
  by the request schema, the service, and again when permissions are resolved. Reason: anyone who
  can edit roles or assign them could otherwise grant themselves everything. These can be made
  delegatable later with an explicit "can only grant what you hold" rule.
- **Owner** is a locked system role with `grants_all`; one per org (DB unique index). Multiple
  people can hold it. Ownership has its own endpoints (never via ordinary assignment edits), and the
  last active Owner can't be removed or suspended — enforced under a row lock so two Owners can't
  remove each other concurrently.
- Resolved permissions are cached in Redis keyed by an organization "version" that every role,
  assignment or membership change bumps; tests assert changes apply on the very next request.
- **Platform admins** are a separate table, granted only via CLI (`bun run platform-admin grant`).
  No HTTP endpoint creates one; being one grants nothing inside a tenant. Phase 1 platform
  endpoints are read-only and every look at a tenant is written to that tenant's audit log.

## Shared services

- **Audit log**: one append-only table (UPDATE/DELETE blocked by a trigger), written in the same
  transaction as the change it records. Security events before sign-in have no organization.
- **Notifications**: stored as `type` + structured `data`, rendered by the web app in the reader's
  language. In-app only, polled every 30 s. `notifyPermissionHolders()` resolves recipients by
  permission and team (ready for budget alerts and approvals).
- **Mail**: provider-neutral SMTP; a dev/test "outbox" transport writes to a table and is refused at
  startup in production because it stores reset links in plain text. Emails are bilingual.
- **Versioning service** (spec §3.3) is scheduled for Phase 3 with contracts, its first consumer.

## Interface

- **next-intl with a cookie-based locale** (no `/ar` `/en` URL prefixes). The user's choice is saved
  to their profile and re-applied at sign-in on any device.
- **Translation keys containing dots are nested** in the JSON (`permissions.teams.view` →
  `permissions → teams → view`); next-intl treats dots as nesting. A test renders every
  permission/error/notification/audit label in both languages and fails on raw keys.
- **RTL** via `<html dir>` and logical CSS properties throughout (`ms-`, `pe-`, `start-`, `end-`).
  Emails and slugs are isolated as left-to-right runs inside Arabic text.
- **Dates**: Gregorian calendar and Western digits in both languages (`ar-SA` alone would default to
  the Hijri calendar). Reversible in `apps/web/src/lib/format.ts`.
- **Fonts**: IBM Plex Sans + IBM Plex Sans Arabic, self-hosted from npm (no Google Fonts request at
  build or run time).
- Validation schemas are shared; the web app uses them only for earlier feedback. OpenAPI is
  generated from the same zod schemas via zod 4's `z.toJSONSchema` (the `nestjs-zod` package does
  not support NestJS 12 yet).
- CSV exports prepend a UTF-8 BOM (Arabic opens correctly in Excel) and neutralise cells starting
  with `= + - @` (spreadsheet formula injection).

## Compliance wording

- Per spec §7.8 and §17, the product makes no compliance claims. Settings shows a quiet note
  recommending confirmation with the Saudi Esports Federation or legal counsel before relying on
  in-platform contracts for player registration.

## Accounting and investment analysis (Phase 2)

**Money and currencies**

- Amounts are decimal strings end to end (NUMERIC in Postgres, `decimal.js` in code, 40 digits,
  half-up rounding); floats never touch money. Amounts store up to 4 decimals, rates 12.
- Each organization has one **reporting currency** (default USD) and a list of enabled currencies
  (default USD + SAR). Every record keeps its own currency; its converted amount is rounded **once**,
  to the reporting currency's minor unit (ISO 4217: 3 for KWD/BHD/OMR/JOD, 0 for JPY/KRW).
- The reporting currency **locks once any cost, revenue or budget exists**, because changing it
  would silently change every stored conversion. Reversible only by a deliberate data migration.

**Exchange rates (spec §5)**

- Provider: **Frankfurter v2** (`/v2/rates?base&quotes&date`): no API key, historical rates by date,
  includes SAR. ExchangeRate-API's open endpoint was rejected (no historical rates). Behind an
  injection token, so swapping providers is one adapter; tests use a fake and never call out.
- **Snapshot on write.** Each record stores the rate, the rate's date and its source
  (`same_currency`, `provider` or `manual`). Reports use the stored rate forever, so reopening a
  report gives the same numbers. Provider answers are cached per pair and requested date in
  `app.fx_rates` (market data, not tenant data).
- No rate known (provider down, unsupported pair) → the API refuses the record with
  `fx_rate_required` and the form asks for the rate. A rate is **never guessed**.
- Future-dated records (expected income) use today's rate; the stored rate date says so. Weekend
  dates take the provider's previous trading day, recorded as the rate date.
- Editing keeps the stored rate unless the currency or date changes, or a rate is typed.
- "Today's rates" on the report is a comparison view only; currencies without a current rate keep
  their stored rate and the report says which.

**Scope and permissions**

- Hierarchy: organization-wide (no team) → team → player/staff member (team + roster member). The
  database enforces that the person belongs to that team.
- Finance permissions are scopable by team/department like `teams.*`. A team-scoped user never sees
  organization-wide records, and organization/tournament/season reports require organization-wide
  `finance.view`, so nobody gets a silently partial total.
- Pay terms live on the roster member: visible with `finance.view` on the team, changeable only with
  `finance.edit` there. Roster details alone need `rosters.*`. Moving someone between teams is done
  by marking them as left and re-adding them, so cost history stays with the team that incurred it.
- Default role templates gained the Phase 2 permissions (Esports Operations: rosters and tournaments,
  no pay). Migration `0003` adds them to existing organizations' template-derived roles (adds only,
  never removes what an Owner configured); a test checks the migration matches the templates.

**What the numbers mean**

- **Realized only.** Revenue counts in totals, monthly results and break-even only once received.
  Expected income (certain or uncertain) is listed separately as projections.
- **No ROI score** (spec §6.4): reports show costs, realized revenue and their difference, by
  category, team and month, with every input listed.
- **Break-even month** = the first month, from the first month with costs, **from which** the
  cumulative result stays at or above zero through the latest month. Changed during Phase 2 visual
  QA: with the simpler "first month ≥ 0", sample data with a sponsorship paid up front in January showed a one-month
  payback while the organization was 53k in the red. **Payback** counts months inclusively.
- **Scenarios** (pessimistic / base / optimistic) start from the organization's own data only — no
  invented growth rates: trailing 3 full months of realized revenue and non-salary costs, plus
  payroll projected from roster pay terms; certain expected income as a one-off in all scenarios,
  uncertain only in optimistic. Every input is editable; saved inputs are shared per report scope
  (`finance.edit`) and flagged as edited. Exports carry whatever is on screen, saved or not.
- **Payroll projection** converts pay to a monthly equivalent (weekly ×52/12, biweekly ×26/12,
  quarterly ÷3, yearly ÷12), uses off-season pay outside configured seasons, and leaves out
  per-event/one-time pay and pay in currencies without a current rate — both footnoted.
- **Seasons** never overlap; records are assigned to a season by date (or explicitly), and
  reassigned when season dates change.
- **Tax fields** (amount, jurisdiction) are stored and shown, never summed or calculated; every
  report carries that statement (spec §6.7).

**Budgets and alerts**

- A budget can target a team, tournament, season and/or date range; an empty filter doesn't
  restrict (a budget without a team covers the whole organization). Planned amounts are in the
  reporting currency, with optional per-category limits.
- When the total or a category limit goes over plan, everyone whose `finance.view` covers the budget
  gets **one** notification (shared NotificationService) and the event is audited as
  `budget.exceeded` (actor: system). It re-arms when spending is back within plan or the planned
  amount changes. A conditional update makes the alert fire once even under concurrent writes.

**Reports and exports**

- One engine in `packages/shared` builds the report; the API, the dashboard's live scenario
  recompute and all four exports use it, and every export renders the same table model
  (`reportDocument`). Tests compare each format against the JSON report.
- CSV: report sections in order, plain decimals and ISO dates, UTF-8 BOM. XLSX: one sheet per
  section, real numbers with currency formats, right-to-left sheets in Arabic (Excel stores
  numbers as doubles; exact below ~15 significant digits). TXT: formatted exactly like the screen.
  PDF: headless Chromium with IBM Plex embedded; the page can't make network requests.
- Dates in finance views use the same formatter as the exports ("15 Sep 2026", Western digits,
  Gregorian calendar).

**Tournament research**

- Manual entry only (no scraping, spec §6.5). Each record has a source link (http/https only) and a
  last-checked date; the list flags research older than 90 days as possibly out of date.

**Charts**

- Hand-built SVG (no chart library): one y-axis per chart, legends plus hover/keyboard tooltips,
  a table view of the monthly data. Series colors are categorical slots 1–3 of the data-viz
  reference palette, run through its validator against the app's light (`#ffffff`) and dark
  (`#1b2321`) panels: all checks pass; the light aqua slot is below 3:1 contrast, so the scenario
  chart always has a legend, end labels and the scenario table. Time runs left to right in both
  languages.

**Fixes to Phase 1 found along the way**

- Drizzle wraps Postgres errors and keeps the SQLSTATE on `cause`, so Phase 1's "unique violation →
  409" safety net never fired. The exception filter now unwraps it, and maps "still referenced"
  foreign-key errors to `409 in_use` (e.g. deleting a team that has costs). Unit-tested.
- CSV cells that are plain negative numbers (`-500.00`) are no longer prefixed as formulas.

**Deferred from Phase 2** — generating salary costs automatically from roster pay terms (payroll is
projected for scenarios but posted by hand), recurring-entry automation, CSV import, multi-currency
budgets, and tax calculation (spec §6.7).
