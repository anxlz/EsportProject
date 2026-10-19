/**
 * Phase 4 — Electronic signatures, end to end over HTTP against the real app (Postgres, Redis,
 * Chromium). The Definition of Done flow is the first suite: an approved contract for a minor is
 * sent for signature, signed by the recipient and then by the guardian, and the fully executed
 * document appears in the signed view with an intact audit trail.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONSENT_VERSION,
  type ContractDto,
  type ContractSigningDto,
  type ContractSummaryDto,
  type ContractTypeDto,
  type PublicSigningInfo,
  type PublicSigningVerified,
  type SigningLinkCreatedDto,
} from '@esports/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { auditLogs, devOutbox, notifications } from '../src/db/schema';
import {
  approvalRequests,
  contractSigners,
  signingLinks,
  signingRounds,
  storedFiles,
} from '../src/db/schema-contracts';
import { canonicalJson } from '../src/versioning/versioning.service';
import { financeOrg, withRole } from './finance-fixtures';
import { type Client, inviteAndAccept, startApp, type TestApp } from './harness';

const TODAY = '2026-10-17';
const dir = mkdtempSync(join(tmpdir(), 'esports-signing-'));
const pdfText = (bytes: Buffer, name: string) => {
  const p = join(dir, `${name}.pdf`);
  writeFileSync(p, bytes);
  return execFileSync('pdftotext', ['-raw', p, '-'])
    .toString('utf8')
    .replace(/[⁦-⁩]/g, '')
    .replace(/\s+/g, ' ');
};
const pdfFonts = (bytes: Buffer, name: string) => {
  const p = join(dir, `${name}-f.pdf`);
  writeFileSync(p, bytes);
  return execFileSync('pdffonts', [p]).toString('utf8');
};
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let t: TestApp;
beforeAll(async () => {
  t = await startApp({ clock: { today: () => TODAY } });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
});

// ------------------------------------------------------------------------------------------------
// Fixtures

async function signingOrg() {
  const base = await financeOrg(t);
  const { owner, teamA } = base;
  const player = (
    await owner.post('/roster-members', {
      teamId: teamA.id,
      fullName: 'Saad Alharbi',
      role: 'starter',
      nationality: 'Saudi',
      dateOfBirth: '2001-04-02',
    })
  ).body as { id: string };
  // Team A manager: drafts, sends for signature (template role, Phase 4 permission included).
  const manager = await withRole(t, owner, 'manager@example.com', 'esports_manager', {
    type: 'team',
    id: teamA.id,
  });
  const role = await owner.post('/roles', {
    nameEn: 'Contract approver',
    permissions: ['contracts.view', 'contracts.approve'],
  });
  const approver = await inviteAndAccept(
    t,
    owner,
    'approver@example.com',
    [{ roleId: role.body.id, scopeType: 'organization' }],
    'Noura Approver',
  );
  return {
    ...base,
    player,
    manager: manager.client,
    managerId: manager.me.user.id,
    approver: approver.client,
    approverId: approver.me.user.id,
  };
}
type Org = Awaited<ReturnType<typeof signingOrg>>;

const GUARDIAN = {
  fullName: 'Huda Alharbi',
  relationship: 'Mother',
  email: 'huda@example.com',
  phone: null,
};

/** Draft → submit → approve. `minor`: the recipient is 16 today and a guardian is named. */
async function approvedContract(org: Org, opts: { minor?: boolean; language?: string } = {}) {
  const types = (await org.manager.get<ContractTypeDto[]>('/contract-types')).body;
  const created = (
    await org.manager.post<ContractDto>('/contracts', {
      contractTypeId: types.find((x) => x.key === 'player')!.id,
      teamId: org.teamA.id,
      rosterMemberId: org.player.id,
    })
  ).body;
  const details = {
    ...created.snapshot.details,
    ...(opts.language ? { language: opts.language } : {}),
    recipient: {
      ...created.snapshot.details.recipient,
      fullNameEn: 'Saad Alharbi',
      fullNameAr: 'سعد الحربي',
      email: 'saad@example.com',
      dateOfBirth: opts.minor ? '2010-05-01' : '2001-04-02',
    },
    guardian: opts.minor ? GUARDIAN : null,
    role: 'Duelist',
    startDate: '2026-11-01',
    endDate: '2027-10-31',
    compensation: { amount: '12000', currency: 'SAR', frequency: 'monthly' },
  };
  const saved = await org.manager.put<ContractDto>(`/contracts/${created.id}`, {
    teamId: org.teamA.id,
    rosterMemberId: org.player.id,
    details,
    clauses: created.snapshot.clauses,
  });
  expect(saved.status).toBe(200);
  expect(saved.body.missing).toEqual([]);
  expect((await org.manager.post(`/contracts/${created.id}/submit`, {})).status).toBe(200);
  const ok = await org.approver.post<ContractDto>(`/contracts/${created.id}/approve`, {});
  expect(ok.status).toBe(200);
  expect(ok.body.status).toBe('approved');
  return ok.body;
}

