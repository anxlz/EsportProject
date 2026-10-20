# Phase 6 — Meetings, Calendar & Integrations, and a second AI provider: summary

> **Read this first.** Meetings, reminders, the sync engine, webhooks and the Obsidian companion
> script run for real in the tests. **Google Calendar, Notion and Qwen3 (DeepInfra) were tested
> against local stand-in servers** written from their documentation: no call to the real Google,
> Notion, DeepInfra or Anthropic APIs has been made. The section "Stand-in vs. genuinely
> exercised" says exactly what that does and doesn't prove.

## Definition of Done

> A manager can create a recurring meeting with invitees who can confirm/decline and receive
> reminders, and at least one integration (e.g. Google Calendar) syncs in both directions with
> documented conflict resolution. Incoming webhooks reject unauthenticated requests in a test.

| DoD item                                                       | Status                    | Where it is checked                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A manager creates a recurring meeting with invitees            | Done                      | `a manager creates a recurring meeting; invitees confirm or decline; reminders reach everyone who did not decline, once` (a team-scoped Esports Manager, weekly on two days, by count, no approval step). In the UI: the meeting form (screenshot 98) and the calendar list (99).                                                                                                                                                       |
| Invitees confirm or decline                                    | Done                      | Same test: one invitee accepts, one declines, the organizer is notified of each answer. UI: answer from the list or the meeting page (101, 102); the organizer sees "1 of 2 answered" and the answer as a notification (107).                                                                                                                                                                                                           |
| Invitees receive reminders                                     | Done                      | Same test: reminders at both chosen offsets go to everyone who didn't decline, **once** each even when the scheduler runs twice; a reminder more than 15 minutes late is skipped. `a moved occurrence keeps its identity and its reminders follow the new time`.                                                                                                                                                                        |
| One integration syncs both ways with documented conflict rules | Done (against a stand-in) | Google Calendar: `a recurring meeting syncs both ways; a conflict keeps the platform's version, documented and notified; …` plus 11 more Google tests. Notion and Obsidian also sync both ways (4 + 3 tests). The rule is documented in `DECISIONS.md` → "Integrations (Phase 6)", in `src/integrations/sync-engine.ts`, unit-tested (7 tests), and stated on the Integrations page (105). **Google itself is a stand-in** (see below). |
| Incoming webhooks reject unauthenticated requests, in a test   | Done                      | `Phase 6 Definition of Done: unauthenticated requests are rejected; signed ones act as the endpoint owner, once`: no headers, wrong secret, stale timestamp, replayed message id, tampered body and unknown endpoint all get 401, and nothing changes. Google push notifications without the channel token and Notion events without a valid signature are refused in their own tests.                                                  |

## Built

**Meetings** (`apps/api/src/meetings`, `packages/shared/src/meetings`):

- Create directly (no approval), invite, confirm/decline, change, cancel; **recurring** daily /
  weekly on chosen days / monthly, every 1–30, ending after a number of times or on a date
  (required); cancel or move **one occurrence**. Fields: title, purpose, notes, start/end, time
  zone, team or department or whole organization, participants, reminders, status.
- **Administrative meetings** for the whole organization: Owner only (`meetings.administrative`).
- Recurrence engine in shared code (no date library): wall-clock time in an IANA zone, correct
  across DST changes, RFC 5545 subset in and out (RRULE + EXDATE).
- Permissions: `meetings.view` / `.create` / `.manage` (scopable), `.administrative`
  (Owner-only), `integrations.manage` (org-level). Migration 0011 adds the meeting permissions to
  existing template roles; a test checks it against the templates. Invitees always see what they
  were invited to.
- Reuses the audit log (6 meeting actions, 4 integration actions), the NotificationService (6
  meeting and 2 integration notification types) and the permission/scope guards.
- Reminders: a scheduler in the API (`SCHEDULER_INTERVAL_SECONDS`), safe across instances.

**Integrations** (`apps/api/src/integrations`):

- **Google Calendar** (personal): OAuth, two-way title / time / recurrence / single-occurrence
  changes, push notifications with renewal, sync tokens with full re-sync on 410, etag
  preconditions, own response as tentative/confirmed, delete-to-decline, imports from a dedicated
  calendar only.
- **Notion** (organization): pages in a database (API version 2026-03-11, data sources), missing
  properties added on connect, signed webhooks plus polling, trash = cancel.
