/**
 * ID-document patch to Phase 4 signing, end to end over HTTP against the real app (Postgres,
 * Redis, Chromium). Before the recipient can sign, they upload a photo or scan of a passport or
 * national ID; it is stored encrypted and apart from the contract, viewable only with
 * `contracts.view_signer_id`, every view audited, and never reachable by the AI assistants.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONSENT_VERSION,
  type ContractDto,
  type ContractSigningDto,
  type ContractTypeDto,
  type ConversationDto,
  type PublicSigningSession,
  type PublicSigningVerified,
  type SigningLinkCreatedDto,
} from '@esports/shared';
import { eq, sql } from 'drizzle-orm';
import type {
  AiConverseRequest,
  AiConverseResult,
  AiJsonRequest,
  AiJsonResult,
  AiProvider,
} from '../src/ai/ai.provider';
import { AssistantEngine } from '../src/assistants/assistant-engine';
import { AssistantTools } from '../src/assistants/assistant-tools';
import { auditLogs } from '../src/db/schema';
import { aiToolCalls } from '../src/db/schema-assistants';
import { contractSigners, signerIdDocuments, storedFiles } from '../src/db/schema-contracts';
import { financeOrg, withRole } from './finance-fixtures';
import { inviteAndAccept, startApp, type TestApp } from './harness';

const TODAY = '2026-10-20';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const dir = mkdtempSync(join(tmpdir(), 'esports-signer-id-'));
const pdfImageCount = (bytes: Buffer, name: string) => {
  const p = join(dir, `${name}.pdf`);
  writeFileSync(p, bytes);
  // Header lines, then one line per embedded image.
  return execFileSync('pdfimages', ['-list', p]).toString('utf8').trim().split('\n').length - 2;
};

/** A real 1×1 PNG with a unique marker after it: stands in for a photo of a passport. */
const MARKER = 'IDDOC-MARKER-5b8e0c1f-passport-number-X1234567';
const ID_PHOTO = Buffer.concat([
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  ),
  Buffer.from(MARKER, 'latin1'),
]);
const ID_PDF = Buffer.from(`%PDF-1.4\n% national id scan ${MARKER}\n%%EOF\n`, 'latin1');

// ---------------------------------------------------------------- a fake model that records everything

class RecordingAi implements AiProvider {
  readonly name = 'fake';
  readonly model = 'fake-model';
  readonly configured = true;
  sent: unknown[] = [];
  steps: ((req: AiConverseRequest) => AiConverseResult['blocks'])[] = [];
  async converse(req: AiConverseRequest): Promise<AiConverseResult> {
    this.sent.push(structuredClone(req));
    const step = this.steps.shift();
    const blocks = step ? step(req) : [{ type: 'text' as const, text: 'Done.', citations: [] }];
    return {
      raw: blocks,
      stopReason: blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
      model: this.model,
      usage: { inputTokens: 1, outputTokens: 1, webSearchRequests: 0 },
      blocks,
    };
  }
  async generateJson(req: AiJsonRequest): Promise<AiJsonResult> {
    this.sent.push(structuredClone(req));
    return {
      data: { reply: 'Here is what I found.', claims: [], gaps: [], followUps: [] },
      model: this.model,
      usage: { inputTokens: 1, outputTokens: 1, webSearchRequests: 0 },
    };
  }
}

const ai = new RecordingAi();
let t: TestApp;
beforeAll(async () => {
  t = await startApp({ ai, clock: { today: () => TODAY } });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.app.get(AssistantEngine, { strict: false }).idle();
  await t.reset();
  ai.sent = [];
  ai.steps = [];
});

// ---------------------------------------------------------------- fixtures