const pub = () => t.client();
const tokenOf = (url: string) => url.split('/sign/')[1]!;
const withSession = (c: Client, method: string, path: string, session: string, body?: unknown) =>
  c.request(method, path, body, { 'x-signing-session': session });

async function emailedCode(to: string) {
  const [row] = await t.db
    .select()
    .from(devOutbox)
    .where(and(eq(devOutbox.to, to), eq(devOutbox.template, 'signing_code')))
    .orderBy(sql`${devOutbox.createdAt} desc`)
    .limit(1);
  const m = row?.text.match(/^(\d{6})$/m);
  if (!m) throw new Error(`no code emailed to ${to}`);
  return m[1]!;
}

async function startSigning(org: Org, id: string) {
  const res = await org.manager.post<ContractSigningDto>(`/contracts/${id}/signing`);
  expect(res.status).toBe(200);
  return res.body;
}

async function link(
  org: Org,
  id: string,
  signerId: string,
  body: Record<string, unknown> = { method: 'access_code' },
) {
  const res = await org.manager.post<SigningLinkCreatedDto>(
    `/contracts/${id}/signing/signers/${signerId}/link`,
    body,
  );
  expect(res.status).toBe(200);
  return res.body;
}

/** Opens a link with its access code; returns the session token. */
async function openWithAccessCode(c: Client, l: SigningLinkCreatedDto) {
  const token = tokenOf(l.url);
  const v = await c.post<PublicSigningVerified>(`/public/signing/${token}/verify`, {
    code: l.accessCode,
  });
  expect(v.status).toBe(200);
  return { token, session: v.body.sessionToken, state: v.body.session };
}

const typed = (name: string, fontKey = 'dancing-script', locale = 'en') => ({
  method: 'typed',
  typedName: name,
  fontKey,
  locale,
  consentVersion: CONSENT_VERSION,
  consent: true,
  confirm: true,
});
const drawn = (locale = 'ar') => ({
  method: 'drawn',
  strokes: [
    [
      [40, 150],
      [90, 60],
      [140, 140],
      [200, 70],
      [260, 150],
      [330, 90],
    ],
    [
      [360, 120],
      [520, 110],
    ],
  ],
  locale,
  consentVersion: CONSENT_VERSION,
  consent: true,
  confirm: true,
});

// ------------------------------------------------------------------------------------------------

