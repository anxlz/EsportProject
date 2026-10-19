# Phase 4 — Electronic Signature Workflow: summary

## Definition of Done

> An approved contract can be sent for signature via a unique link, signed by the recipient (and,
> for a minor, also by a guardian via a second signature step), and the fully-executed document
> appears in the signed-contracts view with an intact audit trail.

All of it runs as one test: `signing.test.ts › signing a contract for a minor (Phase 4 Definition
of Done)`. A team-scoped Esports Manager sends an approved contract for a 16-year-old for
signature. The API fixes the signers from the approved version: the recipient first, then the
guardian. The manager creates one link per signer: an emailed code for the recipient and an
access code for the guardian. Only hashes of both are stored.

The recipient opens the link without an account. Before the code check they see only the
organization, the contract number and a masked email. They request the code (from the dev
outbox), verify, read the approved document, and download the PDF, whose hash matches the
approval record. They then sign with a typed name. The guardian can open their link early but is
refused with `not_your_turn` until the recipient has signed.

Between the two signatures the contract stays `awaiting_signatures`. It isn't in the Signed view
and it has no signed PDF. The manager is notified of the first signature. The guardian then signs
by drawing. The contract becomes `signed` and appears in the Signed view.

The test then checks:

- The signed PDF is the approved PDF followed by a signature record. Its hash matches the record.
- The record contains the approved document's hash, both signers, the guardian's relationship,
  the masked email and the consent statement. `pdffonts` shows the chosen signature font
  embedded.
- The approved PDF is unchanged.
- Each signer can download the executed copy.
- Both consent records hold the statement verbatim, the consent version and language, the method,
  the IP and the document hash. The record hash recomputes exactly from the stored fields.
- The requesting manager and the Owner are notified.
- The audit trail reads back in order with actor types.
- The database refuses to change a recorded signature, change a completed round, or delete a link.

| Scope item (spec §14)                                                 | Status | Where it is checked                                                                                                                                                                                                       |
| --------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secure signing-link generation, expiration, revocation                | Done   | `signing links`: replaced, expired, revoked and unknown links are refused (also mid-session); tokens stored hashed; 5 wrong codes lock a link; emailed codes are throttled, single use and expire                         |
| Public signing page (no internal account)                             | Done   | DoD test (anonymous client); web page `/sign/<token>` (screenshots 55–65, 71–73)                                                                                                                                          |
| Typed (blue) and drawn signature capture, preview, final confirmation | Done   | Typed in blue (`#1d3fa8`) in a chosen font; drawn strokes; the preview and confirmation dialog are in the page; the API requires consent, confirmation and a font that can write the name (`who signs` tests, unit tests) |
| Multi-signer support incl. guardian consent for minors                | Done   | DoD test; the adult case (one signature completes); order enforced; unit tests of `requiredSigners` (birthday edge cases, missing guardian details)                                                                       |
| Document integrity and consent-record storage                         | Done   | Approved-document hash fixed per round and re-checked before each signature and download; per-signature record hash; signed PDF stored with its hash; DB triggers (`storage` test, DoD test)                              |
| Notifications on completion                                           | Done   | `contract.fully_signed` to the requester, starter, link creators and every Owner; `contract.signature_received` on each signature                                                                                         |
| §11 rate limiting + input validation on the public route              | Done   | `public signing routes are rate limited per client`; zod on every body; token format checked before any lookup                                                                                                            |
| §12 "incomplete until all signers incl. guardian signed"              | Done   | DoD test, between the two signatures                                                                                                                                                                                      |

## Built

**Data model**: migrations `0006_signatures` (generated) and `0007_signatures_hardening` (hand-written).

- `signing_rounds`: one attempt at collecting every signature. It records the approval request, the approved PDF's SHA-256, whether a guardian was needed and on which date, cancellation (with a mandatory reason), and the signed PDF and its hash.
- `contract_signers`: the required signers. Each signature is stored with its full record: method, typed name and font or strokes, verbatim statement, version and language, approved-PDF hash, record hash, verification method and time, IP and browser.
- `signing_links`: token hash, method, destination, expiry, revocation, use, lock, attempt counter and keyed code hashes.
- Database rules:
  - Closed vocabularies.
  - At most one open round and one completed round per contract.
  - A completed round must have a signed document.
  - A signed signer must have a complete record.
  - Triggers make recorded signatures and closed rounds immutable, stop a used or withdrawn link from being reopened, and refuse deletes.
- RLS is enabled on the new tables, same as all the others.

**Permission**: `contracts.send_for_signature` (team-scopable) is in the Head of Esports and
Esports Manager templates. Migration 0007 adds it to existing roles made from those templates; a
test checks 0005 + 0007 against the templates.

**API**:

- Dashboard routes `/contracts/:id/signing…`: status, start, create or withdraw a signer's link, cancel, signed PDF.
- Public routes `/public/signing/:token…`:
  - before the code check: info, request a code, check a code;
  - with a session: the document on screen, the PDF, sign, and the signed copy.
- Built on the shared services: audit log, notifications, mail (new "signing code" template, no link in it), rate limiter, file store, PDF engine and versions.

