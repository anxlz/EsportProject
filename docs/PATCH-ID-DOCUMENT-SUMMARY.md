# Patch — ID document upload during contract signing: summary

> A scoped patch to the Phase 4 signing flow, built on tag `phase-6` (tagged `patch-id-document`).
> Before the **recipient** can sign, they upload a photo or scan of a passport or national ID. It
> is stored encrypted and apart from the contract, viewable only with a new permission, every view
> audited, and never reachable by the AI assistants. **Retention and deletion are not decided in
> code** — they are an open question for you (below).

## Required test coverage

All in `apps/api/test/signer-id.test.ts` (11 tests) unless noted.

| Requirement                                                      | Status | Where it is checked                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signing cannot complete without an uploaded ID document          | Done   | `signing cannot complete without an uploaded identity document; the guardian is not asked`: the sign request gets 409 `id_document_required` and nothing is recorded; a direct database update to "signed" without a document is refused too. With the document, the signature points at it. The guardian signs without one.       |
| A user with only general `contracts.view` is refused the file    | Done   | `contracts.view (or export, approve, send for signature) is not enough…`: the team's Esports Manager (view, export, send for signature) and an approver get 403; a reviewer granted the permission for another team gets 404; the reviewer granted it for this team and the Owner get the exact bytes.                             |
| The ID file is not in the contract document ordinary viewers see | Done   | `the ID file is not in anything an ordinary viewer sees, and is encrypted at rest`: contract JSON, preview, approved PDF, signed PDF and the signer's copy contain neither the file nor its ids; the signed PDF embeds no image the approved PDF didn't have; the generic file route returns 404; the stored bytes are ciphertext. |
| No AI assistant tool or lookup can retrieve it or derived data   | Done   | Three tests: no tool is about identity documents; `src/assistants` and `src/ai` never import the document service, its table, the file store or the signing tables (also enforced by ESLint); an Owner runs every lookup on the signed contract plus made-up document tools — nothing about the document reaches the model.        |
| Invalid uploads (wrong type, zero-byte, disguised) are rejected  | Done   | Two tests: empty (400), GIF and text (415), an executable/HTML/GIF labelled as PNG, JPEG or PDF (415), a PDF labelled as JPEG (415), over 8 MB (413), unknown document type (400), no session (401); nothing stored. PDF, JPEG and WebP accepted; uploads rate limited.                                                            |
| Every view of a stored ID document is audited                    | Done   | `every view is written to the audit log (and the upload too)`: three views → three `contract.signer_id_viewed` entries with the viewer, contract, document id and fingerprint; a refused attempt isn't a view; no content in the log. A document that fails its integrity check isn't served and isn't logged as viewed.           |

## Built

**Signing page** `/sign/<token>` (Arabic and English, phone width; screenshots 109–111, 115):

- A new step after the code check: **Your identity document** — choose Passport or National ID
  card, choose a file or take a photo (JPEG, PNG, WebP or PDF, up to 8 MB), local preview,
  Upload. Then "Received: National ID card · JPEG · 53 KB · time" with Replace.
- "Review and sign" stays disabled, with a note, until the document is in.
- A plain note: only people the organization authorizes can view it, every view is recorded, it's
  kept apart from the contract and never shared with AI assistants; it adds to the record of who
  signed and is not an official identity check.
- The page never receives the file back.

**Signatures tab** (screenshots 112–113): each recipient shows "Identity document: Provided / Not
uploaded yet". Holders of the permission also see each upload (type, format, size, time, used /
replaced) and **View**, which opens the image (or downloads a PDF) with "Each view is recorded in
the audit log". Others see that viewing needs the permission. Audit log labels for both new
actions (screenshot 114).

**API**:

- `POST /public/signing/:token/id-document?type=passport|national_id` (raw body, verified session,
  rate limited) and `GET /contracts/:id/signing/id-documents/:documentId` (permission, audited,
  `no-store`, sandbox CSP).
- `SignerIdService` (`src/contracts/signer-id.service.ts`): byte validation, AES-256-GCM
  encryption, upload/replace, metadata for the status, audited viewing with an integrity check.
  Not exported from the contracts module.
- The signing service requires the document for recipients, binds its id and fingerprint into the
  signature record hash, and the signed PDF's record shows the fingerprint (not the document).