describe('signing a contract for a minor (Phase 4 Definition of Done)', () => {
  test('approved → sent via unique links → recipient signs → guardian signs → fully executed, with audit trail', async () => {
    const org = await signingOrg();
    const c = await approvedContract(org, { minor: true });
    const approvedPdf = await org.manager.get(`/contracts/${c.id}/approved.pdf`);
    expect(approvedPdf.status).toBe(200);
    const approvedSha = sha(approvedPdf.bytes);

    // Start: the required signers come from the approved version — the recipient, then a
    // guardian, because the recipient is under 18 today.
    const started = await startSigning(org, c.id);
    const round = started.rounds[0]!;
    expect(round).toMatchObject({ status: 'in_progress', minor: true, minorOn: TODAY });
    expect(round.approvedDocumentSha256).toBe(approvedSha);
    expect(round.signers.map((s) => [s.role, s.order, s.status, s.turn])).toEqual([
      ['recipient', 1, 'pending', true],
      ['guardian', 2, 'pending', false],
    ]);
    expect(round.signers[1]).toMatchObject({
      nameEn: 'Huda Alharbi',
      relationship: 'Mother',
      email: 'huda@example.com',
    });
    expect((await org.manager.get<ContractDto>(`/contracts/${c.id}`)).body.status).toBe(
      'awaiting_signatures',
    );
    // Still listed under "approved" while out for signature; not "signed" yet.
    const approvedView = (await org.manager.get<ContractSummaryDto[]>('/contracts?view=approved'))
      .body;
    expect(approvedView.map((x) => [x.id, x.status])).toEqual([[c.id, 'awaiting_signatures']]);
    expect((await org.manager.get('/contracts?view=signed')).body).toEqual([]);

    // One unique link per signer: an emailed code for the recipient, an access code for the guardian.
    const [recipient, guardian] = round.signers;
    const rLink = await link(org, c.id, recipient!.id, { method: 'email_code' });
    expect(rLink).toMatchObject({
      method: 'email_code',
      accessCode: null,
      destination: 'saad@example.com',
    });
    expect(rLink.url).toMatch(/^http:\/\/localhost:3000\/sign\/[A-Za-z0-9_-]{43}$/);
    const gLink = await link(org, c.id, guardian!.id, { method: 'access_code', expiresInDays: 3 });
    expect(gLink.accessCode).toMatch(/^\d{6}$/);
    expect(gLink.url).not.toBe(rLink.url);
    // Only hashes are stored.
    const stored = await t.db.select().from(signingLinks);
    expect(stored.map((l) => l.tokenHash).sort()).toEqual(
      [sha(Buffer.from(tokenOf(rLink.url))), sha(Buffer.from(tokenOf(gLink.url)))].sort(),
    );
    const gStored = stored.find((l) => l.method === 'access_code')!;
    expect(gStored.accessCodeHash).toMatch(/^[0-9a-f]{64}$/);

    // --- The recipient opens the link (no account). Before the code: no contract content.
    const rc = pub();
    const rToken = tokenOf(rLink.url);
    const info = await rc.get<PublicSigningInfo>(`/public/signing/${rToken}`);
    expect(info.status).toBe(200);
    expect(info.headers.get('cache-control')).toBe('no-store');
    expect(info.body).toMatchObject({
      state: 'verify',
      contractNumber: c.number,
      signerRole: 'recipient',
      method: 'email_code',
      destination: 's•••@example.com',
    });
    expect(info.text).not.toContain('Saad');
    expect((await rc.get(`/public/signing/${rToken}/document.html`)).status).toBe(401);
    expect((await rc.get(`/public/signing/${rToken}/session`)).body.error.code).toBe(
      'verification_required',
    );

    // Code by email (dev outbox), then verify.
    const sent = await rc.post(`/public/signing/${rToken}/code`);
    expect(sent.status).toBe(200);
    expect(sent.body.destination).toBe('s•••@example.com');
    const code = await emailedCode('saad@example.com');
    const verified = await rc.post<PublicSigningVerified>(`/public/signing/${rToken}/verify`, {
      code,
    });
    expect(verified.status).toBe(200);
    const rSession = verified.body.sessionToken;
    expect(verified.body.session).toMatchObject({
      state: 'ready',
      contractNumber: c.number,
      documentSha256: approvedSha,
      signer: { role: 'recipient', nameEn: 'Saad Alharbi', nameAr: 'سعد الحربي' },
      signers: [
        { role: 'recipient', status: 'pending', signedAt: null },
        { role: 'guardian', status: 'pending', signedAt: null },
      ],
    });
    expect(verified.body.session.consent.en).toContain(`contract ${c.number}`);

    // The signer reviews the approved document: on screen, and the exact PDF.
    const html = await withSession(rc, 'GET', `/public/signing/${rToken}/document.html`, rSession);
    expect(html.status).toBe(200);
    expect(html.headers.get('content-security-policy')).toContain('sandbox');
    expect(html.text).toContain('Saad Alharbi');
    const doc = await withSession(rc, 'GET', `/public/signing/${rToken}/document.pdf`, rSession);
    expect(sha(doc.bytes)).toBe(approvedSha);

    // --- The guardian can open their link now, but must wait for the recipient.
    const gc = pub();
    const g = await openWithAccessCode(gc, gLink);
    expect(g.state.state).toBe('waiting');
    expect(g.state.signer).toMatchObject({ role: 'guardian', nameEn: 'Huda Alharbi' });
    expect(g.state.consent.en).toContain('parent or guardian of Saad Alharbi');
    const early = await withSession(
      gc,
      'POST',
      `/public/signing/${g.token}/sign`,
      g.session,
      typed('Huda Alharbi'),
    );
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('not_your_turn');

    // --- The recipient signs (typed, blue, chosen font).
    const signed1 = await withSession(
      rc,
      'POST',
      `/public/signing/${rToken}/sign`,
      rSession,
      typed('Saad Alharbi', 'great-vibes'),
    );
    expect(signed1.status).toBe(200);
    expect(signed1.body.state).toBe('signed');
    // Not twice.
    const again = await withSession(
      rc,
      'POST',
      `/public/signing/${rToken}/sign`,
      rSession,
      typed('Saad Alharbi'),
    );
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('already_signed');

    // The contract stays incomplete until every required signer — including the guardian — has signed.
    const mid = (await org.manager.get<ContractSigningDto>(`/contracts/${c.id}/signing`)).body;
    expect(mid.rounds[0]!.status).toBe('in_progress');
    expect(mid.rounds[0]!.signers.map((s) => [s.role, s.status, s.turn])).toEqual([
      ['recipient', 'signed', false],
      ['guardian', 'pending', true],
    ]);
    expect(mid.rounds[0]!.signers[0]!.link.state).toBe('used');
    expect((await org.manager.get<ContractDto>(`/contracts/${c.id}`)).body.status).toBe(
      'awaiting_signatures',
    );
    expect((await org.manager.get('/contracts?view=signed')).body).toEqual([]);
    expect((await org.manager.get(`/contracts/${c.id}/signed.pdf`)).status).toBe(404);
    const received = await t.db
      .select()
      .from(notifications)
      .where(eq(notifications.type, 'contract.signature_received'));
    expect(received.map((n) => n.recipientUserId)).toEqual([org.managerId]);
    expect(received[0]!.data).toMatchObject({ number: c.number, role: 'recipient' });

    // --- The guardian signs (drawn), as a second, separate step.
    expect(
      (await withSession(gc, 'GET', `/public/signing/${g.token}/session`, g.session)).body.state,
    ).toBe('ready');
    const signed2 = await withSession(
      gc,
      'POST',
      `/public/signing/${g.token}/sign`,
      g.session,
      drawn('ar'),
    );
    expect(signed2.status).toBe(200);
    expect(signed2.body.state).toBe('completed');

    // Fully executed: status signed, in the signed view, signed PDF stored with its hash.
    const final = (await org.manager.get<ContractSigningDto>(`/contracts/${c.id}/signing`)).body;
    const done = final.rounds[0]!;
    expect(done.status).toBe('completed');
    expect(done.signedDocument).toMatchObject({ verified: true });
    expect(final.can).toMatchObject({ start: false, manageLinks: false, download: true });
    const contract = (await org.manager.get<ContractDto>(`/contracts/${c.id}`)).body;
    expect(contract.status).toBe('signed');
    expect(contract.approvedDocument).toMatchObject({ sha256: approvedSha, verified: true });
    const signedView = (await org.manager.get<ContractSummaryDto[]>('/contracts?view=signed')).body;
    expect(signedView.map((x) => [x.id, x.status, !!x.signedAt])).toEqual([[c.id, 'signed', true]]);
    expect((await org.manager.get('/contracts?view=approved')).body).toEqual([]);

    const signedPdf = await org.manager.get(`/contracts/${c.id}/signed.pdf`);
    expect(signedPdf.status).toBe(200);
    expect(signedPdf.headers.get('x-document-sha256')).toBe(done.signedDocument!.sha256);
    expect(sha(signedPdf.bytes)).toBe(done.signedDocument!.sha256);
    // The approved PDF is preserved unchanged, and the signed PDF starts with its pages.
    const approvedAfter = await org.manager.get(`/contracts/${c.id}/approved.pdf`);
    expect(sha(approvedAfter.bytes)).toBe(approvedSha);
    const approvedPages = (await PDFDocument.load(approvedPdf.bytes)).getPageCount();
    const signedDoc = await PDFDocument.load(signedPdf.bytes);
    expect(signedDoc.getPageCount()).toBeGreaterThan(approvedPages);
    const text = pdfText(signedPdf.bytes, 'signed');
    expect(text).toContain('Signature record');
    expect(text.replace(/\s/g, '')).toContain(approvedSha);
    expect(text).toContain('Huda Alharbi');
    expect(text).toContain('Mother');
    expect(text).toContain('s•••@example.com');
    expect(text).toContain(`I confirm that I am Saad Alharbi`);
    // The typed signature is drawn in the chosen font.
    expect(pdfFonts(signedPdf.bytes, 'signed')).toMatch(/GreatVibes/);

    // Each signer can download the executed copy through their verified session.
    const gCopy = await withSession(gc, 'GET', `/public/signing/${g.token}/signed.pdf`, g.session);
    expect(gCopy.status).toBe(200);
    expect(sha(gCopy.bytes)).toBe(done.signedDocument!.sha256);

    // Consent records: verbatim statement, version, language, approved hash, IP, browser, record hash.
    const rows = await t.db.select().from(contractSigners).orderBy(asc(contractSigners.signOrder));
    expect(rows.map((r) => [r.role, r.signatureMethod, r.consentLocale, r.consentVersion])).toEqual(
      [
        ['recipient', 'typed', 'en', CONSENT_VERSION],
        ['guardian', 'drawn', 'ar', CONSENT_VERSION],
      ],
    );
    expect(rows[0]).toMatchObject({
      typedName: 'Saad Alharbi',
      fontKey: 'great-vibes',
      verificationMethod: 'email_code',
      verificationDestination: 's•••@example.com',
      documentSha256: approvedSha,
    });
    expect(rows[0]!.ip).toContain('127.0.0.1');
    expect(rows[1]!.consentText).toBe(signed2.body.consent.ar);
    expect(rows[1]!.strokes).toEqual(drawn().strokes as never);
    // The record hash covers exactly the stored fields.
    const r0 = rows[0]!;
    const recomputed = sha(
      Buffer.from(
        canonicalJson({
          contractId: c.id,
          contractNumber: c.number,
          roundId: r0.roundId,
          signerId: r0.id,
          role: r0.role,
          name: { en: r0.nameEn, ar: r0.nameAr },
          signature: {
            method: 'typed',
            typedName: r0.typedName,
            fontKey: r0.fontKey,
            strokes: null,
          },
          consent: { version: r0.consentVersion, locale: r0.consentLocale, text: r0.consentText },
          documentSha256: r0.documentSha256,
          verification: {
            method: r0.verificationMethod,
            destination: r0.verificationDestination,
            verifiedAt: r0.verifiedAt!.toISOString(),
          },
          signedAt: r0.signedAt!.toISOString(),
          ip: r0.ip,
          userAgent: r0.userAgent,
        }),
      ),
    );
    expect(r0.recordSha256).toBe(recomputed);

    // Notifications on completion: the requesting manager and the Owner.
    const full = await t.db
      .select()
      .from(notifications)
      .where(eq(notifications.type, 'contract.fully_signed'));
    expect(full.map((n) => n.recipientUserId).sort()).toEqual([org.managerId, org.ownerId].sort());

    // Audit trail, in order.
    const trail = await t.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.targetId, c.id),
          sql`(${auditLogs.action} like 'contract.sign%' or ${auditLogs.action} = 'contract.fully_signed')`,
        ),
      )
      .orderBy(asc(auditLogs.createdAt), asc(auditLogs.id));
    const actions = trail.map((a) => [a.action, a.actorType]);
    expect(actions).toEqual([
      ['contract.signing_started', 'user'],
      ['contract.signing_link_created', 'user'],
      ['contract.signing_link_created', 'user'],
      ['contract.signing_code_sent', 'anonymous'],
      ['contract.signer_verified', 'anonymous'],
      ['contract.signer_verified', 'anonymous'],
      ['contract.signed', 'anonymous'],
      ['contract.signed', 'anonymous'],
      ['contract.fully_signed', 'system'],
    ]);
    const signedEntries = trail.filter((a) => a.action === 'contract.signed');
    expect(signedEntries.map((a) => (a.metadata as { role: string }).role)).toEqual([
      'recipient',
      'guardian',
    ]);
    expect(signedEntries[0]!.ip).toContain('127.0.0.1');

    // The record can't be changed afterwards, not even directly in the database.
    await expect(
      Promise.resolve(
        t.db
          .update(contractSigners)
          .set({ typedName: 'Someone else' })
          .where(eq(contractSigners.id, r0.id)),
      ),
    ).rejects.toThrow();
    await expect(
      Promise.resolve(
        t.db.update(signingRounds).set({ cancelReason: 'x' }).where(eq(signingRounds.id, done.id)),
      ),
    ).rejects.toThrow();
    await expect(Promise.resolve(t.db.delete(signingLinks))).rejects.toThrow();
  });
});