- **Obsidian** (personal): checked first — there is no cloud API, so it is file-based: a
  companion script (`scripts/obsidian-vault-sync.mjs`, no dependencies) syncs the member's
  meetings into `Meetings/` in their vault and sends edits back, with conflict copies; a single
  note can also be downloaded from a meeting.
- **Webhooks**: outgoing (signed Standard Webhooks, SSRF-checked, retries, 410 disables) and
  incoming (signature + timestamp + replay check, acts as the endpoint's owner).
- One sync engine for all two-way providers: three-way merge per field, **platform wins
  conflicts** (written back, logged with both values, owner notified), echo suppression,
  duplicate prevention, a durable job queue in Postgres with backoff and rate-limit deferral,
  push-only switch per integration, failure logging and one notification per failure streak.
- Secrets encrypted with AES-256-GCM, shown once; Obsidian tokens stored hashed.
- Data model: migrations `0010_meetings_integrations` (generated) and `0011_meetings_hardening`
  (hand-written: RLS, append-only integration log, vocabulary checks, permission backfill).

**Qwen3 provider** (`apps/api/src/ai/qwen.provider.ts`, `ai.router.ts`):

- Qwen3-235B-A22B-Instruct-2507 (Apache 2.0) on **DeepInfra**, chosen on price and documented
  tool calling / structured output (see `DECISIONS.md` → "Qwen3 provider").
- Provider chosen per feature or globally (`AI_PROVIDER_DEFAULT`, `AI_PROVIDER_OVERRIDES`);
  **Anthropic stays the default**; no silent fallback. Each assistant page shows who answers it.
- The same engine and guardrails for both providers. Qwen3 has no web search here: replies say
  so with a flag instead of pretending.
- `ASSISTANT_WEB_SEARCH` now defaults to `off`.

**Dashboard** (Arabic and English, right-to-left, phone width):

- **Meetings**: a four-week agenda grouped by day in the viewer's time zone (all I can see / only
  mine, team filter), answer buttons inline, a meeting page with details, the next occurrences
  (cancel one), the invitee list with answers, your answer and a note, where it is synced, and
  "Download for Obsidian"; a create/edit form with recurrence preview, people search and
  reminders.
- **Integrations**: your connections (Google Calendar, Obsidian) and organization connections
  (Notion, outgoing and incoming webhooks), each with status, sync direction, team filter,
  last sync, linked count, activity log, sync now, pause/resume, new secret, disconnect; the
  conflict rule in plain words.
- Meeting and integration notifications, permissions, audit actions and errors in both languages.

Screenshots: `docs/screenshots/98-…` to `108-…`, taken from the real web app and API (Next.js →
`/api` proxy → NestJS, real Postgres and Redis) in headless Chromium at phone width (390 px):
the owner in English, the invited player in Arabic. No horizontal overflow on any page. Google
isn't configured in that run, so its card shows "isn't set up on this server yet".

## Test results (run on 20 Oct 2026, in the build workspace)

| Suite                                                                                | Result           |
| ------------------------------------------------------------------------------------ | ---------------- |
| `packages/shared` (catalog, finance, contracts, signing, assistants, meetings)       | 80 pass, 0 fail  |
| `apps/api` (integration on real Postgres 16 + Redis 7 + Chromium, plus unit tests)   | 235 pass, 0 fail |
| `apps/web` (catalog parity, every label and meeting/integration vocabulary, plurals) | 9 pass, 0 fail   |
| ESLint, Prettier, TypeScript (all workspaces)                                        | clean            |
| `next build` (production)                                                            | succeeds         |

- Phase 6 adds 74 tests: 324 in total, up from 250.
  - API: 7 meeting, 12 Google, 4 Notion, 6 webhook/Obsidian, 17 unit (merge rules, encryption,
    signatures, SSRF, provider mappings, backoff) and 9 provider tests (Qwen adapter, routing,
    the assistants through both adapters). One existing test was updated because web search is
    now off by default.
  - Shared: 18 tests (time zones and DST, recurrence, schemas, permissions).
  - Web: 1 test (plural messages), plus the existing ones now cover every Phase 6 vocabulary.