async function org() {
  const base = await financeOrg(t);
  const { owner, teamA, teamB } = base;
  const player = (
    await owner.post('/roster-members', {
      teamId: teamA.id,
      fullName: 'Saad Alharbi',
      role: 'starter',
      nationality: 'Saudi',
      dateOfBirth: '2001-04-02',
    })
  ).body as { id: string };
  // Team A's Esports Manager sees, exports and sends contracts for signature — but holds no
  // contracts.view_signer_id.
  const manager = await withRole(t, owner, 'manager@example.com', 'esports_manager', {
    type: 'team',
    id: teamA.id,
  });
  const approverRole = await owner.post('/roles', {
    nameEn: 'Contract approver',
    permissions: ['contracts.view', 'contracts.approve'],
  });
  const approver = await inviteAndAccept(t, owner, 'approver@example.com', [
    { roleId: approverRole.body.id, scopeType: 'organization' },
  ]);
  // Explicitly granted: may view identity documents, for team A only.
  const reviewerRole = await owner.post('/roles', {
    nameEn: 'Identity reviewer',
    permissions: ['contracts.view', 'contracts.view_signer_id'],
  });
  expect(reviewerRole.status).toBe(201);
  const reviewer = await inviteAndAccept(t, owner, 'reviewer@example.com', [
    { roleId: reviewerRole.body.id, scopeType: 'team', scopeId: teamA.id },
  ]);
  const reviewerB = await inviteAndAccept(t, owner, 'reviewer-b@example.com', [
    { roleId: reviewerRole.body.id, scopeType: 'team', scopeId: teamB.id },
  ]);
  return {
    ...base,
    player,
    manager: manager.client,
    approver: approver.client,
    reviewer: reviewer.client,
    reviewerId: reviewer.me.user.id,
    reviewerB: reviewerB.client,
  };
}
type Org = Awaited<ReturnType<typeof org>>;

async function approvedContract(o: Org, minor = false) {
  const types = (await o.manager.get<ContractTypeDto[]>('/contract-types')).body;
  const created = (
    await o.manager.post<ContractDto>('/contracts', {
      contractTypeId: types.find((x) => x.key === 'player')!.id,
      teamId: o.teamA.id,
      rosterMemberId: o.player.id,
    })
  ).body;
  const saved = await o.manager.put<ContractDto>(`/contracts/${created.id}`, {
    teamId: o.teamA.id,
    rosterMemberId: o.player.id,
    details: {
      ...created.snapshot.details,
      recipient: {
        ...created.snapshot.details.recipient,
        fullNameEn: 'Saad Alharbi',
        fullNameAr: 'سعد الحربي',
        email: 'saad@example.com',
        dateOfBirth: minor ? '2010-05-01' : '2001-04-02',
      },
      guardian: minor
        ? {
            fullName: 'Huda Alharbi',
            relationship: 'Mother',
            email: 'huda@example.com',
            phone: null,
          }
        : null,
      role: 'Duelist',
      startDate: '2026-11-01',
      endDate: '2027-10-31',
      compensation: { amount: '12000', currency: 'SAR', frequency: 'monthly' },
    },
    clauses: created.snapshot.clauses,
  });
  expect(saved.status).toBe(200);
  expect((await o.manager.post(`/contracts/${created.id}/submit`, {})).status).toBe(200);
  const ok = await o.approver.post<ContractDto>(`/contracts/${created.id}/approve`, {});
  expect(ok.body.status).toBe('approved');
  return ok.body;
}

async function startSigning(o: Org, id: string) {
  const res = await o.manager.post<ContractSigningDto>(`/contracts/${id}/signing`);
  expect(res.status).toBe(200);
  return res.body.rounds[0]!;
}

/** A signing-page response: the session, or an error. */
type Answer = PublicSigningSession & { error?: { code: string } };

/** Creates an access-code link for a signer and opens it: a verified signing session. */
async function open(o: Org, contractId: string, signerId: string) {
  const l = (
    await o.manager.post<SigningLinkCreatedDto>(
      `/contracts/${contractId}/signing/signers/${signerId}/link`,
      { method: 'access_code' },
    )
  ).body;
  const c = t.client();
  const token = l.url.split('/sign/')[1]!;
  const v = await c.post<PublicSigningVerified>(`/public/signing/${token}/verify`, {
    code: l.accessCode,
  });
  expect(v.status).toBe(200);
  const session = v.body.sessionToken;
  return {
    c,
    token,
    session,
    state: v.body.session,
    upload: (data: Uint8Array, contentType: string | null, type = 'passport') =>
      c.request<Answer>('POST', `/public/signing/${token}/id-document?type=${type}`, data, {
        ...(contentType ? { 'content-type': contentType } : {}),
        'x-signing-session': session,
      }),
    sign: () =>
      c.request<Answer>(
        'POST',
        `/public/signing/${token}/sign`,
        {
          method: 'typed',
          typedName: 'Saad Alharbi',
          fontKey: 'dancing-script',
          locale: 'en',
          consentVersion: CONSENT_VERSION,
          consent: true,
          confirm: true,
        },
        { 'x-signing-session': session },
      ),
  };
}