describe('who signs', () => {
  test('an adult recipient signs alone; one signature completes the contract', async () => {
    const org = await signingOrg();
    const c = await approvedContract(org);
    const s = await startSigning(org, c.id);
    expect(s.rounds[0]!.minor).toBe(false);
    expect(s.rounds[0]!.signers.map((x) => x.role)).toEqual(['recipient']);
    const l = await link(org, c.id, s.rounds[0]!.signers[0]!.id);
    const pc = pub();
    const o = await openWithAccessCode(pc, l);
    const res = await withSession(
      pc,
      'POST',
      `/public/signing/${o.token}/sign`,
      o.session,
      typed('سعد الحربي', 'aref-ruqaa', 'ar'),
    );
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('completed');
    expect((await org.manager.get<ContractDto>(`/contracts/${c.id}`)).body.status).toBe('signed');
    const text = pdfText((await org.manager.get(`/contracts/${c.id}/signed.pdf`)).bytes, 'adult');
    expect(text).toContain('Access code handed over by the organization');
    expect(
      pdfFonts((await org.manager.get(`/contracts/${c.id}/signed.pdf`)).bytes, 'adult'),
    ).toMatch(/ArefRuqaa/);
  });

  test('a typed signature must use a font that can write it', async () => {
    const org = await signingOrg();
    const c = await approvedContract(org);
    const s = await startSigning(org, c.id);
    const pc = pub();
    const o = await openWithAccessCode(pc, await link(org, c.id, s.rounds[0]!.signers[0]!.id));
    const bad = await withSession(
      pc,
      'POST',
      `/public/signing/${o.token}/sign`,
      o.session,
      typed('سعد الحربي', 'great-vibes'),
    );
    expect(bad.status).toBe(400);
    const noConsent = await withSession(pc, 'POST', `/public/signing/${o.token}/sign`, o.session, {
      ...typed('Saad Alharbi'),
      consent: false,
    });
    expect(noConsent.status).toBe(400);
    const tooShort = await withSession(pc, 'POST', `/public/signing/${o.token}/sign`, o.session, {
      ...drawn(),
      strokes: [[[10, 10]]],
    });
    expect(tooShort.status).toBe(400);
    expect((await org.manager.get<ContractDto>(`/contracts/${c.id}`)).body.status).toBe(
      'awaiting_signatures',
    );
  });

  test('only approved contracts can be sent, and only once at a time', async () => {
    const org = await signingOrg();
    const types = (await org.manager.get<ContractTypeDto[]>('/contract-types')).body;
    const d = (
      await org.manager.post<ContractDto>('/contracts', {
        contractTypeId: types[0]!.id,
        teamId: org.teamA.id,
      })
    ).body;
    const res = await org.manager.post(`/contracts/${d.id}/signing`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('contract_invalid_transition');
    const c = await approvedContract(org);
    await startSigning(org, c.id);
    const twice = await org.manager.post(`/contracts/${c.id}/signing`);
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('signing_in_progress');
  });
});

describe('signing links', () => {
  test('expired, revoked, replaced and unknown links are refused', async () => {
    const org = await signingOrg();
    const c = await approvedContract(org);
    const s = await startSigning(org, c.id);
    const signer = s.rounds[0]!.signers[0]!;
    const first = await link(org, c.id, signer.id);
    // A new link replaces the old one.
    const second = await link(org, c.id, signer.id);
    const old = await pub().get(`/public/signing/${tokenOf(first.url)}`);
    expect([old.status, old.body.error.code]).toEqual([410, 'link_revoked']);
    expect((await pub().get(`/public/signing/${tokenOf(second.url)}`)).status).toBe(200);

    // Expiry.
    await t.db
      .update(signingLinks)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(signingLinks.tokenHash, sha(Buffer.from(tokenOf(second.url)))));
    const exp = await pub().post(`/public/signing/${tokenOf(second.url)}/verify`, {
      code: second.accessCode,
    });
    expect([exp.status, exp.body.error.code]).toEqual([410, 'link_expired']);
    const st = (await org.manager.get<ContractSigningDto>(`/contracts/${c.id}/signing`)).body;
    expect(st.rounds[0]!.signers[0]!.link.state).toBe('expired');

    // Revocation by the manager.
    const third = await link(org, c.id, signer.id);
    const rv = await org.manager.post<ContractSigningDto>(
      `/contracts/${c.id}/signing/signers/${signer.id}/link/revoke`,
    );
    expect(rv.status).toBe(200);
    expect(rv.body.rounds[0]!.signers[0]!.link.state).toBe('revoked');
    expect((await pub().get(`/public/signing/${tokenOf(third.url)}`)).body.error.code).toBe(
      'link_revoked',
    );
    // A session opened before revocation stops working too.
    const fourth = await link(org, c.id, signer.id);
    const pc = pub();
    const o = await openWithAccessCode(pc, fourth);
    await org.manager.post(`/contracts/${c.id}/signing/signers/${signer.id}/link/revoke`);
    const after = await withSession(
      pc,
      'POST',
      `/public/signing/${o.token}/sign`,
      o.session,
      typed('Saad Alharbi'),
    );
    expect(after.body.error.code).toBe('link_revoked');

    // Unknown or malformed tokens.
    expect((await pub().get(`/public/signing/${'A'.repeat(43)}`)).body.error.code).toBe(
      'link_invalid',
    );
    expect((await pub().get('/public/signing/not-a-token')).status).toBe(404);

    const audit = await t.db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.action, 'contract.signing_link_revoked'));
    expect(audit.length).toBe(2);
  });

  test('five wrong codes lock the link; a session is bound to its own link', async () => {
    const org = await signingOrg();
    const c = await approvedContract(org, { minor: true });
    const s = await startSigning(org, c.id);
    const [recipient, guardian] = s.rounds[0]!.signers;
    const l = await link(org, c.id, recipient!.id);
    const token = tokenOf(l.url);
    const wrong = l.accessCode === '000000' ? '111111' : '000000';
    const left: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await pub().post(`/public/signing/${token}/verify`, { code: wrong });
      expect(r.body.error.code).toBe('verification_failed');
      left.push(r.body.error.details.attemptsLeft);
    }
    expect(left).toEqual([4, 3, 2, 1]);
    const fifth = await pub().post(`/public/signing/${token}/verify`, { code: wrong });
    expect([fifth.status, fifth.body.error.code]).toEqual([410, 'link_locked']);
    // Even the right code no longer works.
    const right = await pub().post(`/public/signing/${token}/verify`, { code: l.accessCode });
    expect(right.body.error.code).toBe('link_locked');
    expect(
      (await org.manager.get<ContractSigningDto>(`/contracts/${c.id}/signing`)).body.rounds[0]!
        .signers[0]!.link.state,
    ).toBe('locked');
    const failures = await t.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'contract.signer_verification_failed'));
    expect(failures.length).toBe(5);
    expect((failures.at(-1)!.metadata as { locked: boolean }).locked).toBe(true);
    expect(
      await t.db.select().from(contractSigners).where(eq(contractSigners.status, 'signed')),
    ).toEqual([]);

    // A new link for the recipient works; the guardian's session can't be used on it.
    const fresh = await link(org, c.id, recipient!.id);
    const gc = pub();
    const g = await openWithAccessCode(gc, await link(org, c.id, guardian!.id));
    const cross = await withSession(
      gc,
      'GET',
      `/public/signing/${tokenOf(fresh.url)}/document.html`,
      g.session,
    );
    expect(cross.body.error.code).toBe('verification_required');
    const bad = await withSession(gc, 'GET', `/public/signing/${g.token}/session`, 'x'.repeat(43));
    expect(bad.status).toBe(401);
  });

  test('emailed codes: needed before verifying, throttled, single use, expire', async () => {
    const org = await signingOrg();
    const c = await approvedContract(org);
    const s = await startSigning(org, c.id);
    const signer = s.rounds[0]!.signers[0]!;
    // No address → no email-code link (the access-code method still works).
    const noEmail = await org.manager.post(`/contracts/${c.id}/signing/signers/${signer.id}/link`, {
      method: 'email_code',
      email: null,
    });
    expect(noEmail.status).toBe(200); // falls back to the contract's address
    const l = noEmail.body as SigningLinkCreatedDto;
    expect(l.destination).toBe('saad@example.com');
    const token = tokenOf(l.url);
    const pc = pub();
    const early = await pc.post(`/public/signing/${token}/verify`, { code: '123456' });
    expect(early.body.error.code).toBe('verification_required');
    expect((await pc.post(`/public/signing/${token}/code`)).status).toBe(200);
    const throttled = await pc.post(`/public/signing/${token}/code`);
    expect(throttled.status).toBe(429);
    expect(throttled.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
    const code = await emailedCode('saad@example.com');
    const mail = (
      await t.db.select().from(devOutbox).where(eq(devOutbox.template, 'signing_code'))
    )[0]!;
    expect(mail.text).not.toContain('/sign/'); // the code email carries no link
    expect((await pc.post(`/public/signing/${token}/verify`, { code })).status).toBe(200);
    // Used once.
    const reuse = await pc.post(`/public/signing/${token}/verify`, { code });
    expect(reuse.body.error.code).toBe('verification_required');
    // Expired code.
    await t.db
      .update(signingLinks)
      .set({ lastCodeSentAt: new Date(Date.now() - 120_000) })
      .where(eq(signingLinks.tokenHash, sha(Buffer.from(token))));
    expect((await pc.post(`/public/signing/${token}/code`)).status).toBe(200);
    await t.db
      .update(signingLinks)
      .set({ emailCodeExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(signingLinks.tokenHash, sha(Buffer.from(token))));
    const stale = await pc.post(`/public/signing/${token}/verify`, {
      code: await emailedCode('saad@example.com'),
    });
    expect(stale.body.error.code).toBe('verification_required');

    // A signer with no address in the contract and none given can't get an email-code link.
    await t.db
      .update(contractSigners)
      .set({ email: null })
      .where(eq(contractSigners.id, signer.id));
    const none = await org.manager.post(`/contracts/${c.id}/signing/signers/${signer.id}/link`, {
      method: 'email_code',
    });
    expect([none.status, none.body.error.code]).toEqual([400, 'email_unavailable']);
  });

  test('public signing routes are rate limited per client', async () => {
    const pc = pub();
    let last = 0;
    for (let i = 0; i < 21; i++) {
      last = (await pc.post(`/public/signing/${'B'.repeat(43)}/verify`, { code: '123456' })).status;
    }
    expect(last).toBe(429);
  });
});

