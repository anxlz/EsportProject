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

## Still open — needs your input

| Topic                           | Needed by                     | Notes                                                                                                                                                                                                                                                              |
| ------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Email provider (SMTP)           | Before production             | Invitations and password-reset emails need one. The code is provider-neutral SMTP (Resend, Postmark, Amazon SES, Mailgun, Brevo all offer SMTP). Until configured, Owners can still copy invitation links from the UI; password reset will not work in production. |
| Railway vs Fly.io               | Deployment                    | Dockerfile is portable to both (and AWS).                                                                                                                                                                                                                          |
| Supabase project + environments | Deployment                    | Whether you want separate dev/staging/prod projects pre-launch.                                                                                                                                                                                                    |
| Discord OAuth app               | When you want Discord sign-in | Client id/secret + redirect URL; feature is fully built and hidden until configured.                                                                                                                                                                               |
| Product name                    | Any time                      | "Club Manager / إدارة النادي" is a placeholder in `apps/web/src/messages/*.json` (`app.name`).                                                                                                                                                                     |
| FX rate provider                | Phase 2                       | Spec §5.                                                                                                                                                                                                                                                           |

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