**Signed document**: the approved PDF's pages, unchanged, followed by a bilingual signature
record (screenshots 75–76). It shows the contract, legal names, approved version and approver,
and the approved-document hash. For each signer it shows:

- the signature, role, method and time;
- the identity check, IP and browser;
- the statement and the record fingerprint.

The PDF metadata carries the approved hash.

**Dashboard** (Arabic and English, right-to-left, phone width):

- A **Signatures** tab on approved contracts. Before signing starts, it shows who will sign and in which order. During signing, each signer shows their link state, can get a new link or have it withdrawn, and shows whose turn it is. Each signature appears with its details. There's also cancel (with a reason), the signed document with its fingerprint check and download, and earlier cancelled attempts.
- The link dialog offers an email code or an access code and a validity (3/7/14/30 days). The link and the access code are shown once.
- Status banners for awaiting signatures and signed, and a Signed PDF button.
- The Approved view includes contracts out for signature; the Signed view lists signed contracts with their date.
- New notifications and audit actions are translated.
- The quiet Federation/counsel note sits under the Signatures tab.

**Public signing page** `/sign/<token>` (no account; Arabic and English; phone width):

1. Confirm it's you (email code with a resend timer, or an access code; attempts left are shown).
2. Read the approved contract (sandboxed frame), with a PDF download and its fingerprint.
3. Sign: type (with font choices filtered by script) or draw (mouse, touch or pen), then agree to the statement.
4. Confirm in a dialog showing the preview.
5. A "recorded" or "fully signed" page, with download of the executed copy.

The guardian sees a waiting state until the recipient has signed. The page is noindex and
no-referrer.

**Submission now requires the date of birth** (and, for a minor, the guardian's name, relationship
and an email or phone), so the signing step never has to guess whether a guardian must sign.

Screenshots: `docs/screenshots/50-…` to `76-…`.

## Test results (run on 17–18 Oct 2026, in the build workspace)

| Suite                                                                         | Result           |
| ----------------------------------------------------------------------------- | ---------------- |
| `packages/shared` (catalog, finance engine, contracts, signing rules/schemas) | 54 pass, 0 fail  |
| `apps/api` (integration on real Postgres 16 + Redis 7 + Chromium, plus unit)  | 150 pass, 0 fail |
| `apps/web` (catalog parity + every label resolves in both languages)          | 6 pass, 0 fail   |
| ESLint, Prettier, TypeScript (all workspaces)                                 | clean            |
| `next build` (production)                                                     | succeeds         |

- Phase 4 adds 21 tests: 210 in total, up from 189.
- The whole flow was also driven through the real UI in headless Chromium: Next.js, then the `/api` proxy, then NestJS. That run covered link creation, both code methods, waiting, a typed signature, a drawn signature with real pointer events, completion, the signed view, notifications and the audit log. It produced the screenshots.
- The test suites in the table above were then run again from the zip, on a new database.

## Not verified here

- **Real email delivery of signing codes**: there's no SMTP provider yet. The dev outbox carries the codes, and the access-code method works without email.
- **The live Anthropic API**: deferred by your decision. The fake-provider tests stand.
- **Docker image and CI**: there's still no Docker daemon and no GitHub repository here. The signature fonts are npm dependencies of the API, so the existing Dockerfile installs them.
- **Real phones**: the drawing pad was exercised with emulated pointer events at desktop and phone widths, not on physical touch devices.

## Deferred or simplified (and why)

- **Sending the link by email or SMS from the app**: the manager copies the link and passes it on. An emailed code then proves control of the address in the contract. Automatic delivery can come with the SMTP provider and an SMS gateway; the spec doesn't require either.
- **Identity checks beyond a one-time code** (national ID, Nafath, video): out of scope and would need a provider. The record states exactly which check was used.
- **Advanced/qualified electronic signatures** (certificate-based PDF signing, timestamps from a timestamping authority): not built. The integrity here comes from stored hashes, an immutable database record and the audit trail. Whether that is enough for Federation registration is part of the open Federation question; the product makes no claim either way.
- **Amending a signed or approved contract**: still a new contract.
- **Reminders and automatic expiry notifications**: not required by the Definition of Done.

## Needed from you

Still outstanding (all development uses local stand-ins):

- SMTP provider (now also needed for emailed signing codes in production)
- Supabase project
- Redis URL
- `SESSION_SECRET` (also keys the signing-code hashes)
- Hosting choice (Railway or Fly.io)
- Discord OAuth app (optional)
- Product name
- Anthropic API key (deferred; not a blocker)

Open questions:

1. **Saudi Esports Federation confirmation** (spec §7.8): whether in-platform electronic
   signatures and guardian consent are accepted for player registration. The product makes no
   compliance claims. The Signatures tab recommends confirming with the Federation or counsel.
2. **The signing statement** (`consentText` in `packages/shared/src/contracts/i18n.ts`) is
   placeholder wording like the clause templates. Please include it in the legal review that is
   happening outside this build.

Settled this phase: the live Anthropic test is deferred, the clause wording goes ahead as is while
legal review happens elsewhere, and Phase 4 is built per §7.8 without compliance claims. Details
are in `DECISIONS.md`.
