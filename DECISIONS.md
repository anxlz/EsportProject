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

## Decisions taken with the user (Phase 3, 17 Oct 2026)

| Topic                      | Decision                                                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exchange-rate provider     | **Frankfurter approved** by the user: its FAQ confirms free commercial use, data from the ECB and 104 other central banks/official sources, open source. No provider switch.                      |
| Network access             | The API host may rely on `https://api.frankfurter.dev` (confirmed by the user).                                                                                                                   |
| Default reporting currency | The user left SAR or USD to me; I picked **SAR** for new organizations (SAR + USD enabled), because the organizations are Saudi. Existing organizations keep their setting.                       |
| Saudi riyal sign           | The user asked for the official sign ⃁ (U+20C1) instead of "SAR" wherever an amount is shown, with plain "SAR" as the fallback if a font lacks the glyph. See "Saudi riyal sign" under Interface. |
| Reuse                      | Contracts reuse the audit log, notification service and permission/scope guards; the version history, file store and PDF engine are new shared services.                                          |
| Production credentials     | Still outstanding; Phase 3 is built against local equivalents (see below). The Anthropic API key joins the list.                                                                                  |

## Decisions taken with the user (Phase 4, 17 Oct 2026)

| Topic                                           | Decision                                                                                                                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic API key                               | To use any AI feature                                                                                                                                                                 | Not a blocker. Set `ANTHROPIC_API_KEY` on the API (optional `ANTHROPIC_MODEL`, default `claude-sonnet-5-5`). It powers the clause assistant and the five assistants unless they are routed to Qwen3. **The live API has never been called from here**; please run one live conversation per assistant first (spec §8.3). Web search is **off by default** since Phase 6 (`ASSISTANT_WEB_SEARCH=on` turns it on; it costs extra per search). |
| Qwen3 key (DeepInfra)                           | Only if you route anything to Qwen3                                                                                                                                                   | Not a blocker. `QWEN_API_KEY`, then `AI_PROVIDER_DEFAULT=qwen` or e.g. `AI_PROVIDER_OVERRIDES=player_analyst=qwen`. **Never called live from here** (tested against a stand-in). DeepInfra is US-hosted, as is Anthropic: check cross-border transfer rules for personal data (Saudi PDPL) before routing player data to either.                                                                                                            |
| Google OAuth app                                | To offer Google Calendar                                                                                                                                                              | Create an OAuth client, enable the Calendar API, set `GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI`. The `calendar.events` scope is sensitive: Google's app verification is needed before more than 100 users can connect. Until set, the Google card says it isn't set up. **Never called live** (tested against a stand-in).                                                                                                                      |
| Notion                                          | When an organization wants it                                                                                                                                                         | Nothing to set on the server; each organization pastes its own internal-integration secret. **Never called live** (tested against a stand-in).                                                                                                                                                                                                                                                                                              |
| `PUBLIC_API_URL`, `INTEGRATIONS_ENCRYPTION_KEY` | Deployment                                                                                                                                                                            | Public https URL for Google push notifications and webhooks (defaults to the web app's `/api` proxy), and a dedicated 32+ character key for stored integration secrets (otherwise derived from `SESSION_SECRET`, so rotating that would break stored secrets).                                                                                                                                                                              |
| Clause wording                                  | Proceed with the current placeholder text: **legal review happens outside this build** (confirmed by the user).                                                                       |
| Federation confirmation                         | Still unresolved. Phase 4 is built as specified (spec §7.8), with **no compliance claims** in product copy and a quiet note recommending confirmation with the Federation or counsel. |
| Production credentials                          | Still outstanding: SMTP, Supabase, Redis URL, `SESSION_SECRET`, hosting, Discord OAuth, product name, and now the Anthropic API key. Phase 4 is built against local stand-ins.        |

## Decisions taken with the user (Phase 5, 18 Oct 2026)

| Topic                  | Decision                                                                                                                                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How to build and test  | Same approach as the clause assistant: all five assistants built and tested against a **fake provider** behind the existing provider interface. **No live Anthropic call has been made**; the summary separates fake-only from exercised. |
| Anthropic API key      | Still not available; it blocks nothing. Without it every assistant page says it isn't set up and nothing can be sent.                                                                                                                     |
| Section 8 hard rules   | Carried forward as stated: proposal-only, the invoking user's own permissions, citations + confidence labels + anti-fabrication on tool use, a tool-call log, Arabic/English per conversation.                                            |
| Production credentials | Still outstanding: SMTP, Supabase, Redis URL, `SESSION_SECRET`, hosting, Discord OAuth, product name, Anthropic API key. Legal review and Federation confirmation stay outside this build.                                                |

## Decisions taken with the user (Phase 6, 20 Oct 2026)

| Topic                  | Decision                                                                                                                                                                                                                                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Meetings               | Managers create meetings directly (no approval); invitees confirm or decline; the Owner calls organization-wide administrative meetings. Recurring meetings are required (frequency + end condition). Reminders reuse the notification service.                                                                               |
| Integrations           | Google Calendar, Notion, Obsidian and generic webhooks (incoming and outgoing). Two-way sync by default with a push-only switch per integration; real conflict resolution, duplicate prevention and retries. Every incoming webhook must be authenticated. Obsidian's real integration method had to be checked, not assumed. |
| Second AI provider     | Qwen3 (Apache 2.0) through hosted inference, the host chosen on actual pricing and availability. The deployer picks the provider per assistant or globally. **Anthropic stays the default**; Qwen3 is an alternative, not a replacement. Same guardrails for both.                                                            |
| Web search             | `ASSISTANT_WEB_SEARCH=off` by default (carried forward).                                                                                                                                                                                                                                                                      |
| Production credentials | Still outstanding: SMTP, Supabase, Redis URL, `SESSION_SECRET`, hosting (Railway vs Fly.io), Discord OAuth (optional), product name, Anthropic API key, and now a Qwen3 hosted-inference key. Built against local stand-ins. Legal review and Federation confirmation stay outside this build.                                |

## Decisions taken with the user (ID-document patch, 20 Oct 2026)

| Topic                  | Decision                                                                                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Requirement            | Before signing, the **recipient** uploads a photo or scan of a passport or national/government ID; it becomes part of the signing round's record. **Not** asked of a guardian co-signer (extending it to guardians would be a separate decision). |
| Access                 | Narrower than the contract: the Owner plus whoever is explicitly granted `contracts.view_signer_id`. Seeing, approving or exporting the contract does not include it. Every **view** is audited, not just the upload.                             |
| Storage                | The existing file store, as a separate file linked to the signing round; never merged into the contract PDF pages. Validated by its bytes (image or PDF).                                                                                         |
| AI boundary            | Never sent to any AI assistant, nor anything derived from it.                                                                                                                                                                                     |
| Claims                 | No compliance claim: it strengthens the identity record; it is not a certified or legally guaranteed check.                                                                                                                                       |
| Retention and deletion | **Not decided in code** — an open question for the product owner (below).                                                                                                                                                                         |

## Still open — needs your input

| Topic                              | Needed by                           | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Email provider (SMTP)              | Before production                   | Invitations, password-reset emails and (Phase 4) emailed signing codes need one. The code is provider-neutral SMTP (Resend, Postmark, Amazon SES, Mailgun, Brevo all offer SMTP). Until configured, Owners can still copy invitation links, and signers can use access codes; password reset will not work in production.                                                                                                                          |
| Railway vs Fly.io                  | Deployment                          | Dockerfile is portable to both (and AWS).                                                                                                                                                                                                                                                                                                                                                                                                          |
| Supabase project + environments    | Deployment                          | Whether you want separate dev/staging/prod projects pre-launch.                                                                                                                                                                                                                                                                                                                                                                                    |
| Discord OAuth app                  | When you want Discord sign-in       | Client id/secret + redirect URL; feature is fully built and hidden until configured.                                                                                                                                                                                                                                                                                                                                                               |
| Product name                       | Any time                            | "Club Manager / إدارة النادي" is a placeholder in `apps/web/src/messages/*.json` (`app.name`).                                                                                                                                                                                                                                                                                                                                                     |
| Anthropic API key                  | To use any AI feature               | Not a blocker. Set `ANTHROPIC_API_KEY` on the API (optional `ANTHROPIC_MODEL`, default `claude-sonnet-5-5`). It powers the clause assistant and the five Phase 5 assistants. **The live API has never been called from here**; please run one live conversation per assistant first (spec §8.3). Web search is on unless an admin disabled it in the Claude Console; it costs extra per search (`ASSISTANT_WEB_SEARCH=off` turns it off here).     |
| ID document retention and deletion | Before collecting real ID documents | **Your decision.** How long signers' identity documents are kept (and replaced uploads), and whether a signer or the organization can ask for deletion. Until you decide, nothing is deleted: no automatic expiry, no delete button, and the database refuses deletes like the rest of the signing record. Whatever you choose is one migration plus a small admin action. Cross-border/PDPL considerations apply to where the database is hosted. |
| `DOCUMENT_ENCRYPTION_KEY`          | Deployment (required in production) | Encrypts identity documents at rest; the API won't start in production without it. Store it like a backup key: losing it makes the documents unreadable.                                                                                                                                                                                                                                                                                           |
| Contract wording review            | Before using real contracts         | Happening outside this build (confirmed in Phase 4). The default clause wording is sample text, not legal advice; "Governing law and disputes" is a placeholder. Owners can edit the templates. The signing consent statement (`consentText` in `packages/shared/src/contracts/i18n.ts`) is in the same position.                                                                                                                                  |
| Federation confirmation            | Before relying on signatures        | Whether the Saudi Esports Federation accepts in-platform electronic signatures (and guardian consent) for registration is unconfirmed. The product makes no claim either way.                                                                                                                                                                                                                                                                      |
| Docker image with Chromium         | Deployment                          | PDF export needs Chromium. The Dockerfile now installs Debian's `chromium`; the container could not be built here (no Docker daemon), so build it once before deploying. PDF rendering itself is tested against both the bundled and a standard Chromium build.                                                                                                                                                                                    |

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
- **Versioning service** (spec §3.3, Phase 3): one append-only table `entity_versions`
  (entity type + id + version number, full JSON snapshot, SHA-256 of the canonical JSON). UPDATE
  and DELETE are refused by a trigger; numbering is serialized with an advisory lock. Contracts are
  the first user; anything else that needs history can use `VersioningService` as is.
- **File store** (Phase 3): uploads and generated documents live in Postgres (`stored_files`,
  bytea, SHA-256, never updated). Supabase Storage would need credentials that don't exist yet,
  and the files are small (logo/stamp ≤ 2 MB, background ≤ 5 MB, contract PDFs ~100 KB). Uploads
  are typed by their bytes (PNG, JPEG, WebP, PDF; SVG refused because it can carry script) and must
  match the declared type. One service touches the table, so moving to object storage is one
  adapter. Reversible.
- **PDF engine** (Phase 3): the Phase 2 Chromium renderer became a shared `PdfService` used by
  finance reports and contracts, plus a full-page underlay (PNG/JPEG image or the first page of a
  PDF) composited beneath every page with pdf-lib. pdf-lib cannot read WebP, so backgrounds are
  PNG/JPEG/PDF only.

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
- **Saudi riyal sign (Phase 3, at the user's request).** Amounts in SAR read "⃁ 1,250.00": the
  official sign U+20C1 (Unicode 17.0), to the left of the number with a space in both languages,
  as SAMA's FAQ specifies; inside an LTR isolate so it stays left of the digits in Arabic text.
  - Fonts checked for U+20C1 (cmap, with fontTools): IBM Plex Sans 5.3.0 and IBM Plex Sans Arabic
    5.3.0 (our fonts) — **no glyph**; also Noto Sans, Noto Sans Arabic, Noto Sans Symbols 1/2,
    Noto Naskh Arabic, Noto Kufi Arabic, Cairo, Tajawal, Almarai, Readex Pro, Rubik, Inter
    (fontsource 5.3.0) — none. The build machine's only system font with it is GNU Unifont.
  - So a one-glyph font is bundled: `@emran-alhaddad/saudi-riyal-font` 1.1.0 (SIL OFL 1.1,
    embeddable), regular + bold, copied unmodified into `apps/web/public/fonts/saudi-riyal/` and
    `apps/api/assets/fonts/saudi-riyal/` with its licence; a test pins both copies by SHA-256. Its
    glyph was compared visually with SAMA's published symbol. It's declared as extra faces of the
    IBM Plex families with `unicode-range: U+20C1`, so it draws that one character only.
  - **Dashboard**: amounts switch from "SAR" to the sign only after the browser confirms the font
    has loaded for both families (`document.fonts.load` + `check`); if it doesn't load, they stay
    "SAR" — never a missing-glyph box. Verified with Chromium's DevTools protocol that the sign is
    drawn by the bundled face (`saudi_riyal`), in English and Arabic pages.
  - **PDFs** (finance reports, contracts): the font is embedded; `pdffonts` lists it and
    `pdftotext` extracts "⃁ 1,250.00" in English and Arabic (tested).
  - **CSV / TXT / XLSX keep "SAR"**: those files are opened in other software (Excel, editors)
    whose fonts we can't control, which is exactly the fallback case. Currency pickers and the
    "reporting currency" label also keep the ISO code; the sign replaces the code only next to an
    amount. Other currencies keep their ISO code.
- Validation schemas are shared; the web app uses them only for earlier feedback. OpenAPI is
  generated from the same zod schemas via zod 4's `z.toJSONSchema` (the `nestjs-zod` package does
  not support NestJS 12 yet).
- CSV exports prepend a UTF-8 BOM (Arabic opens correctly in Excel) and neutralise cells starting
  with `= + - @` (spreadsheet formula injection).

## Compliance wording

- Per spec §7.8 and §17, the product makes no compliance claims. Settings shows a quiet note
  recommending confirmation with the Saudi Esports Federation or legal counsel before relying on
  in-platform contracts for player registration. Phase 3 repeats it on the contract Document setup
  page, labels the default clause wording as a starting point that is not legal advice, and shows
  a non-legal-advice caveat with every Custom Clause Assistant output.
- Phase 4 puts the same quiet note on the Signatures tab (electronic signatures and a guardian's
  consent for players under 18 should be confirmed with the Federation or counsel). The statement
  signers agree to records identity, reading and consent to sign electronically; it does not say
  the signature is legally binding or compliant (a unit test checks the wording), and neither
  does the signature record page in the signed PDF.

## Accounting and investment analysis (Phase 2)

**Money and currencies**

- Amounts are decimal strings end to end (NUMERIC in Postgres, `decimal.js` in code, 40 digits,
  half-up rounding); floats never touch money. Amounts store up to 4 decimals, rates 12.
- Each organization has one **reporting currency** (default SAR since Phase 3; USD before) and a list
  of enabled currencies (default SAR + USD). Every record keeps its own currency; its converted amount is rounded **once**,
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

## Contracts (Phase 3)

**Types and templates**

- Four system types (Player, Coach, Manager, Staff) are seeded per organization, at signup and on
  first use for older organizations; each has its own clause list (e.g. only Player has content
  duties and the under-18 clause). They can be renamed and edited but not removed. Owners add custom
  types; a custom type used by a contract is archived, not deleted.
- Template editing (types, clause order, required/optional, wording) is Owner-only
  (`contracts.manage_templates`, never grantable). A template change affects future contracts only:
  every contract keeps its own copy of the clauses.
- Default clause wording is sample text written for this build (not taken from any law or other
  template), clearly labeled as needing legal review; "Governing law and disputes" is a placeholder.

**Drafting**

- A draft copies the type's template; recipient details are prefilled from a roster member, and pay
  currency from the reporting currency. Numbers are `CT-<year>-<0001>` per organization.
- Per contract (`contracts.create` for one's own drafts, `contracts.edit` for any in scope):
  optional clauses can be left out or removed, wording can change, custom clauses can be added.
  Required clauses can't be left out or removed. A clause's origin and required flag always come
  from the stored version, never from the request, so they can't be forged.
- Template clauses reworded in a contract are flagged to the approver ("Reworded"), compared with
  the version first drafted from the template.
- Merge fields (`{{recipientName}}`, `{{salary}}`, …) fill clause text from the details. A field
  with no value shows as a highlighted "missing" marker in the preview and **blocks submission**,
  as do missing clause text for a document language, the recipient's name and the start date.
- Documents can be bilingual (English and Arabic side by side, the default), Arabic only or
  English only.

**Versions and approval (spec §7.6)**

- Every save is a new immutable version; saving with no change creates none. Each approval request
  points at the exact version submitted, so every attempt keeps its decision, reviewer, time and
  comment.
- States: draft → awaiting approval → changes requested (after a rejection) → awaiting approval →
  approved; drafts can be cancelled; a pending request can be withdrawn. One open request per
  contract (unique index). Editing is locked while a request is open.
- **Rejection needs a reason** (≥ 3 characters), enforced by the API and by a database check.
- **Resubmission needs a change**: submitting the same version that was rejected is refused.
- **Approval authority** is `contracts.approve` (team-scopable). No default role template includes
  it: Owners hold it, and they delegate it by giving a role this permission (spec: "the Owner can
  designate another role"). Approvers also see the contracts they can approve.
- **Nobody decides their own request**, except an Owner (who may be the only approver); an Owner's
  self-approval is recorded as such in the request and the audit log.
- On approval, the stamped document is rendered from that version with the Owner-configured stamp
  (image, position, width), the approver's name, date, version and the version's SHA-256
  fingerprint, and stored with the PDF's own SHA-256. The stored file is served as stored, after
  checking its hash; the contract page shows whether the check passed.
- **Approved contracts are final** (no amendments): changing one would need a new contract.
  Signing (Phase 4) starts from the approved document.
- Approvers are notified in-app when a contract is submitted (`contract.approval_requested`, to
  every holder of `contracts.approve` covering the team, except the requester); the requester is
  notified of approval or rejection (with the reason).
- Everything is audited: created, saved (with which parts changed), submitted, withdrawn,
  cancelled, approved, rejected (with reason), exported, assistant proposals and acceptances.

**Document rendering**

- One HTML layout for the in-app preview, draft PDFs and the stamped PDF, so what the approver
  reviews is what gets stamped. A4; letterhead (logo, legal names, header line) and footer
  repeat on every page; drafts carry a "DRAFT — NOT APPROVED" watermark; optional page border.
- The preview is self-contained HTML (inline styles, data: images and fonts) served with a
  no-script CSP and shown in a sandboxed iframe (`srcdoc`). PDF backgrounds appear in the PDF only.
- Margins are "start/end" and follow the reading direction.

**Custom Clause Assistant (spec §7.4)**

- Behind the single provider interface (`src/ai/ai.provider.ts`); the Anthropic adapter calls the
  Messages API with structured outputs (`output_config.format`, JSON schema). Forced tool use is
  not used because Claude Opus 5.5 / Sonnet 5.5 reject `tool_choice` "tool"/"any" (checked in the
  API docs on 17 Oct 2026). Model from `ANTHROPIC_MODEL`, default `claude-sonnet-5-5`.
- Proposal only: drafting, revising or discarding never changes the contract; "Add to contract"
  is a separate request that inserts exactly that clause as a new version (tested: every other
  clause and all details are unchanged).
- The prompt carries no personal data — contract type, document language, existing clause titles,
  the merge-field list and the user's description only — and tells the model to use merge fields
  and bracketed blanks instead of inventing specifics, to list open questions, and never to call a
  clause valid, enforceable or compliant. The UI shows the non-legal-advice caveat with every
  proposal. Output is validated (both languages present, length limits) before it is stored.
- Same permissions as editing the contract; 30 proposals per user per hour.

**Configuration**

- Empty values in `.env` (`KEY=`) now count as unset, so optional settings fall back to their
  defaults instead of failing validation.

## Electronic signatures (Phase 4)

**Who signs**

- The required signers are fixed when signing starts, from the **approved version**: the
  recipient, plus a parent or guardian when the recipient is **under 18 on that day** (UTC
  calendar date, the same clock as Phase 2). The guardian signs **second**, as a separate step;
  the API refuses a guardian signature before the recipient's (`not_your_turn`).
- So that nobody has to guess, the recipient's **date of birth is now required to submit** a
  contract, and for a minor the guardian's name, relationship and an email or phone. Contracts
  approved before Phase 4 without a date of birth can't start signing (`date_of_birth_required`);
  since approved contracts can't be edited, they need a new contract. Easy to relax later.
- The details form shows the guardian fields by the same rule (under 18 today), not the start date.

**Links and identity**

- One link per signer: a 256-bit random token in the URL, stored only as a SHA-256 hash. Default
  validity 7 days (1–30 selectable). Creating a new link revokes the signer's previous one; links
  can be withdrawn; cancelling signing withdraws all open links. The full link is shown once.
- Before anything about the contract is shown, the person opening the link proves who they are
  with a 6-digit code, chosen per link by the manager:
  - **email code** — sent to the address in the contract (or one the manager enters), valid 10
    minutes, single use, at most one per minute and 5 per link;
  - **access code** — shown once to the manager, who passes it on through another channel (phone,
    in person). This works without an email provider.
    Codes are stored as HMAC-SHA-256 keyed with `SESSION_SECRET`. **5 wrong codes lock the link**;
    an attempt is reserved atomically before the comparison, so parallel guesses can't exceed it.
- A correct code opens a 30-minute signing session (random token in Redis, sent by the page in an
  `x-signing-session` header, kept in the tab's sessionStorage). Every request re-checks the link
  (withdrawn, locked, expired, round cancelled) and that the session belongs to that link.
- Before verification the page shows only the organization, the contract number, the signer's
  role and the masked email (`s•••@example.com`). After it: this contract and this signer only.
- Public routes are rate limited per IP (viewing 120 / 15 min, code requests 10 / hour, code checks
  20 / 15 min, signing 10 / 15 min), validated with zod, and sent `Cache-Control: no-store`,
  `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex`. The page itself has no-referrer and
  noindex metadata. The app never logs the token (a hosting provider's access logs may record URLs, as for invitation links).

**Signing**

- **Typed** signatures are drawn in blue (`#1d3fa8`) in a font the signer picks: Dancing Script,
  Great Vibes or Caveat for Latin names; Aref Ruqaa or Amiri (which also cover Latin) for Arabic
  names. A font that can't write the name's script is refused. All five are SIL OFL, from
  `@fontsource`, embedded in the PDF.
- **Drawn** signatures are vector strokes on a fixed 600×200 grid (bounded: 60 strokes, 6 000
  points, a minimum path length so a dot isn't a signature), redrawn as SVG in the same blue.
- The signer previews the signature, ticks the statement and then confirms in a dialog ("final
  once given"); the API requires both `consent: true` and `confirm: true` and the current
  statement version.
- The statement is generated by the server for the signer's role and the page language, and
  **stored verbatim** with its version and language next to the signature, together with the time,
  IP address, browser, verification method, masked destination and verification time, the
  **SHA-256 of the approved PDF** they signed, and a SHA-256 over the whole signature record.
- A signature is recorded with conditional updates inside a transaction that locks the round: the
  link must be unused and the signer still pending, so a link can't sign twice and a cancelled
  round can't receive signatures. Before accepting it, the stored approved PDF is re-hashed.
- The database refuses any change to a recorded signature, any change to a completed or cancelled
  round, reopening a used or withdrawn link, and deleting any signer, round or link (triggers in
  migration 0007). At most one open round and one completed round per contract (unique indexes).

**Completion**

- When the last required signature is in, the **signed PDF** is built: the stamped approved PDF,
  page for page, followed by a **signature record** (contract, legal names, approved version and
  approver, approved-document SHA-256, then per signer the signature, role, method, times, identity
  check, IP, browser, statement and record fingerprint), in the document's language(s). It is
  stored as a new file with its SHA-256; the contract becomes `signed`.
- **Both versions are kept**: the approved PDF is untouched and still downloadable; the signed PDF
  is a separate file. Both are served only after their hashes are re-checked.
- If building the signed PDF fails, the signatures stay recorded and it is retried the next time
  the contract's Signatures tab is opened (idempotent).
- Notifications (in-app): `contract.signature_received` on each signature to whoever started
  signing, requested the approval or created a link; `contract.fully_signed` to them and to every
  Owner. Signers can download the signed copy from their link (after the code check) until it
  expires.
- Audit: signing started, link created/withdrawn, code emailed, identity confirmed, wrong code
  (with attempt count and lock), signed (per signer), fully signed, signing cancelled, signed PDF
  downloaded. Public actions are logged as `anonymous` with the signer's id and role, IP and
  browser; completion as `system`.

**Lifecycle and permissions**

- Contract states: … → approved → **awaiting signatures** → **signed**. Cancelling signing (with a
  reason) returns the contract to approved; signatures given in the cancelled round stay on record
  but don't carry over. A fully signed round can't be cancelled.
- New permission `contracts.send_for_signature` (team-scopable): start signing, create or withdraw
  links, cancel signing. Added to the Head of Esports and Esports Manager templates (migration 0007
  adds it to existing roles from those templates). Seeing the signing status follows contract
  visibility; downloading the signed PDF needs `contracts.export`.
- The "Approved" view now includes contracts out for signature; the "Signed" view lists fully
  signed contracts with their signing date.

## AI assistants (Phase 5)

**Five assistants, one provider interface**

- General Esports, Formal Message, Email, Offer Optimizer and Player Investment Analyst (spec
  §8.2), each with its own sidebar entry and its own permission (`assistants.general`,
  `assistants.formal_message`, `assistants.email`, `assistants.offer_optimizer`,
  `assistants.player_analyst`; spec §4.2 "access per assistant"). Sending a reviewed email from the
  platform is a separate permission, `assistants.send_email`. Head of Esports and Esports Manager
  get all six; Esports Operations gets General, Formal Message and Email (migration 0009 adds them
  to existing roles from those templates). None of them is scopable: what an assistant can _see_ is
  scoped by the user's other permissions (below).
- Everything goes through the single provider interface (`src/ai/ai.provider.ts`, now a global
  `AiModule`). Two calls: `generateJson` (structured outputs, as in Phase 3) and a new `converse`
  for tool use. No second provider and no framework (spec §17).
- **Two steps per reply.** _Research_: the model may call the platform's read-only tools and
  Anthropic's server-side web search (`web_search_20250305`, direct calls, up to 5 searches; at most
  6 model calls and 10 tool runs per reply). _Compose_: a structured-output call with no tools
  writes the answer in the assistant's own JSON shape from the evidence gathered. Two steps because
  structured outputs and citations can't be combined in one call, and a fixed answer shape is what
  lets code check it.
- `pause_turn` is continued by sending the paused content back unchanged; a turn that mixes a web
  search with a platform tool gets the tool results back in a message of only `tool_result` blocks
  (the search then runs on the next call), as the Messages API requires.

**Proposal only (spec §8.1)**

- The assistants have **no tool that writes**. The model is offered only read-only lookups; a
  request for any other tool is refused, logged as `unknown_tool`, flagged on the answer, and the
  model is told it can't change, save or send anything.
- The only two actions that change anything are separate, explicit requests from the person, each
  behind a confirmation dialog: **send this email** (Email Assistant; the recipients, subject and
  body are the ones on screen, edited or not) and **apply this alternative to a draft contract**
  (Offer Optimizer; saved as a new contract version through the normal contract rules — only drafts
  and contracts with requested changes, approval still required). Both are recorded on the message,
  in an append-only table, and in the audit log (`assistant.email_sent`, `assistant.offer_applied`).
- A test runs every assistant end to end and compares a checksum of every non-assistant table
  before and after: nothing changes until one of those explicit requests is made.

**The invoking user's own permissions**

- Every lookup calls the same services the dashboard uses, with the user's own request context, so
  scope rules apply unchanged: a team outside the user's scope is "not available", and the model is
  told so instead of being given the data. Tools are only offered when the user holds the permission
  they need (e.g. finance lookups need `finance.view`).
- **Data minimization:** roster members and contract recipients are sent as name, role, position,
  nationality and **age** — never date of birth, email, phone, address or ID number. Pay is included
  only when the user may see pay on that team, as on the dashboard.
- Conversations are private to the person who started them. The tool-call log is visible to
  holders of `audit.view`.

**Citations, confidence and anti-fabrication (spec §8.1 guardrails 1–3)**

- Sources are registered by the platform when a lookup returns data: `P1…` platform records, `W1…`
  web results, `U1…` context the user typed in. The model can only refer to those ids; an id that
  wasn't registered is removed and flagged. Source titles, links and quoted text come from the
  tools, never from the model.
- Every claim has a confidence label. **"Confirmed" needs a cited source with content behind it**
  (platform data, the user's own context, or a web result whose text was actually quoted);
  otherwise it is shown as "uncertain" and flagged. Gaps are listed as such.
- Links in the answer text that didn't come from a lookup or from the user are replaced with
  "[link removed: not from a verified source]" and flagged. The removed address isn't shown.
- Text from tools, web pages and the user's context is marked as data, not instructions, in the
  prompt.
- Player Analyst scenarios (and Offer Optimizer rationale) are checked for promise wording
  ("guaranteed", "risk-free", "مضمون"…) and flagged. "Guaranteed pay / salary / minimum" is normal
  contract vocabulary and isn't flagged.
- Each reply shows its sources (web links open in a new tab, platform sources link to the
  dashboard page), the checks that were applied, and what was looked up.

**Tool-call log (guardrail 4)**

- Every lookup is stored in `ai_tool_calls` (append-only by trigger): who asked, which assistant,
  the tool or search query, the outcome (`ok`, `denied`, `not_found`, `error`, `unknown_tool`), a
  short result summary (count, source ids) and the time taken. Audit → "Assistant lookups".

**Languages**

- Each conversation has a reply language: **Auto** (the language of each message: Arabic when it
  has more Arabic than Latin letters), Arabic or English. Changing it applies from the next reply.
  The answer is checked; if it's in the wrong language the compose step is retried once, and if it
  still is, the answer is flagged. The model's text is shown with its own direction (an Arabic reply
  reads right-to-left in the English interface), while labels follow the interface language.
- Source names for platform data and the user's context are shown in the reader's language.

**Replies run in the background**

- Sending a message stores it and a pending reply, returns 202, and the page polls until the reply
  is complete or failed. One pending reply per conversation (unique index); a second send gets
  `assistant_busy`. A reply left pending for more than 4 minutes (e.g. after a restart) is marked
  failed (`timeout`) and can be retried. Up to 20 earlier messages are sent along for context.
- Limits: 60 replies and 20 sent emails per user per hour; messages up to 6 000 characters.

**Offer Optimizer numbers**

- Every amount next to an alternative is **calculated by the platform** from its terms
  (`packages/shared/src/assistants/offer.ts`, exact decimals): monthly equivalent, pay over the
  term, signing bonus, all listed bonuses, and an upper-bound total, plus the difference from both
  sides' terms. Per-event pay and revenue shares can't be costed and are noted, not guessed. The
  model is told not to state totals for its alternatives.
- Applying an alternative fills only what it sets: salary, frequency, the end date from the start
  date and duration, bonuses (a signing bonus becomes a "Signing bonus — paid on signing" entry),
  revenue share and buyout. Everything else in the contract stays as it was.

**Fallback context (spec §8.2)**

- Offer Optimizer: both sides' terms (ours can be loaded from a contract the user can see), who
  asked, notes. Player Analyst: a roster player (fetched through the same permission-checked
  lookup) and/or a typed profile and evidence. Email: recipient, address, role, game or team,
  purpose, tone. Formal message: recipient, sender, purpose. All of it is cited as the user's own
  information.

**Configuration**

- `ANTHROPIC_API_KEY` (and the existing `ANTHROPIC_MODEL`) as in Phase 3. `ASSISTANT_WEB_SEARCH`
  (`on` by default; `off` by default since Phase 6) switches web search off for the whole deployment. If the API account has web
  search disabled, the reply is retried without it and says so.

**What is verified, and how**

- Built and tested against a fake provider that returns scripted model output in the documented
  response shapes. The adapter's request building and response parsing are unit-tested against
  those shapes with a mocked HTTP call. Everything on the platform side runs for real in the tests:
  permissions and scoping, the lookups against Postgres, the source registry and guardrails, the
  logging and database triggers, both explicit actions, and the email outbox.
- **Not verified:** a real call to the Anthropic API, real web search results, and the quality of
  real answers (whether the model follows the rules, cites well, writes good Arabic). These need
  the API key; spec §8.3's early live test is still recommended.

## Meetings (Phase 6)

**Model**

- A meeting is a **series**: one occurrence, or a recurrence rule with a required end condition
  (spec §14: "frequency + end condition"). Daily, weekly (chosen weekdays) or monthly (same day of
  the month), every 1–30 periods, ending after up to 365 occurrences or on a date at most 3 years
  after the first. An end is required so a series can always be expanded, synced and reminded
  about without an open-ended loop.
- Times are stored as **wall-clock start + IANA time zone + duration**, and occurrences are
  expanded in that zone (`packages/shared/src/meetings/recurrence.ts`, no date library). A weekly
  18:00 meeting in Riyadh stays at 18:00 local time. On a DST gap the occurrence moves to the
  offset before the gap; in an overlap the first instance is used (both are RFC 5545's rules).
- Single occurrences can be **cancelled or moved** without changing the series (stored as
  overrides; synced as EXDATE / moved instances).
- Fields: title, purpose, notes (optional), start/end, time zone, team **or** department **or**
  whole organization, participants (up to 200), reminders (up to 3 of 5 min … 2 days), status
  (scheduled / cancelled). Cancelling is final; a cancelled meeting can't be reopened.
- **RSVP is per series**: an invitee confirms or declines the meeting, not each occurrence. Simpler
  to answer and to sync; easy to extend later with per-occurrence answers.

**Who may do what**

- `meetings.view`, `meetings.create`, `meetings.manage` are scopable by the meeting's team or
  department, with the same coverage rule as finance records; an organization-wide meeting needs
  an organization-wide grant. **No approval step**: whoever may create a meeting creates it.
- Organizers change their own meetings while they may still create meetings there;
  `meetings.manage` changes any meeting in scope.
- **Administrative meetings** (whole organization) need `meetings.administrative`, which is
  Owner-only (spec §14: the Owner calls them).
- **Everyone invited sees the meeting and can answer it**, whatever their scopes, so an invitation
  never leaks into a 404. Out-of-scope meetings someone wasn't invited to are 404, as elsewhere.
- Default roles: Owner all; Head of Esports and Esports Manager view/create/manage; Esports
  Operations view. Migration 0011 adds them to existing roles from those templates.

**Shared services**

- Every change is audited in the same transaction (`meeting.created`, `updated`, `cancelled`,
  `occurrence_cancelled`, `occurrence_moved`, `responded`; integration changes record which
  connection made them). Invitations, changes, cancellations and answers notify through the
  existing NotificationService; editing uses an `expectedVersion` (optimistic locking →
  `version_conflict`).
- **Reminders** run on the scheduler (every `SCHEDULER_INTERVAL_SECONDS`, default 30): each
  (occurrence, offset) is claimed in `meeting_reminder_deliveries` before sending, so several API
  instances never send one twice. Everyone not declined is reminded; a reminder more than 15
  minutes late (e.g. after downtime) is skipped rather than sent late.

## Integrations (Phase 6)

**What connects, and who owns it**

- **Personal** (any member, no extra permission, only their own meetings): Google Calendar and
  Obsidian. **Organization** (`integrations.manage`, org-level, Owner by default): Notion,
  outgoing webhooks, incoming webhooks.
- Every connection acts **as the person who set it up**, with their current permissions, through
  the meetings service. Changes coming from a provider are audited and notified like any other.
  If the owner loses the permission, changes from that connection are rejected and logged.
- Secrets (OAuth tokens, Notion tokens, webhook secrets) are encrypted with AES-256-GCM; the key is
  `INTEGRATIONS_ENCRYPTION_KEY` (or HKDF from `SESSION_SECRET`), with the organization and
  connection as associated data so a ciphertext can't be moved to another row. Secrets are shown
  once; Obsidian tokens are stored hashed.

**Two-way sync and conflicts**

- Two-way is the default; each two-way connection (Google, Notion, Obsidian) has a **push-only**
  switch: push-only never reads the provider and overwrites it unconditionally. Switching back to
  two-way clears the stored snapshots, so the first comparison treats differences as conflicts
  (platform wins) instead of guessing.
- Each link (meeting ↔ remote record) keeps a **snapshot** of the synced fields as both sides last
  agreed. On a change, base, platform and provider are merged **field by field** (three-way
  merge, `sync-engine.ts`): changed on one side → that side wins; changed on both to the same
  value → nothing; changed on both differently → **conflict: the platform's value wins**, is
  written back, the conflict is logged with both values, and the connection's owner is notified.
  The platform wins because its changes are permission-checked and audited; a calendar or
  database edit may come from anyone with access to it. Start, end and time zone merge as one
  field, so a merge can't combine one side's start with the other side's end. With no snapshot,
  any difference is a conflict.
- **Echo suppression**: after a push, the provider's new version (etag / content hash) is stored,
  so the change notification for our own write is recognized and ignored.
- **Duplicate prevention**: a unique link per (connection, meeting) and per (connection, remote
  id); Google event ids are derived from (connection, meeting) so a repeated create returns 409
  and the existing event is reused; Notion pages are looked up by "Platform ID" before creating;
  an imported meeting carries the remote record's id (unique per connection), so an import
  interrupted before its link was saved is linked on the next pass instead of imported twice.
  Webhook deliveries carry a stable
  `webhook-id`; incoming webhook message ids are stored to refuse replays.
- **Retries**: a durable job queue in Postgres (`integration_jobs`, FOR UPDATE SKIP LOCKED, safe
  across instances, coalescing quick successive edits). Sync jobs back off 30 s, 2 min, 10 min,
  30 min, 2 h, 6 h (7 attempts); webhook deliveries follow the Standard Webhooks schedule (5 s …
  24 h, 10 attempts). Errors are classed retryable / rate-limited / auth / permanent;
  `Retry-After` is honoured and a rate-limit wait doesn't use up an attempt. An auth failure or
  exhausted retries set the connection to "needs attention", log it, and **notify the owner once
  per failure streak**.
- **Rate limits** are kept under the providers' own: Google 300 requests/minute per connection
  (Google allows 600 per user), Notion 150/minute (Notion allows an average of 3/second).

**Google Calendar**

- OAuth (web flow, offline access, `calendar.events` scope, state in Redis plus a nonce cookie).
  Meetings are written to the member's calendar **without guests**, so Google never sends its own
  invitations or creates copies; the member's response shows as tentative or confirmed, and
  declined meetings are removed from their calendar.
- Two-way: title, time, recurrence (RRULE + EXDATE), cancelled and moved single occurrences.
  Deleting the event in Google = declining (or cancelling, for an organizer who may). The
  description is written by the platform and not read back: free text can't be split back into
  purpose, notes and participants reliably.
- Changes arrive by push notification (watch channels with a hashed per-channel token, renewed a
  day before expiry) and incremental sync tokens; a 410 triggers a full re-sync. Writes use
  `If-Match` etags in two-way mode; a 412 re-reads, merges and retries once.
- New events created in Google become meetings only on a **dedicated** calendar (in a chosen
  team), never from "primary": a personal calendar is full of events that aren't team meetings.
  Recurrence rules the platform can't represent are skipped and logged, not approximated.

**Notion (API version 2026-03-11)**

- Internal-integration token pasted by the organization; pages are created in the database's data
  source. Properties are added if missing: When, Status, Purpose, Notes (two-way) and Platform ID,
  Team, Repeats, Participants (written by the platform only; Notion can't express recurrence, so
  edits to "Repeats" are ignored).
- Notion's `last_edited_time` is rounded to the minute, so versions are a hash of the synced
  properties; changes come from signed webhooks (HMAC-SHA256 with the verification token Notion
  sends once, shown to the admin to paste back) and from polling pages edited since the last
  position with a 2-minute overlap. Trashed pages count as cancelling.

**Obsidian — checked, not assumed**

- Obsidian has **no cloud API**: a vault is a folder of Markdown files on someone's computer, and
  Obsidian Sync has no published API (Obsidian staff have said they deliberately don't publish one;
  a headless Sync client was announced in beta in March 2026 and wasn't used). The community
  "Local REST API" plugin only listens on `127.0.0.1`, so a server can't reach it either.
- So the integration is **file-based**: a small companion script (`scripts/obsidian-vault-sync.mjs`,
  Node 18+ or Bun, no dependencies) runs on the member's computer with a personal vault-sync token,
  pulls their meetings as notes (YAML properties + Purpose / Notes sections) into `Meetings/`, and
  in two-way mode pushes back edits to the title, purpose and notes. It never writes outside
  `Meetings/`, moves notes for meetings you've left to `Meetings/_removed/`, and keeps your version
  as a conflict copy next to the note whenever an edit can't be applied. A single note can also be
  downloaded from the meeting page.

**Webhooks**

- Signed per **Standard Webhooks** (`webhook-id`, `webhook-timestamp`, `webhook-signature`;
  `whsec_` secrets). Outgoing: meeting created/updated/cancelled/answered, no notes and no email
  addresses in the payload; https only and **SSRF-checked** (resolved addresses must be public:
  private, loopback, link-local, CGNAT, multicast and IPv6 equivalents including IPv4-mapped,
  NAT64 and 6to4 are refused) when created and before every delivery; redirects aren't followed;
  410 disables the endpoint.
- **Incoming: every request must be authenticated.** Google pushes carry the channel token,
  Notion events the HMAC signature, generic webhooks a Standard Webhooks signature within 5
  minutes and a message id not seen before. Anything else gets the same 401, whether the endpoint
  is unknown, the header missing or the signature wrong. Accepted requests act as the endpoint's
  owner (create / update / cancel meetings, as allowed when it was set up).

**What is verified, and how**

- Exercised for real in the tests: the meetings rules and permissions against Postgres, recurrence
  and time zones, reminders, the merge rules, the job queue and retries, conflict handling and
  notifications, webhook signing and verification (including rejection of unsigned, stale and
  replayed requests), SSRF checks, encryption, and the Obsidian companion script against the real
  API and a temporary vault.
- **Google Calendar and Notion are tested against local stand-in servers** written from their
  documentation (`test/fake-google.ts`, `test/fake-notion.ts`). No call to the real Google or
  Notion API has been made: OAuth consent, real push notifications and real API quirks are
  unverified until an OAuth app and a Notion integration exist.

## Qwen3 provider (Phase 6)

**Host and model**

- **DeepInfra**, model `Qwen/Qwen3-235B-A22B-Instruct-2507` (Apache 2.0 on Hugging Face;
  non-thinking, so no `<think>` blocks). Checked 20 Oct 2026: DeepInfra lists it at
  **$0.09 / $0.55 per million input / output tokens**, 262K context, function calling and JSON
  output, and "zero retention". For the same model, a price comparison page (updated 15 Oct 2026)
  lists Novita $0.09 / $0.58, Together AI $0.20 / $0.60, Alibaba Cloud $0.23 / $0.92 and Replicate
  $0.264 / $1.06. DeepInfra was the cheapest with documented tool calling and structured output.
- Any OpenAI-compatible host serving Qwen3 works by changing `QWEN_API_URL` and `QWEN_MODEL`; easy
  to reverse.
- DeepInfra is hosted in the US, as is Anthropic. Before routing personal data (player profiles)
  to either, check cross-border transfer rules (Saudi PDPL) — not settled in this build.

**Routing**

- `AI_PROVIDER_DEFAULT` (`anthropic` unless set) and `AI_PROVIDER_OVERRIDES` per feature
  (`clause_assistant`, `general`, `formal_message`, `email`, `offer_optimizer`,
  `player_analyst`). Invalid values stop the API at startup.
- **No automatic fallback** between providers: a feature routed to a provider without a key says
  it isn't set up, so data never goes to a provider the deployer didn't choose. Each assistant page
  shows which provider answers it.

**Same guardrails**

- Both providers sit behind the same `AiProvider` interface, and every guardrail is enforced by the
  engine, not the provider: proposal-only (no write tools), the user's own permissions, citations
  and anti-fabrication, confidence labels, the tool-call log, reply language checks.
- Differences handled in the adapter, per DeepInfra's docs: tool `arguments` arrive as a JSON
  string (unparseable arguments are refused, never run as an empty lookup); `tool_choice` only
  `auto`/`none`; with tools, the system text goes at the top of the first user turn (DeepInfra
  advises avoiding system messages with tool calling); structured output via `json_schema` with
  `strict`, and the result is validated anyway; output capped at 16,384 tokens.
- **No web search on Qwen3**: DeepInfra has no server-side search tool, so assistants routed to
  Qwen3 answer without it and the reply is flagged "web search unavailable" rather than
  pretending.

**What is verified, and how**

- Both adapters are tested against a stand-in OpenAI-/Anthropic-shaped server (request building,
  tool-call round trips, JSON parsing, errors, timeouts), and the full assistant suite runs with
  either provider. **Never called live**: real Qwen3 tool-calling quality, Arabic quality and
  latency are unverified until a key is set.

## ID documents at signing (patch to Phase 4)

**What and who**

- After the 6-digit code check, the **recipient** uploads a photo or scan of a passport or national
  ID (they choose which) before they can sign; the signing page shows it as a step and the Sign
  button stays disabled until it is in. A guardian is never asked (`id_document_not_needed`).
- The API refuses the signature without it (`id_document_required`), and so does the database:
  a recipient's signature row needs `id_document_id` (a `NOT VALID` check, so signatures recorded
  before the patch are left as they were), pointing at that signer's current upload (trigger).
- Uploads can be replaced until the signature is given; the earlier one is kept, marked replaced.
  The signature binds the current one, and the upload and the signature take the same row lock,
  so a document can't be swapped while signing.

**Validation**

- PNG, JPEG, WebP or PDF, up to 8 MB, identified by its bytes with the same sniffing as other
  uploads. Refused: empty files, any other type, and disguised files (an executable, HTML or GIF
  labelled as an image or PDF, or a PDF labelled as a JPEG — the declared type must match the
  bytes). Uploads are rate limited (10 per 15 minutes per address). HEIC isn't accepted (iPhones normally hand web pages a JPEG; not checked on a real device).

**Storage and integrity**

- The file goes to the existing file store as kind `signer_id_document`, **encrypted** with
  AES-256-GCM (key from `DOCUMENT_ENCRYPTION_KEY`, required in production; HKDF of
  `SESSION_SECRET` otherwise; the organization and document id are bound in), stored as
  `application/octet-stream`. Its metadata (type, real content type, size, SHA-256 of the original,
  link, time, IP, browser) is in `signer_id_documents`, linked to the round and the signer.
- The signature record's SHA-256 now covers the document's id and fingerprint, and the signed
  PDF's signature record shows "Identity document (kept separately; SHA-256 …)" — the fingerprint
  only, never the image, so the contract pages and the signed PDF never contain it.
- Before serving, the bytes are decrypted and re-hashed; a mismatch is a 500 and nothing is served.
- Rows and their files can't be edited or deleted (triggers), pending the retention decision.

**Access**

- New permission `contracts.view_signer_id` (scopable by the contract's team; Owner holds it; in no
  default template). The viewer must also be able to see the contract (otherwise 404, as
  elsewhere). Without the permission, the Signatures tab shows only "Identity document:
  Provided / Not uploaded yet".
- `GET /contracts/:id/signing/id-documents/:documentId` serves it with `Cache-Control: no-store`,
  `nosniff` and a sandbox CSP (images inline, PDFs as a download). Each successful view writes
  `contract.signer_id_viewed` to the audit log **before** the bytes are sent; uploads write
  `contract.signer_id_uploaded`. Audit entries hold facts (ids, type, fingerprint), never content.
- The signing page never gets the file back: it shows only what was received (type, format, size,
  time). The generic `/files/:id` route never serves this kind.

**AI boundary**

- No assistant tool touches it; tools return explicit field lists, so nothing from a signing round
  is in their results. ESLint forbids `src/assistants` and `src/ai` from importing the
  document service, the signing service, the file store or the signing tables, and the
  service isn't exported from the contracts module. Tests check the tool catalog, scan the source,
  and run every lookup as an Owner (who may view the document) against the signed contract: none
  of the document's ids, fingerprint, type or content reaches the model, and made-up document
  tools are refused and logged.