/** An adult's contract signed by the recipient with an uploaded passport photo. */
async function signedWithId(o: Org) {
  const c = await approvedContract(o);
  const round = await startSigning(o, c.id);
  const s = await open(o, c.id, round.signers[0]!.id);
  expect((await s.upload(ID_PHOTO, 'image/png')).status).toBe(200);
  expect((await s.sign()).body.state).toBe('completed');
  const [doc] = await t.db.select().from(signerIdDocuments);
  return { c, round, s, doc: doc! };
}

const viewPath = (contractId: string, documentId: string) =>
  `/contracts/${contractId}/signing/id-documents/${documentId}`;

// ---------------------------------------------------------------- tests

describe('ID document before signing (recipient only)', () => {
  test('signing cannot complete without an uploaded identity document; the guardian is not asked', async () => {
    const o = await org();
    const c = await approvedContract(o, true);
    const round = await startSigning(o, c.id);
    const [recipient, guardian] = round.signers;
    expect(recipient!.idDocument).toEqual({ required: true, provided: false, details: null });
    expect(guardian!.idDocument).toEqual({ required: false, provided: false, details: null });

    const r = await open(o, c.id, recipient!.id);
    expect(r.state.idDocument).toEqual({ required: true, uploaded: null });
    const blocked = await r.sign();
    expect([blocked.status, blocked.body.error?.code]).toEqual([409, 'id_document_required']);
    // Nothing was recorded: still pending, link unused, contract still out for signature.
    const [row] = await t.db
      .select()
      .from(contractSigners)
      .where(eq(contractSigners.id, recipient!.id));
    expect(row!.status).toBe('pending');
    expect((await o.manager.get<ContractDto>(`/contracts/${c.id}`)).body.status).toBe(
      'awaiting_signatures',
    );
    // Not even directly in the database: a recipient's signature needs a document.
    await expect(
      Promise.resolve(
        t.db.execute(
          sql`update app.contract_signers set status = 'signed', signed_at = now(), signature_method = 'typed', consent_text = 'x', document_sha256 = 'x', verified_at = now(), record_sha256 = 'x' where id = ${recipient!.id}`,
        ),
      ),
    ).rejects.toThrow();

    // With the document, the recipient signs; the signature points at it.
    const up = await r.upload(ID_PHOTO, 'image/png');
    expect(up.status).toBe(200);
    expect(up.body.idDocument.uploaded).toMatchObject({
      documentType: 'passport',
      contentType: 'image/png',
      sizeBytes: ID_PHOTO.length,
    });
    // The signing page never gets the file back.
    expect(up.text).not.toContain(MARKER);
    expect(up.text).not.toContain(ID_PHOTO.toString('base64').slice(0, 40));
    expect((await r.sign()).body.state).toBe('signed');
    const [doc] = await t.db.select().from(signerIdDocuments);
    const [signedRow] = await t.db
      .select()
      .from(contractSigners)
      .where(eq(contractSigners.id, recipient!.id));
    expect(signedRow!.idDocumentId).toBe(doc!.id);

    // The guardian signs without one, and can't upload one either.
    const g = await open(o, c.id, guardian!.id);
    expect(g.state.idDocument).toEqual({ required: false, uploaded: null });
    const notNeeded = await g.upload(ID_PHOTO, 'image/png');
    expect([notNeeded.status, notNeeded.body.error?.code]).toEqual([400, 'id_document_not_needed']);
    expect((await g.sign()).body.state).toBe('completed');

    // After signing, the document can't be replaced.
    const late = await r.upload(ID_PHOTO, 'image/png');
    expect([late.status, late.body.error?.code]).toEqual([409, 'already_signed']);
    expect(await t.db.select().from(signerIdDocuments)).toHaveLength(1);
  });

  test('a replaced upload stays on record; the signature binds the current one', async () => {
    const o = await org();
    const c = await approvedContract(o);
    const round = await startSigning(o, c.id);
    const r = await open(o, c.id, round.signers[0]!.id);
    expect((await r.upload(ID_PHOTO, 'image/png')).status).toBe(200);
    expect((await r.upload(ID_PDF, 'application/pdf', 'national_id')).status).toBe(200);
    expect((await r.sign()).body.state).toBe('completed');
    const docs = await t.db.select().from(signerIdDocuments);
    expect(docs.map((d) => [d.documentType, d.contentType, !!d.supersededAt]).sort()).toEqual([
      ['national_id', 'application/pdf', false],
      ['passport', 'image/png', true],
    ]);
    const [row] = await t.db.select().from(contractSigners);
    expect(row!.idDocumentId).toBe(docs.find((d) => !d.supersededAt)!.id);
    const st = (await o.owner.get<ContractSigningDto>(`/contracts/${c.id}/signing`)).body;
    expect(
      st.rounds[0]!.signers[0]!.idDocument.details!.map((d) => [d.documentType, d.current]),
    ).toEqual([
      ['national_id', true],
      ['passport', false],
    ]);
  });

  test('invalid uploads are refused: empty, wrong type, disguised type, too large, no session', async () => {
    const o = await org();
    const c = await approvedContract(o);
    const round = await startSigning(o, c.id);
    const r = await open(o, c.id, round.signers[0]!.id);
    const refused = async (data: Uint8Array, type: string | null) => {
      const res = await r.upload(data, type);
      return [res.status, res.body?.error?.code];
    };
    // Zero bytes.
    expect(await refused(new Uint8Array(0), 'image/png')).toEqual([400, 'validation_failed']);
    expect(await refused(new Uint8Array(0), null)).toEqual([400, 'validation_failed']);
    // Not an image or PDF, whatever it says it is.
    expect(await refused(Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'), 'image/gif')).toEqual([
      415,
      'unsupported_file_type',
    ]);
    expect(await refused(Buffer.from('just some text'), 'text/plain')).toEqual([
      415,
      'unsupported_file_type',
    ]);
    // Disguised: an executable (or HTML, or a GIF) labelled as an accepted type…
    const exe = Buffer.concat([Buffer.from('MZ\x90\x00', 'latin1'), Buffer.alloc(64)]);
    expect(await refused(exe, 'image/png')).toEqual([415, 'unsupported_file_type']);
    expect(await refused(exe, 'application/pdf')).toEqual([415, 'unsupported_file_type']);
    expect(await refused(Buffer.from('<html><script>x</script>'), 'image/jpeg')).toEqual([
      415,
      'unsupported_file_type',
    ]);
    expect(await refused(Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'), 'image/png')).toEqual([
      415,
      'unsupported_file_type',
    ]);
    // …or an accepted type labelled as another (a PDF sent as a JPEG photo).
    expect(await refused(ID_PDF, 'image/jpeg')).toEqual([415, 'unsupported_file_type']);
    expect(await t.db.select().from(signerIdDocuments)).toHaveLength(0);
  });

  test('…too large, unknown type, no session; uploads are rate limited; valid ones are accepted', async () => {
    const o = await org();
    const c = await approvedContract(o);
    const round = await startSigning(o, c.id);
    const r = await open(o, c.id, round.signers[0]!.id);
    const refused = async (data: Uint8Array, type: string | null) => {
      const res = await r.upload(data, type);
      return [res.status, res.body?.error?.code];
    };
    // Over 8 MB.
    const big = Buffer.concat([ID_PHOTO, Buffer.alloc(8 * 1024 * 1024)]);
    expect(await refused(big, 'image/png')).toEqual([413, 'file_too_large']);
    // An unknown document type.
    expect((await r.upload(ID_PHOTO, 'image/png', 'driving_licence')).status).toBe(400);
    // Without a verified session.
    const anon = await t
      .client()
      .request('POST', `/public/signing/${r.token}/id-document?type=passport`, ID_PHOTO, {
        'content-type': 'image/png',
      });
    expect([anon.status, anon.body.error.code]).toEqual([401, 'verification_required']);
    // None of it was stored.
    expect(await t.db.select().from(signerIdDocuments)).toHaveLength(0);
    expect(
      await t.db.select().from(storedFiles).where(eq(storedFiles.kind, 'signer_id_document')),
    ).toHaveLength(0);
    // PDF, JPEG and WebP are accepted, checked by their bytes (each replaces the previous one).
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);
    const webp = Buffer.concat([
      Buffer.from('RIFF', 'latin1'),
      Buffer.alloc(4),
      Buffer.from('WEBPVP8 ', 'latin1'),
      Buffer.alloc(16, 2),
    ]);
    expect((await r.upload(ID_PDF, 'application/pdf', 'national_id')).status).toBe(200);
    expect((await r.upload(jpeg, 'image/jpeg')).status).toBe(200);
    const w = await r.upload(webp, 'image/webp');
    expect(w.body.idDocument.uploaded).toMatchObject({ contentType: 'image/webp' });
    // At most 10 upload attempts per 15 minutes from one address (6 so far).
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await r.upload(jpeg, 'image/jpeg')).status);
    expect(statuses).toEqual([200, 200, 200, 200, 429]);
  });
});

