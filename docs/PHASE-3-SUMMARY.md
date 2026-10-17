# Phase 3 — Contract Builder & Approval: summary

## Definition of Done

> A manager can draft a contract from a template, request approval, get rejected with a reason,
> revise and resubmit (old version preserved), get approved by a delegated approver, and see the
> stamped approved document — with full audit trail.

All of it runs as one test: `contracts.test.ts › approval workflow (Phase 3 Definition of Done)`.
A team-scoped Esports Manager drafts from the Player template and submits. The Owner and the
delegated approver are notified in-app. The approver, who holds a custom "Contract approver"
role and is not the Owner, rejects. Rejecting without a reason is refused. The manager can't
resubmit unchanged, so they revise (version 3) and resubmit. Version 2 and its rejection stay in
the history with reason, reviewer and time. The approver then approves. The manager is notified
and downloads the stamped PDF. The test checks that the PDF's hash matches the record and that
the text shows the approver, the version fingerprint and the revised salary, with no draft
watermark. It also confirms with `pdfimages` that the stamp image is in the file, and reads back
the full audit trail in order, with actors.

| Scope item (spec §14)                                              | Status | Where it is checked                                                                                                                               |
| ------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Organization/document setup (logo, A4 template, backgrounds)       | Done   | `document setup` tests: Owner-only, file kinds checked by their bytes, image and PDF backgrounds rendered, all 3 languages                        |
| Contract types: fixed defaults + custom                            | Done   | `contract types and clause templates` (four defaults per organization, custom types archived when in use)                                         |
| Clause model: required/optional, ordered, template vs per-contract | Done   | Template editing Owner-only (even Head of Esports gets 403). Required clauses can't be excluded or removed; origins can't be forged               |
| Custom Clause Assistant (AI, text-only proposal)                   | Done\* | `custom clause assistant`: proposals never change the contract; acceptance adds exactly one clause; no personal data in the prompt                |
| Create → approve → reject with reason → resubmit with history      | Done   | DoD test above, plus the database rejecting a reasonless rejection and a second open request                                                      |
| Approval delegation                                                | Done   | Custom role with `contracts.approve`. Team-scoped approvers decide only for their team; self-approval is refused except for Owners (and recorded) |
| Approved / signed contracts in separate views                      | Done   | `approval requests, approved and signed contracts are separate views` (Signed stays empty until Phase 4)                                          |
| Approval stamp configuration                                       | Done   | Owner-only (`org.settings.edit_sensitive`); image, position and width are applied to the approved document                                        |

\* Built and tested against a fake provider. The real Anthropic call needs your API key (see below).

## Built

**Shared services** (reused by later phases):

- An append-only version history (`entity_versions`, SHA-256 per version, UPDATE/DELETE blocked by a trigger).
- A file store in Postgres (uploads are typed by their bytes; SVG is refused).
- The Phase 2 PDF renderer, now a shared `PdfService` that can also lay a PNG/JPEG/PDF background under every page.

**Data model**: migrations `0004_contracts` and `0005_contracts_hardening`.

- Tables: document settings, contract types, template clauses, contracts, approval requests, assistant proposals.
- Same tenancy rules as before.
- The database enforces: one open request per contract, a reason on every rejection, a stored document on every approval, and that a roster member belongs to the contract's team.

**Permissions**:

- New: `contracts.view/create/edit/export/approve` (team-scopable) and `contracts.manage_templates` (Owner-only).
- Esports Manager and Head of Esports gained view/create/edit/export.
- No default role can approve: Owners delegate approval through roles.
- Migration `0005` backfills existing organizations; a test checks it matches the templates.

**Contract documents**:

- One layout for the preview, draft PDFs and the stamped PDF.
- Letterhead and footer repeat on every page; drafts carry a "DRAFT — NOT APPROVED" watermark.
- Documents are bilingual side by side, or Arabic only, or English only.
- Merge fields with missing-value markers that block submission; a page border and a background.
- The approval block shows the stamp, approver, date, version and content fingerprint.

**Dashboard** (Arabic and English, right-to-left, phone width):

- **Contracts list**: All / Drafts / Awaiting approval / Approved / Signed views, search, and a new-contract dialog that pre-fills from the roster.
- **Contract editor**:
  - Details form: recipient, guardian for under-18s, team, game, role, term with computed duration, pay, revenue share, bonuses, buyout, termination and other terms, internal notes.
  - Clause list: reorder, include, reword, add, remove; reworded template clauses are flagged.
  - Assistant dialog with the non-legal-advice caveat.
  - Sandboxed preview for any version, history of versions and approval requests.
  - Submit / withdraw / cancel, and approve / request changes for approvers.