**Data model**: migrations `0012_signer_id_documents` (generated) and `0013_signer_id_hardening`
(hand-written): the `signer_id_documents` table with RLS, vocabulary/size/hash checks, one current
upload per signer, a foreign key from the signature, the recipient-needs-a-document rule
(`NOT VALID`, so earlier signatures stay as they were), a must-be-this-signer's-current-upload
trigger, and triggers that refuse edits and deletes of the records and their files.

**Permission**: `contracts.view_signer_id` (team-scopable; Owner holds it; in no default template,
so nothing is backfilled). `docs/PERMISSIONS.md` regenerated.

**Configuration**: `DOCUMENT_ENCRYPTION_KEY` — required in production (the API refuses to start
without it), derived from `SESSION_SECRET` elsewhere. The raw upload limit is now 9 MB (each kind
keeps its own limit).

## Test results (run on 20 Oct 2026, in the build workspace)

Baseline at `phase-6` before any change: shared 80, API 235, web 9 — all passing.

| Suite                                                                                | Result           |
| ------------------------------------------------------------------------------------ | ---------------- |
| `packages/shared`                                                                    | 80 pass, 0 fail  |
| `apps/api` (integration on real Postgres 16 + Redis 7 + Chromium, plus unit tests)   | 247 pass, 0 fail |
| `apps/web` (catalog parity; every label, incl. the new permission, errors and audit) | 9 pass, 0 fail   |
| ESLint (incl. the new AI import boundary), Prettier, TypeScript (all workspaces)     | clean            |
| `next build` (production)                                                            | succeeds         |

- The patch adds 12 tests (11 ID-document tests, 1 environment test): 336 in total, up from 324.
- Existing tests updated because the rule changed, not loosened: four Phase 4 signing tests now
  upload a document before the recipient signs; the Definition of Done test's audit trail includes
  the upload and its record hash includes the document's fingerprint; the storage test expects the
  separate document file; the production-environment test sets the new key.
- The ESLint boundary was checked by adding a forbidden import to an assistants file: ESLint
  reported both the service and the table import.
- The whole flow was driven in the real UI (Next.js → `/api` proxy → NestJS) in headless Chromium:
  the recipient verified, uploaded a fictional specimen card and signed in Arabic at phone width;
  the manager saw only "Provided"; the Owner opened it and the view appeared in the audit log. No
  horizontal overflow, no untranslated keys.

## Not verified here

- Real phones: file picking and camera capture were exercised with Playwright's file chooser, not
  on physical devices (iOS HEIC conversion in particular).
- Real ID documents: the run used a generated "SPECIMEN" image.

## Deferred or simplified (and why)

- **Retention and deletion**: not decided in code — see below. Nothing is deleted meanwhile.
- **Guardians**: not asked for a document, as specified; extending it is a separate decision.
- **Reading the document** (OCR, matching the name or number to the contract, liveness, Nafath):
  not built. Collecting the image is all that was asked; any automated check would need a provider
  and its own privacy review. Reviewers compare it by eye.
- **Logging refused view attempts**: a 403 is not a view and isn't logged as one; the API's
  standard error logging applies. Easy to add if you want denied attempts on record too.
- **Malware scanning of uploads**: files are type-checked by their bytes and never rendered on the
  platform's origin (sandbox CSP, `nosniff`, PDFs downloaded), but not virus-scanned; that needs a
  scanning service.

## Needed from you

1. **Retention and deletion policy for ID documents** (open question): how long they are kept —
   including replaced uploads — and whether a signer and/or the organization can request
   deletion (and who approves it). Until you decide, they are kept, encrypted, with no way to
   delete them in the app or the database.
2. **`DOCUMENT_ENCRYPTION_KEY`** for production (32+ characters; keep it like a backup key).
3. Whether ID collection needs a line in your privacy notice / consent wording (part of the legal
   review happening outside this build), and where the database is hosted relative to Saudi PDPL
   cross-border rules.

Still outstanding from before: SMTP provider, Supabase project, Redis URL, `SESSION_SECRET`,
hosting (Railway or Fly.io), Discord OAuth (optional), product name, Anthropic API key, Qwen3 key
(optional), Google OAuth app (optional). Legal review and the Saudi Esports Federation confirmation
stay outside this build; the product makes no compliance claim about ID collection or signatures.
