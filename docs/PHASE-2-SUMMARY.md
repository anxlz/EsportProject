# Phase 2 — Accounting & Investment Analysis: summary

## Definition of Done

| Item                                                         | Status | Where it is checked                                                                                                                                             |
| ------------------------------------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Team/roster configuration                                    | Done   | Rosters per team (players, coaches, staff) with pay terms; `finance-ledger.test.ts › rosters and pay terms`                                                     |
| Expense model with organization → team → player hierarchy    | Done   | `finance-ledger.test.ts › scope hierarchy` (scope enforcement, player must belong to the team, 404 for out-of-scope records)                                    |
| Multi-currency with exchange-rate snapshotting               | Done   | `finance-ledger.test.ts › multi-currency` (stored rate never changes, "today's rates" view, manual rate, missing rate refused, 3-decimal currencies)            |
| Budgets with variance reporting and alerts                   | Done   | `finance-reports.test.ts › budgets` (one alert per crossing, right recipients, re-arm after recovery, audit entry). Alerts use the Phase 1 notification service |
| Revenue categories                                           | Done   | 7 categories; received vs expected (certain/uncertain)                                                                                                          |
| ROI as transparent cost-vs-realized reporting, no auto-score | Done   | Report shows costs, realized revenue and net by category/team/month; a test asserts no ROI or score field exists                                                |
| Manual tournament research with source / last-verified       | Done   | `finance-ledger.test.ts › tournament research` (http/https links only, team links, read-only for managers)                                                      |
| Break-even / payback at team, tournament and season scope    | Done   | `finance-reports.test.ts › financial report` (organization, team, tournament, date range) and `finance-ledger.test.ts › seasons` (season scope)                 |
| Scenario modeling                                            | Done   | Pessimistic / base / optimistic with data-derived starting values, editable live, saved per scope; engine unit tests + API tests                                |
| Exports in PDF, CSV, XLSX and TXT matching the UI            | Done   | `finance-reports.test.ts › exports` checks each format's figures against the JSON report the dashboard shows (English and Arabic)                               |
| Tax fields present but inert (§6.7)                          | Done   | Tax amount + jurisdiction stored and shown; the seeded tax amount is absent from every total; every report states that no tax is calculated                     |

## Built

**Data model** (migrations `0002_finance`, `0003_finance_hardening`): seasons, roster members and
pay terms, tournaments (+ team links), one ledger table for costs and revenue, budgets with
category limits, saved scenarios, and an exchange-rate cache. Same tenancy rules as Phase 1:
`app` schema, RLS on every table, composite tenant foreign keys. The database also enforces that a
player-level record names someone on that team, and refuses to delete teams, people or tournaments
that records still reference (shown as "still in use").

**Permissions**: `rosters.*`, `tournaments.*`, `finance.view/create/edit/delete/export`,
`budgets.manage` (all team-scopable except tournaments) and `finance.configure`. Built on the
Phase 1 guards and scope filters; default role templates updated, existing organizations
backfilled by migration. Pay terms need finance access on the team, not just roster access.

**Exchange rates**: Frankfurter (no API key) with caching; rate, rate date and source stored on
every record; manual rates when no rate is known; "today's rates" comparison view.

**Reports**: one shared engine computes totals, monthly series, break-even/payback, projections,
scenarios and payroll projection. The dashboard recomputes scenarios live with the same code, and
all four export formats render from the same table model, so every surface shows the same figures.

**Budgets**: variance per budget and per category limit; alerts through the existing notification
service to people whose finance access covers the budget, once per crossing, audited.

**Dashboard** (Arabic and English, right-to-left, phone width): Finance report (filters, headline
figures, monthly chart and cumulative result, categories, teams, break-even, projections,
scenario editor and chart, footnotes, downloads), Costs and Revenue (filters, record form with
rate lookup and converted preview, tax section, phone card layout), Budgets (meters with status
icon and text), Finance settings (reporting currency, enabled currencies, seasons), Tournaments,
and a team page with the roster and pay terms. Budget alerts appear in the notification inbox.

Screenshots: `docs/screenshots/10-…` to `25-…`.

## Test results (run on 17 Oct 2026, in the build workspace)

| Suite                                                                | Result           |
| -------------------------------------------------------------------- | ---------------- |
| `packages/shared` (catalog integrity + finance engine)               | 33 pass, 0 fail  |
| `apps/api` (integration on real Postgres 16 + Redis 7, plus unit)    | 103 pass, 0 fail |
| `apps/web` (catalog parity + every label resolves in both languages) | 6 pass, 0 fail   |
| ESLint, Prettier, TypeScript (all workspaces)                        | clean            |
| `next build` (production)                                            | succeeds         |

Phase 2 added 27 engine tests and 27 API tests (Phase 1 had 88 tests in total; now 142). The suites
were run three times in a row with the same result. PDF tests extract the text layer with
`pdftotext` and check the embedded fonts with `pdffonts`.

## Not verified here

- **Live exchange rates**: the build workspace cannot reach frankfurter.dev, so the adapter is
  tested against its documented response format and a fake provider. In the screenshots, foreign
  amounts carry hand-entered rates for the same reason.
- **Docker image**: no Docker daemon here. The Dockerfile now installs Debian's Chromium for PDF
  exports; PDF rendering itself was tested with both the bundled Chromium and a standard Chromium
  build, but `docker build` has not run.
- **CI workflow**: updated (poppler, Chrome path for PDF tests), not executed — no GitHub
  repository yet.

## Deferred or simplified (and why)

- **Tax calculation** → spec §6.7, still deferred; fields only.
- **Versioning service** → Phase 3 with contracts (confirmed).
- **Posting payroll automatically** from roster pay terms → payroll is projected for scenarios but
  salary costs are recorded by hand, so the ledger only contains what actually happened.
- **Recurring-entry automation, CSV import, multi-currency budgets** → not required by the Phase 2
  Definition of Done.
- **A "share report" permission** → downloads use `finance.export`; sharing links can come later.

## Needed from you before production

Still outstanding from Phase 1: SMTP provider, Supabase project, Redis URL, `SESSION_SECRET`,
hosting choice (Railway or Fly.io), Discord OAuth app (optional), product name.

New in Phase 2:

1. **Frankfurter terms**: confirm they suit commercial use (I couldn't open its licence page), or
   name another provider.
2. **Network access**: the API host must reach `https://api.frankfurter.dev`.
3. **Default reporting currency**: new organizations start in USD with USD + SAR enabled; each
   Owner can change this before recording anything. Tell me if SAR should be the default.

Details in `DECISIONS.md` → "Still open" and "Accounting and investment analysis".