describe('who can see it', () => {
  test('contracts.view (or export, approve, send for signature) is not enough; only the explicit permission, in scope', async () => {
    const o = await org();
    const { c, doc } = await signedWithId(o);
    const path = viewPath(c.id, doc.id);

    // The manager can view, export and send this contract — and still can't see the document.
    expect((await o.manager.get(`/contracts/${c.id}`)).status).toBe(200);
    expect((await o.manager.get(`/contracts/${c.id}/signed.pdf`)).status).toBe(200);
    const m = await o.manager.get(path);
    expect([m.status, m.body.error.code]).toEqual([403, 'forbidden']);
    const ap = await o.approver.get(path);
    expect(ap.status).toBe(403);
    // Their signing status says a document was provided, nothing about it.
    const ms = (await o.manager.get<ContractSigningDto>(`/contracts/${c.id}/signing`)).body;
    expect(ms.rounds[0]!.signers[0]!.idDocument).toEqual({
      required: true,
      provided: true,
      details: null,
    });
    expect(JSON.stringify(ms)).not.toContain(doc.id);
    expect(JSON.stringify(ms)).not.toContain(doc.sha256);

    // Granted for another team: the contract itself isn't visible.
    expect((await o.reviewerB.get(path)).status).toBe(404);
    // Not signed in.
    expect((await t.client().get(path)).status).toBe(401);

    // Explicitly granted for team A, and the Owner: the document, exactly as uploaded.
    for (const who of [o.reviewer, o.owner]) {
      const res = await who.get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-security-policy')).toContain('sandbox');
      expect(sha(res.bytes)).toBe(sha(ID_PHOTO));
    }
    const rs = (await o.reviewer.get<ContractSigningDto>(`/contracts/${c.id}/signing`)).body;
    expect(rs.rounds[0]!.signers[0]!.idDocument.details).toEqual([
      {
        id: doc.id,
        documentType: 'passport',
        contentType: 'image/png',
        sizeBytes: ID_PHOTO.length,
        sha256: sha(ID_PHOTO),
        uploadedAt: doc.uploadedAt.toISOString(),
        current: true,
      },
    ]);
    // A document id from another contract isn't served through this one.
    const other = await approvedContract(o);
    expect((await o.owner.get(viewPath(other.id, doc.id))).status).toBe(404);
  });

  test('every view is written to the audit log (and the upload too)', async () => {
    const o = await org();
    const { c, doc } = await signedWithId(o);
    await o.reviewer.get(viewPath(c.id, doc.id));
    await o.reviewer.get(viewPath(c.id, doc.id));
    await o.owner.get(viewPath(c.id, doc.id));
    await o.manager.get(viewPath(c.id, doc.id)); // refused: not a view
    const views = await t.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'contract.signer_id_viewed'))
      .orderBy(auditLogs.id);
    expect(views.map((v) => [v.actorUserId, v.actorType, v.targetId])).toEqual([
      [o.reviewerId, 'user', c.id],
      [o.reviewerId, 'user', c.id],
      [o.ownerId, 'user', c.id],
    ]);
    expect(views[0]!.metadata).toMatchObject({
      number: c.number,
      documentId: doc.id,
      signerId: doc.signerId,
      documentType: 'passport',
      sha256: sha(ID_PHOTO),
    });
    const [upload] = await t.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'contract.signer_id_uploaded'));
    expect(upload).toMatchObject({ actorType: 'anonymous', targetId: c.id });
    expect(upload!.metadata).toMatchObject({ documentId: doc.id, replaced: false });
    // The log holds facts about the document, never its content.
    expect(JSON.stringify([...views, upload])).not.toContain(MARKER);
  });
});