describe('cancelling and permissions', () => {
  test('cancelling signing revokes the links and returns the contract to approved; signatures given stay recorded', async () => {
    const org = await signingOrg();
    const c = await approvedContract(org, { minor: true });
    const s = await startSigning(org, c.id);
    const [recipient, guardian] = s.rounds[0]!.signers;
    const rc = pub();
    const r = await openWithAccessCode(rc, await link(org, c.id, recipient!.id));
    expect(
      (
        await withSession(
          rc,
          'POST',
          `/public/signing/${r.token}/sign`,
          r.session,
          typed('Saad Alharbi'),
        )
      ).status,
    ).toBe(200);
    const gLink = await link(org, c.id, guardian!.id);

    expect((await org.manager.post(`/contracts/${c.id}/signing/cancel`, {})).status).toBe(400);
    const cancelled = await org.manager.post<ContractSigningDto>(
      `/contracts/${c.id}/signing/cancel`,
      {
        reason: 'Guardian details to be corrected',
      },
    );
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.rounds[0]).toMatchObject({
      status: 'cancelled',
      cancelReason: 'Guardian details to be corrected',
    });
    expect(cancelled.body.can.start).toBe(true);
    expect((await org.manager.get<ContractDto>(`/contracts/${c.id}`)).body.status).toBe('approved');
    expect((await pub().get(`/public/signing/${tokenOf(gLink.url)}`)).body.error.code).toBe(
      'link_revoked',
    );
    // The recipient's signature in the cancelled round is still on record.
    const kept = await t.db
      .select()
      .from(contractSigners)
      .where(eq(contractSigners.status, 'signed'));
    expect(kept.length).toBe(1);

    // A fresh round starts from scratch.
    const again = await startSigning(org, c.id);
    expect(again.rounds.map((x) => x.status)).toEqual(['in_progress', 'cancelled']);
    expect(again.rounds[0]!.signers.every((x) => x.status === 'pending')).toBe(true);
  });

  test('scope and permissions are enforced on every signing action', async () => {
    const org = await signingOrg();
    const c = await approvedContract(org);
    // A manager of another team doesn't see the contract at all.
    const other = await withRole(t, org.owner, 'teamb@example.com', 'esports_manager', {
      type: 'team',
      id: org.teamB.id,
    });
    expect((await other.client.get(`/contracts/${c.id}/signing`)).status).toBe(404);
    expect((await other.client.post(`/contracts/${c.id}/signing`)).status).toBe(404);
    // The approver can see the signing status but not send for signature.
    expect((await org.approver.get(`/contracts/${c.id}/signing`)).status).toBe(200);
    expect((await org.approver.post(`/contracts/${c.id}/signing`)).status).toBe(403);
    // Unauthenticated: no access to the dashboard routes.
    expect((await pub().get(`/contracts/${c.id}/signing`)).status).toBe(401);

    const s = await startSigning(org, c.id);
    const signer = s.rounds[0]!.signers[0]!;
    expect(
      (
        await org.approver.post(`/contracts/${c.id}/signing/signers/${signer.id}/link`, {
          method: 'access_code',
        })
      ).status,
    ).toBe(403);
    expect(
      (await org.approver.post(`/contracts/${c.id}/signing/cancel`, { reason: 'nope' })).status,
    ).toBe(403);
    // Signer ids from another contract are not accepted.
    const c2 = await approvedContract(org);
    expect(
      (
        await org.manager.post(`/contracts/${c2.id}/signing/signers/${signer.id}/link`, {
          method: 'access_code',
        })
      ).status,
    ).toBe(409); // c2 isn't out for signature
    await startSigning(org, c2.id);
    expect(
      (
        await org.manager.post(`/contracts/${c2.id}/signing/signers/${signer.id}/link`, {
          method: 'access_code',
        })
      ).status,
    ).toBe(404);
    // Owners can do everything.
    expect(
      (
        await org.owner.post(`/contracts/${c.id}/signing/signers/${signer.id}/link`, {
          method: 'access_code',
        })
      ).status,
    ).toBe(200);
  });

  test('existing template roles received the new permission (migration 0007)', async () => {
    const org = await signingOrg();
    const [{ count }] = (await t.db.execute(
      sql`select count(*)::int as count from app.role_permissions rp join app.roles r on r.id = rp.role_id where r.template_key in ('head_of_esports','esports_manager') and rp.permission_key = 'contracts.send_for_signature'`,
    )) as unknown as [{ count: number }];
    // Seeded from the templates on organization creation (2 template roles).
    expect(count).toBe(2);
    void org;
  });
});

describe('storage', () => {
  test('the signed PDF is a separate stored file; the approval record is untouched', async () => {
    const org = await signingOrg();
    const c = await approvedContract(org);
    const s = await startSigning(org, c.id);
    const pc = pub();
    const o = await openWithAccessCode(pc, await link(org, c.id, s.rounds[0]!.signers[0]!.id));
    await withSession(
      pc,
      'POST',
      `/public/signing/${o.token}/sign`,
      o.session,
      typed('Saad Alharbi'),
    );
    const files = await t.db
      .select({ kind: storedFiles.kind, sha256: storedFiles.sha256 })
      .from(storedFiles)
      .orderBy(asc(storedFiles.createdAt));
    expect(files.map((f) => f.kind)).toEqual(['contract_approved', 'contract_signed']);
    const [req] = await t.db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.contractId, c.id));
    expect(req!.documentSha256).toBe(files[0]!.sha256);
    const [round] = await t.db.select().from(signingRounds);
    expect(round!.signedDocumentSha256).toBe(files[1]!.sha256);
    expect(round!.approvedDocumentSha256).toBe(files[0]!.sha256);
  });
});