- **Templates editor** (Owner).
- **Document setup** (Owner): legal details, letterhead and footer, logo, background, margins, border, type size, default language, approval stamp, live sample preview and sample PDF.
- Notifications and audit entries for every step.

**Saudi riyal sign ⃁ (your mid-phase request, also a Phase 2 patch).**

- Shown for SAR amounts on the dashboard, in finance PDF exports and in contract documents.
- Placed left of the number with a space in both languages, per SAMA's FAQ.
- **Fonts checked** (cmap): IBM Plex Sans 5.3.0 and IBM Plex Sans Arabic 5.3.0, the fonts we use, have **no glyph** for U+20C1. Neither do Noto Sans, Noto Sans Arabic, Noto Sans Symbols 1 and 2, Noto Naskh Arabic, Noto Kufi Arabic, Cairo, Tajawal, Almarai, Readex Pro, Rubik or Inter.
- **Fix**: I bundled a one-glyph font (SIL OFL 1.1) that covers only U+20C1 and pinned it by its hash.
- **Verified**:
  - PDF: `pdffonts` lists it embedded and `pdftotext` extracts "⃁ 1,250.00" in English and Arabic.
  - Dashboard: Chromium's DevTools protocol shows the sign drawn by the bundled face on English and Arabic pages.
- **Fallback**: amounts stay "SAR" until the browser confirms the font has loaded, so a broken box never shows.
- **CSV / TXT / Excel keep "SAR"**, because those files are opened in other programs with unknown fonts.

Screenshots: `docs/screenshots/30-…` to `49-…`.

## Test results (run on 17 Oct 2026, in the build workspace)

| Suite                                                                      | Result           |
| -------------------------------------------------------------------------- | ---------------- |
| `packages/shared` (catalog, finance engine, contract merge/length/schemas) | 45 pass, 0 fail  |
| `apps/api` (integration on real Postgres 16 + Redis 7, plus unit)          | 138 pass, 0 fail |
| `apps/web` (catalog parity + every label resolves in both languages)       | 6 pass, 0 fail   |
| ESLint, Prettier, TypeScript (all workspaces)                              | clean            |
| `next build` (production)                                                  | succeeds         |

- Phase 3 adds 47 tests: 189 in total, up from 142.
- The Phase 2 tests now set USD explicitly, because new organizations default to SAR; a separate test covers the SAR default.
- The test suites in the table above were then run again from the zip, on a new database.

## Not verified here

- **The live Anthropic API.** There's no key, and the build environment can't reach it. The adapter is unit-tested against the documented request and response format, including errors, refusals and truncation. All integration tests use a fake provider.
- **Docker image and CI**: still no Docker daemon or GitHub repository. The Dockerfile now also copies `apps/api/assets` (the riyal font).
- **Fonts on your users' own devices**: not checked, because the dashboard never relies on them for the riyal sign.

## Deferred or simplified (and why)

- **Electronic signatures, signing links and guardian consent**: these are Phase 4. The Signed view is ready, and the recipient model already carries date of birth and guardian details.
- **Amending an approved contract**: approved contracts are final in Phase 3. An amendment flow (new contract linked to the old one) can come with signatures.
- **Contract numbering formats, per-team templates and clause libraries**: not required by the Definition of Done.
- **Object storage (Supabase Storage)**: files stay in Postgres until credentials exist; the switch is one adapter.

## Needed from you

Still outstanding from earlier phases:

- SMTP provider
- Supabase project
- Redis URL
- `SESSION_SECRET`
- Hosting choice (Railway or Fly.io)
- Discord OAuth app (optional)
- Product name

New in Phase 3:

1. **Anthropic API key** (`ANTHROPIC_API_KEY`) to switch the clause assistant on. The model can optionally be set with `ANTHROPIC_MODEL`; the default is `claude-sonnet-5-5`. Your credit grant expires, and the spec (§8.3) recommends one real call early, so I suggest we do a live test as soon as the key is set.
2. **Legal review of the default clause templates.** They are sample wording, and "Governing law and disputes" is a placeholder. Owners can edit them in the app.
3. **Saudi Esports Federation requirements** (spec §7.8). Before Phase 4 relies on in-house signatures for player registration, please confirm the requirements with the Federation or legal counsel. The product makes no compliance claims.

Settled this phase: Frankfurter is approved, the API may reach `https://api.frankfurter.dev`, and
the default reporting currency is SAR. Details are in `DECISIONS.md`.