describe('kept apart from the contract', () => {
  test('the ID file is not in anything an ordinary viewer sees, and is encrypted at rest', async () => {
    const o = await org();
    const { c, doc, s } = await signedWithId(o);
    const approved = await o.manager.get(`/contracts/${c.id}/approved.pdf`);
    const signed = await o.manager.get(`/contracts/${c.id}/signed.pdf`);
    const contract = await o.manager.get(`/contracts/${c.id}`);
    const preview = await o.manager.get(`/contracts/${c.id}/preview`);
    const signerCopy = await s.c.request(
      'GET',
      `/public/signing/${s.token}/signed.pdf`,
      undefined,
      {
        'x-signing-session': s.session,
      },
    );
    expect([approved.status, signed.status, contract.status, signerCopy.status]).toEqual([
      200, 200, 200, 200,
    ]);
    for (const res of [approved, signed, contract, preview, signerCopy]) {
      expect(res.bytes.includes(Buffer.from(MARKER))).toBe(false);
      expect(res.text).not.toContain(doc.id);
    }
    expect(contract.text).not.toContain(doc.fileId);
    // The signed PDF embeds no image the approved PDF didn't have: the record holds only the
    // document's fingerprint.
    expect(pdfImageCount(signed.bytes, 'signed')).toBe(pdfImageCount(approved.bytes, 'approved'));
    // The stored bytes are encrypted: neither the photo nor the marker is readable in the database.
    const [file] = await t.db.select().from(storedFiles).where(eq(storedFiles.id, doc.fileId));
    expect(file!.kind).toBe('signer_id_document');
    expect(file!.contentType).toBe('application/octet-stream');
    expect(file!.data.includes(Buffer.from(MARKER))).toBe(false);
    expect(file!.data.includes(ID_PHOTO.subarray(0, 16))).toBe(false);
    // The generic file route never serves it.
    expect((await o.owner.get(`/files/${doc.fileId}`)).status).toBe(404);
    // Kept as given: the database refuses to edit or delete the record or its file.
    for (const q of [
      sql`delete from app.signer_id_documents where id = ${doc.id}`,
      sql`update app.signer_id_documents set document_type = 'national_id' where id = ${doc.id}`,
      sql`update app.signer_id_documents set superseded_at = now() where id = ${doc.id}`,
      sql`delete from app.stored_files where id = ${doc.fileId}`,
    ])
      await expect(Promise.resolve(t.db.execute(q))).rejects.toThrow();
  });

  test('a stored document that fails its checks is not served', async () => {
    const o = await org();
    const { c, doc } = await signedWithId(o);
    // Point the record at a different encrypted blob (as a corrupted copy would look).
    const forged = Buffer.from('ESID1' + 'x'.repeat(60), 'latin1');
    const [f] = await t.db
      .insert(storedFiles)
      .values({
        organizationId: doc.organizationId,
        kind: 'signer_id_document',
        contentType: 'application/octet-stream',
        sizeBytes: forged.length,
        sha256: sha(forged),
        data: forged,
      })
      .returning();
    await t.db.execute(
      sql`alter table app.signer_id_documents disable trigger signer_id_documents_guard`,
    );
    await t.db.execute(
      sql`update app.signer_id_documents set file_id = ${f!.id} where id = ${doc.id}`,
    );
    await t.db.execute(
      sql`alter table app.signer_id_documents enable trigger signer_id_documents_guard`,
    );
    const res = await o.owner.get(viewPath(c.id, doc.id));
    expect(res.status).toBe(500);
    expect(res.bytes.includes(Buffer.from(MARKER))).toBe(false);
    expect(
      await t.db.select().from(auditLogs).where(eq(auditLogs.action, 'contract.signer_id_viewed')),
    ).toHaveLength(0);
  });
});