- Two real bugs found by the UI run and fixed: the Obsidian token dialog closed itself as soon as
  the connection appeared; and on a phone the agenda row squeezed the title (rebuilt as a stacked
  row, times isolated so Arabic AM/PM marks read correctly).
- One gap found while writing the docs and fixed with a test: an import from Google interrupted
  between creating the meeting and linking it would have imported the event again; imports now
  carry the remote id (unique per connection) and an interrupted one is linked on the next pass.
- The same observation as in Phase 5: in the first full API run after the database and Redis were
  restarted, the two **Phase 4 signing tests** that render the first PDFs timed out at 5 s
  (Chromium cold start). The signing file passed on its own straight after, and the next full run
  was 235 pass, 0 fail. Not caused by Phase 6, but still not proven beyond that pattern.

## Stand-in vs. genuinely exercised

**Genuinely exercised** (real code, real Postgres/Redis, in tests and in the UI run):

- Meetings: permissions and scoping, visibility by invitation, recurrence and DST, single
  occurrences, optimistic locking, audit entries, notifications, reminders (once, not late).
- The sync engine's rules, the job queue (claiming, coalescing, backoff, rate-limit deferral,
  dead jobs), conflict logging and owner notification, push-only, failure states.
- Webhooks end to end over HTTP: signing, verification, replay and timestamp checks, SSRF
  refusal (including IPv6 forms of private addresses), retries and endpoint disabling.
- Obsidian end to end: the companion script against the real API and a temporary vault folder
  (write, edit, push back, conflict copy, removal, path safety, revoked token).
- Encryption of stored secrets, the OAuth state handling, the provider routing and "not
  configured" states, and the whole assistant engine with either adapter.

**Verified only against a stand-in** (local servers written from the providers' documentation):

- **Google Calendar**: the real OAuth consent screen and token exchange, real push
  notifications, real sync-token behaviour and quotas, how real recurring events and their
  exceptions come back.
- **Notion**: the real API's responses for version 2026-03-11, real webhook delivery and the
  verification handshake, real rate limiting.
- **Qwen3 on DeepInfra** and **Anthropic**: the real HTTP round trip, how well each model follows
  the tool-calling and JSON rules, Arabic quality, latency and cost.

These checks confirm the code matches the documentation; they can't confirm the live services
behave the same. Each needs one live check once the credentials exist (below).

## Deferred or simplified (and why)

- **Per-occurrence RSVP**: answers apply to the whole series. Simpler to answer and to sync;
  can be added later.
- **Meeting rooms, video links, attachments**: not in the spec; the purpose and notes fields
  carry links for now.
- **Recurrence rules beyond the platform's set** (e.g. "the second Tuesday", BYSETPOS, hourly):
  refused or skipped with a logged reason, never approximated.
- **Google**: the calendar description isn't read back (it can't be split back into fields
  reliably); guests aren't added to members' copies (each member syncs their own calendar).
- **Notion**: recurrence can't be expressed there, so "Repeats" is informative only.
- **Obsidian**: no plugin; the companion script needs Node 18+ on the member's computer.
  Obsidian's headless Sync client (beta, March 2026) wasn't used.
- **Web search on Qwen3**: not available at DeepInfra; those assistants answer without it.
- **A live check of any external service**: needs the credentials listed below.

## Needed from you

Still outstanding (development uses local stand-ins):

- SMTP provider, Supabase project, Redis URL, `SESSION_SECRET`, hosting choice (Railway or
  Fly.io), Discord OAuth app (optional), product name.
- **Anthropic API key** (blocks nothing; one live conversation per assistant before relying on
  them). Web search is now off unless you set `ASSISTANT_WEB_SEARCH=on`.
- **Qwen3 key** (DeepInfra), only if you want to route anything to Qwen3; then one live
  conversation per routed assistant.
- **Google OAuth app** to offer Google Calendar (Google's verification for the `calendar.events`
  scope before more than 100 users), then one live sync check.
- **Before routing personal data to either AI provider**: confirm cross-border transfer rules
  (Saudi PDPL); both are US-hosted. Not settled in this build.
- Deployment: `PUBLIC_API_URL` (https, reachable by Google and Notion) and a dedicated
  `INTEGRATIONS_ENCRYPTION_KEY`.

Still open outside this build: legal review of the clause wording and signing statement, and the
Saudi Esports Federation confirmation. Nothing in Phase 6 depends on either.
