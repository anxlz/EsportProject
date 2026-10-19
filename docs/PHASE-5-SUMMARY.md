# Phase 5 — AI Assistants: summary

> **Read this first.** As agreed, all five assistants were built and tested against a **fake
> provider**: scripted model output behind the same provider interface the real Anthropic adapter
> implements. **No call to the Anthropic API has been made.** The section "Fake provider vs.
> genuinely exercised" below says exactly what that does and doesn't prove.

## Definition of Done

> Each of the five assistants is reachable from its sidebar entry, produces a human-reviewable
> proposal (never an auto-committed change), respects the invoking user's own data permissions,
> and cites sources with confidence labels whenever it uses a tool call. A test confirms no
> assistant can mutate data without explicit human acceptance.

| DoD item                                                                    | Status | Where it is checked                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Each assistant reachable from its sidebar entry                             | Done   | Five entries under "AI assistants", each shown only with its own permission (screenshots 77, 93). Each opens `/dashboard/assistants/<key>`. A user without the permission gets "no access" (94), and the API refuses with `assistant_not_allowed`.                                                                                                                                                                                                                                                     |
| Produces a human-reviewable proposal                                        | Done   | `Phase 5 Definition of Done › each of the five assistants returns a human-reviewable proposal and changes nothing`: one conversation per assistant, each answer in its own shape. General: an answer with points. Formal: the finished message. Email: editable recipients, subject and body. Offer: alternatives with calculated costs. Analyst: scenarios.                                                                                                                                           |
| Never an auto-committed change; a test confirms no mutation without a human | Done   | The DoD test checksums **every non-assistant table** before and after all five replies, and they are identical. `a model that tries to write (unknown tools, claims of success) changes nothing`: the model asks for `update_contract`, `send_email` and `create_expense` and claims it made the changes; all three are refused and logged as `unknown_tool`, and the checksum is unchanged. Separate tests show the only two changes possible come from the explicit **Apply** and **Send** requests. |
| Respects the invoking user's own data permissions                           | Done   | `a team-scoped manager's lookups of another team come back as not available, and none of that data reaches the model`. `tools are offered only for what the user may see; assistants need their own permission`.                                                                                                                                                                                                                                                                                       |
| Cites sources with confidence labels whenever it uses a tool call           | Done   | `claims cite only real sources; unsupported or invented ones are corrected and flagged`. Sources are registered by the platform, not taken from the model. "Confirmed" needs evidence. Invented source ids and links are removed and flagged. Screenshots 80, 81, 87, 91.                                                                                                                                                                                                                              |

## Section 8 hard rules (carried forward)

| Rule                                            | How it is enforced                                                                                                                                                                                                                                                                             | Test                                                                                                      |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Proposal only                                   | The model is offered **no tool that writes**. The two actions (send email, apply an offer alternative to a draft contract) are separate explicit requests behind confirmation dialogs. Each is recorded (append-only) and audited.                                                             | DoD test; `only the explicit Apply action…`; `only the explicit Send action…`                             |
| Permission-scoped data access per invoking user | Lookups call the dashboard's own services with the user's request context, so the same scope rules apply. A tool is offered only when its permission is held. **Data minimization:** age instead of date of birth; no email, phone, address or ID number; pay only where the user can see pay. | `assistants only see what the invoking user can see` (2 tests)                                            |
| Citation + confidence labels + anti-fabrication | Source registry (P/W/U ids). Unregistered ids are removed. "Confirmed" without evidence becomes "uncertain". Unverified links are removed. Tool and web text is marked as data. Analyst and offer wording is checked for promises. The system prompt forbids invented sources.                 | `citations, confidence labels and anti-fabrication` (3 tests) + unit tests                                |
| Tool-call logging                               | `ai_tool_calls` (append-only trigger) stores the query or arguments, user, assistant, time, outcome and result summary. It appears under Audit → "Assistant lookups" (screenshot 92) and needs `audit.view`.                                                                                   | `every tool call is logged with query, user, assistant and time; the log is append-only and audit-only`   |
| Arabic/English switching per conversation       | The reply language is Auto (each message's language), Arabic or English, and can be changed per conversation. The answer is checked; one retry, then a flag. Arabic replies render right-to-left even in the English interface (81, 91).                                                       | `replies follow the language of each message, and switch mid-conversation`; `…retried once, then flagged` |

## Built

**Shared** (`packages/shared/src/assistants/`): the assistant catalog and per-assistant
permissions, request schemas (conversation, message, per-assistant context, send email, apply
offer), answer types, and the **Offer Optimizer cost math** (exact decimals; every amount next to
an alternative is calculated by the platform, never by the model).

**Permissions**:

- New domain `assistants`: `assistants.general`, `.formal_message`, `.email`, `.offer_optimizer`, `.player_analyst`, `.send_email`.
- Head of Esports and Esports Manager get all six. Esports Operations gets General, Formal and Email.
- Migration 0009 adds them to existing roles from those templates; a test checks this against the templates.

**Data model**: migrations `0008_assistants` (generated) and `0009_assistants_hardening`
(hand-written).

- `ai_conversations`: owner, assistant, reply language, web search, context.
- `ai_messages`:
  - one pending reply per conversation;
  - complete replies are immutable;
  - no deletes.
- `ai_tool_calls` and `ai_proposal_actions`: append-only.
- RLS, check constraints for every vocabulary, and the permission backfill.

**Provider** (`src/ai/ai.provider.ts`, now a global module):

- A new `converse()` for tool use, alongside `generateJson`.
- Anthropic web search (`web_search_20250305`, direct calls, up to 5 per reply).
- Handles `pause_turn`, a search deferred by a tool call, search error codes, and refusals.
- If the account has web search disabled, the API's error is recognized and the reply continues without web search.

**Engine** (`src/assistants/`):

- **Research**: up to 6 model calls and 10 lookups, using the read-only tools: teams, roster, roster member, finance report, budgets, contracts, contract terms, tournament research.
- **Compose**: a structured answer per assistant, then guardrails, then platform-calculated offer costs.
- Replies run in the background: the API returns 202 and the page polls. A stale pending reply times out after 4 minutes.
- Rate limits: 60 replies and 20 emails per user per hour.

**Dashboard** (Arabic and English, right-to-left, phone width):

- An **AI assistants** overview with the rules in plain words (77), and five sidebar entries.
- Each assistant page has:
  - a conversation list (active/archived);
  - reply language and web-search settings;
  - a **context form** (offer terms with a live platform cost preview and "load our terms from a contract", 86; roster player, profile and evidence; email brief; formal brief);
  - a chat with a pending state (79) and retry on failure.
- Each answer shows:
  - points with **Confirmed / Estimated / Uncertain** badges and source chips;
  - gaps and follow-up suggestions;
  - the **sources** (web links open in a new tab; platform sources link to their page);
  - the **checks applied** (80);
  - **what was looked up**.
- Proposal cards:
  - Formal: copy (82).
  - Email: editable To/Cc/Subject/Body, copy, open in a mail app, and **Send…** with a confirmation (83–85).
  - Offer: a cost table, what differs, alternatives with risk, trade-offs, impact and deltas, and **Apply to a draft contract…** with a confirmation (87–90).
  - Analyst: scenarios with the "not predictions" caveat (91).
- Audit → **Assistant lookups** (92).
- A not-configured state when there's no API key: the banner is shown and sending is disabled (97).

Screenshots: `docs/screenshots/77-…` to `97-…`. For these, the real API (real database,
permissions, tools, guardrails, logging, outbox) ran with a **scripted stand-in** for the model.
Its replies say "Prepared with stand-in (demo script, not a real model)", and its web result is an
illustrative `example.com` page. The stand-in was a local script; it is not part of the code.

## Test results (run on 18 Oct 2026, in the build workspace)

| Suite                                                                               | Result           |
| ----------------------------------------------------------------------------------- | ---------------- |
| `packages/shared` (catalog, finance, contracts, signing, assistants)                | 62 pass, 0 fail  |
| `apps/api` (integration on real Postgres 16 + Redis 7 + Chromium, plus unit tests)  | 180 pass, 0 fail |
| `apps/web` (catalog parity, every label and assistant vocabulary in both languages) | 8 pass, 0 fail   |
| ESLint, Prettier, TypeScript (all workspaces)                                       | clean            |
| `next build` (production)                                                           | succeeds         |

- Phase 5 adds 40 tests: 250 in total, up from 210.
  - API: 15 assistant integration tests, 11 unit tests (guardrails, offer terms, guarantee wording, titles) and 4 adapter tests.
  - Shared: 8 tests.
  - Web: 2 tests.
- One observation, reported for completeness: in the first full run after restarting the database, two **Phase 4 signing tests** failed (~5 s each, both render PDFs with Chromium). They passed when run on their own and in all four later full runs, including the run from the zip on a new database. It looks like a cold-start timing issue rather than a Phase 5 change, but it hasn't been proven.
- Every screen was driven through the real UI in headless Chromium (Next.js, then the `/api` proxy, then NestJS) in English, Arabic and at phone width, with no horizontal overflow. The test suites were then run again from the zip on a new database.

## Fake provider vs. genuinely exercised

**Genuinely exercised** (real code, real Postgres/Redis, in tests and in the UI run):

- Permissions and team scoping on every lookup, and the "not available" path.
- The eight read-only lookups against real data, and data minimization (what reaches the "model" is asserted in tests).
- The source registry, claim checks, link scrubbing and promise-wording check.
- The tool-call log and the database triggers (append-only, immutable replies, one pending reply).
- Both explicit actions: the email lands in the outbox with the reviewed text and reply-to; the offer is saved as a contract version through the contract rules, with hand-checked amounts.
- Language detection and switching, background replies, busy/timeout/failure recovery, rate limits, and the not-configured state.

**Verified only against the fake provider:**

- What a real model would actually do:
  - whether it follows the rules;
  - whether it picks sensible lookups;
  - whether its citations match its claims;
  - how good its Arabic is;
  - whether it stays within the answer shapes.
- Real web search results and real citation text.
- The exact HTTP round trip with Anthropic. The adapter's requests and response parsing are unit-tested against the **documented** response shapes (tool use, server tool use, search results and errors, citations, `pause_turn`, the "web search disabled" error) with a mocked HTTP call. That checks the code against the documentation, not against the live service.
- Latency, token use and cost per reply.

## Deferred or simplified (and why)

- **Live API test** (spec §8.3 recommends one early): needs the key; deferred by your decision.
- **Streaming replies**: replies arrive whole (background job + polling). This is simpler and avoids proxy timeouts; streaming can be added later.
- **Web search versions with dynamic filtering** (`web_search_20260209`/`20260318`, which run inside code execution): the basic version is used. It is simpler, and its results go straight to the model.
- **Sending email with a name in the To line, attachments, or HTML formatting**: plain-text emails from the platform address, with replies going to the sender. Copy and "open in mail app" are always available.
- **Sharing conversations between users**: conversations are private to whoever started them; the lookup log is the shared record.
- **Offer Optimizer applying to an approved contract**: approved contracts are final (Phase 3 rule), so alternatives apply to drafts only.

## Needed from you

Still outstanding (development uses local stand-ins):

- SMTP provider (assistant emails, like invitations and signing codes, go to the dev outbox until then)
- Supabase project
- Redis URL
- `SESSION_SECRET`
- Hosting choice (Railway or Fly.io)
- Discord OAuth app (optional)
- Product name
- **Anthropic API key**. It blocks nothing, but it is now the only way to find out how the six AI features behave with a real model. When you have it, I recommend one short live conversation per assistant, in both languages (spec §8.3), before anyone relies on them. Web search is billed per search; `ASSISTANT_WEB_SEARCH=off` turns it off.

Still open outside this build: legal review of the clause wording and signing statement, and the
Saudi Esports Federation confirmation. Nothing in Phase 5 depends on either. The assistants make
no legal or compliance claims, and the clause assistant's non-legal-advice caveat is unchanged.