describe('never reachable by the AI assistants', () => {
  test('no assistant tool is about identity documents', () => {
    const tools = t.app.get(AssistantTools, { strict: false }).all;
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      const described = JSON.stringify([
        tool.name,
        tool.description,
        tool.inputSchema,
        tool.requires,
      ]);
      expect({
        tool: tool.name,
        mentions: /signer_id|id[_ ]?document|passport|national[_ ]?id|identity|stored_?file/i.test(
          described,
        ),
      }).toEqual({ tool: tool.name, mentions: false });
    }
  });

  test('the assistant and AI code never import the document service, its table or the file store', () => {
    const root = join(import.meta.dir, '..', 'src');
    const files = (d: string): string[] =>
      readdirSync(d).flatMap((n) => {
        const p = join(d, n);
        return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
      });
    const checked = [...files(join(root, 'assistants')), ...files(join(root, 'ai'))];
    expect(checked.length).toBeGreaterThan(5);
    for (const f of checked) {
      const src = readFileSync(f, 'utf8');
      expect({
        f,
        reaches:
          /signer-id|signerIdDocuments|signer_id_documents|view_signer_id|storedFiles|FilesService|files\.service|contractSigners|signing\.service/.test(
            src,
          ),
      }).toEqual({ f, reaches: false });
    }
  });

  test('an Owner asking every lookup about the signed contract gets nothing from the document', async () => {
    const o = await org();
    const { c, doc } = await signedWithId(o);
    // The model asks for every lookup it has — and for document tools that don't exist.
    ai.steps.push(() => [
      { type: 'tool_use', id: 'toolu_1', name: 'list_teams', input: {} },
      { type: 'tool_use', id: 'toolu_2', name: 'list_roster', input: { teamId: o.teamA.id } },
      {
        type: 'tool_use',
        id: 'toolu_3',
        name: 'get_roster_member',
        input: { rosterMemberId: o.player.id },
      },
      {
        type: 'tool_use',
        id: 'toolu_4',
        name: 'get_finance_summary',
        input: { scope: 'organization' },
      },
      { type: 'tool_use', id: 'toolu_5', name: 'list_budgets', input: {} },
      { type: 'tool_use', id: 'toolu_6', name: 'list_contracts', input: { search: c.number } },
      { type: 'tool_use', id: 'toolu_7', name: 'get_contract_terms', input: { contractId: c.id } },
      { type: 'tool_use', id: 'toolu_8', name: 'list_tournaments', input: {} },
      {
        type: 'tool_use',
        id: 'toolu_9',
        name: 'get_signer_id_document',
        input: { contractId: c.id },
      },
    ]);
    ai.steps.push(() => [
      {
        type: 'tool_use',
        id: 'toolu_10',
        name: 'download_file',
        input: { fileId: 'the-latest-upload' },
      },
    ]);
    const conv = (
      await o.owner.post<ConversationDto>('/assistants/conversations', { assistant: 'general' })
    ).body;
    const sent = await o.owner.post(`/assistants/conversations/${conv.id}/messages`, {
      text: `Show me the signed contract ${c.number}, the passport the player uploaded and its number.`,
    });
    expect(sent.status).toBe(202);
    await t.app.get(AssistantEngine, { strict: false }).idle();

    // The contract terms were looked up for real…
    const calls = await t.db
      .select()
      .from(aiToolCalls)
      .where(eq(aiToolCalls.conversationId, conv.id));
    expect(calls.find((x) => x.tool === 'get_contract_terms')!.outcome).toBe('ok');
    // …the made-up document tools were refused…
    expect(
      calls
        .filter((x) => x.outcome === 'unknown_tool')
        .map((x) => x.tool)
        .sort(),
    ).toEqual(['download_file', 'get_signer_id_document']);
    // …and nothing sent to the model carries the document, its ids, its fingerprint or its type.
    const everything = JSON.stringify(ai.sent);
    expect(everything).toContain(c.number);
    for (const forbidden of [
      MARKER,
      doc.id,
      doc.fileId,
      doc.sha256,
      ID_PHOTO.toString('base64').slice(0, 40),
      'national_id',
      'idDocument',
      // (Not "signer_id": the model's own made-up tool name is echoed back in its refusal.)
    ])
      expect({ forbidden, found: everything.includes(forbidden) }).toEqual({
        forbidden,
        found: false,
      });
    // The user's own words reach the model, of course — but no lookup result mentions a passport.
    const results = ai.sent.flatMap((r) =>
      ((r as AiConverseRequest).messages ?? []).flatMap((m) =>
        m.role === 'tool_results' ? m.results.map((x) => x.content) : [],
      ),
    );
    expect(results.length).toBeGreaterThan(5);
    expect(JSON.stringify(results)).not.toMatch(/passport/i);
  });
});
