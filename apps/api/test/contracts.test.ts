/**
 * Phase 3 — Contract Builder & Approval, end to end over HTTP against the real app.
 * The Definition of Done flow is the "approval workflow" suite. The AI provider is a fake: tests
 * never call the Anthropic API.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_ROLE_TEMPLATES,
  RIYAL_SIGN,
  PERMISSIONS,
  type PermissionKey,
  type ClauseProposalDto,
  type ContractDto,
  type ContractSummaryDto,
  type ContractTypeDto,
  type DocumentSettingsDto,
  type StoredFileDto,
  type TemplateClauseDto,
} from '@esports/shared';
import { and, asc, eq } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import type { AiJsonRequest, AiJsonResult, AiProvider } from '../src/ai/ai.provider';
import { auditLogs, notifications } from '../src/db/schema';
import { approvalRequests, contractTypes, entityVersions } from '../src/db/schema-contracts';
import { expense, financeOrg, withRole } from './finance-fixtures';
import { type Client, inviteAndAccept, registerOwner, startApp, type TestApp } from './harness';

class FakeAi implements AiProvider {
  readonly name = 'fake';
  readonly model = 'fake-model';
  readonly configured = true;
  calls: AiJsonRequest[] = [];
  next: unknown = null;
  async generateJson(req: AiJsonRequest): Promise<AiJsonResult> {
    this.calls.push(req);
    return { data: this.next ?? DRAFT, model: 'fake-model' };
  }
}
const DRAFT = {
  titleEn: 'Streaming commitments',
  titleAr: 'التزامات البث',
  bodyEn:
    '{{recipientName}} will stream on the organization channel for at least [number] hours per week.',
  bodyAr: 'يلتزم {{recipientName}} بالبث على قناة المنظمة مدة لا تقل عن [عدد] ساعات أسبوعيًا.',
  questions: ['How many hours per week?'],
  notes: 'Assumes the organization owns the channel.',
};

// 1×1 PNG and a JPEG header, for upload checks.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const ISOLATES = /[⁦-⁩]/g;
const dir = mkdtempSync(join(tmpdir(), 'esports-contracts-'));
/** Text of a PDF: layout mode for tables; raw (content-stream order) keeps rotated text whole. */
const pdfText = (bytes: Buffer, name: string, mode: 'layout' | 'raw' = 'layout') => {
  const p = join(dir, `${name}.pdf`);
  writeFileSync(p, bytes);
  return execFileSync('pdftotext', [`-${mode}`, p, '-'])
    .toString('utf8')
    .replace(ISOLATES, '');
};
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const ai = new FakeAi();
let t: TestApp;
beforeAll(async () => {
  t = await startApp({ ai });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  ai.calls = [];
  ai.next = null;
});

/** Owner, team A/B, a roster player on team A, a team-A manager and a delegated approver. */
async function contractOrg() {
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
  const manager = await withRole(t, owner, 'manager@example.com', 'esports_manager', {
    type: 'team',
    id: teamA.id,
  });
  const role = await owner.post('/roles', {
    nameEn: 'Contract approver',
    permissions: ['contracts.view', 'contracts.approve'],
  });
  expect(role.status).toBe(201);
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

async function typeId(c: Client, key = 'player') {
  return (await c.get<ContractTypeDto[]>('/contract-types')).body.find((x) => x.key === key)!.id;
}

/** A complete set of details for a draft (all merge fields resolvable). */
function completeDetails(c: ContractDto, over: Record<string, unknown> = {}) {
  return {
    ...c.snapshot.details,
    recipient: {
      ...c.snapshot.details.recipient,
      fullNameEn: 'Saad Alharbi',
      fullNameAr: 'سعد الحربي',
      idNumber: '1098765432',
    },
    role: 'Duelist',
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    compensation: { amount: '12000', currency: 'SAR', frequency: 'monthly' },
    ...over,
  };
}

function savePayload(
  c: ContractDto,
  details: unknown,
  clauses = c.snapshot.clauses,
  note?: string,
) {
  return {
    teamId: c.snapshot.teamId,
    rosterMemberId: c.snapshot.rosterMemberId,
    details,
    clauses,
    note,
  };
}

async function draft(org: Awaited<ReturnType<typeof contractOrg>>, by: Client = org.manager) {
  const created = await by.post<ContractDto>('/contracts', {
    contractTypeId: await typeId(by),
    teamId: org.teamA.id,
    rosterMemberId: org.player.id,
  });
  expect(created.status).toBe(201);
  const saved = await by.put<ContractDto>(
    `/contracts/${created.body.id}`,
    savePayload(created.body, completeDetails(created.body)),
  );
  expect(saved.status).toBe(200);
  return saved.body;
}

// ------------------------------------------------------------------------------------------------

describe('contract types and clause templates', () => {
  test('each organization gets Player, Coach, Manager and Staff types, each with its own template', async () => {
    const { client: owner } = await registerOwner(t);
    const types = (await owner.get<ContractTypeDto[]>('/contract-types')).body;
    expect(types.map((x) => x.key)).toEqual(['player', 'coach', 'manager', 'staff']);
    expect(types.map((x) => [x.isSystem, x.clauseCount > 5])).toEqual(
      types.map(() => [true, true]),
    );
    const player = (await owner.get<TemplateClauseDto[]>(`/contract-types/${types[0]!.id}/clauses`))
      .body;
    const coach = (await owner.get<TemplateClauseDto[]>(`/contract-types/${types[1]!.id}/clauses`))
      .body;
    // Standard clauses differ by type (spec §7.5): only the player template has guardian consent.
    expect(player.some((c) => /under 18/i.test(c.titleEn))).toBe(true);
    expect(coach.some((c) => /under 18/i.test(c.titleEn))).toBe(false);
    expect(player.filter((c) => c.required).length).toBeGreaterThan(0);
    expect(player.filter((c) => !c.required).length).toBeGreaterThan(0);
    expect(player.map((c) => c.position)).toEqual(player.map((_, i) => i));
  });

  test('organizations created before Phase 3 get the defaults on first use', async () => {
    const { client: owner, me } = await registerOwner(t);
    await t.db
      .delete(contractTypes)
      .where(eq(contractTypes.organizationId, me.activeOrganization!.id));
    const types = (await owner.get<ContractTypeDto[]>('/contract-types')).body;
    expect(types.map((x) => x.key)).toEqual(['player', 'coach', 'manager', 'staff']);
  });

  test('template editing is Owner-only; drafting is open to managers', async () => {
    const org = await contractOrg();
    const pid = await typeId(org.owner);
    const template = (await org.owner.get<TemplateClauseDto[]>(`/contract-types/${pid}/clauses`))
      .body;
    // The manager can read templates and draft from them…
    expect((await org.manager.get(`/contract-types/${pid}/clauses`)).status).toBe(200);
    // …but not change them, nor create types.
    expect(
      (await org.manager.put(`/contract-types/${pid}/clauses`, { clauses: template })).status,
    ).toBe(403);
    expect(
      (await org.manager.post('/contract-types', { nameEn: 'Loan', nameAr: 'إعارة' })).status,
    ).toBe(403);
    // A Head of Esports can't either (manage_templates is never grantable).
    const head = await withRole(t, org.owner, 'head@example.com', 'head_of_esports', {
      type: 'organization',
    });
    expect(
      (await head.client.put(`/contract-types/${pid}/clauses`, { clauses: template })).status,
    ).toBe(403);

    // The Owner reorders, flips a flag and adds a clause; ids of existing clauses are kept.
    const next = [
      { ...template[1]!, required: true },
      template[0]!,
      ...template.slice(2),
      {
        required: false,
        titleEn: 'Travel',
        titleAr: 'السفر',
        bodyEn: 'Travel is booked by the organization.',
        bodyAr: 'تحجز المنظمة السفر.',
      },
    ];
    const put = await org.owner.put<TemplateClauseDto[]>(`/contract-types/${pid}/clauses`, {
      clauses: next,
    });
    expect(put.status).toBe(200);
    expect(put.body[0]!.id).toBe(template[1]!.id);
    expect(put.body[0]!.required).toBe(true);
    expect(put.body.at(-1)!.titleEn).toBe('Travel');
    const [log] = await t.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'contract_type.template_updated'));
    expect(log).toBeDefined();
  });

  test('custom types: created by the Owner, archived when in use, deleted when not; defaults stay', async () => {
    const org = await contractOrg();
    const loan = await org.owner.post<ContractTypeDto>('/contract-types', {
      nameEn: 'Loan agreement',
      nameAr: 'اتفاقية إعارة',
    });
    expect(loan.status).toBe(201);
    expect(loan.body).toMatchObject({ isSystem: false, key: null, clauseCount: 0 });
    await org.owner.put(`/contract-types/${loan.body.id}/clauses`, {
      clauses: [
        {
          required: true,
          titleEn: 'Loan period',
          titleAr: 'مدة الإعارة',
          bodyEn: 'From {{startDate}} to {{endDate}}.',
          bodyAr: 'من {{startDate}} إلى {{endDate}}.',
        },
      ],
    });
    const unused = await org.owner.post<ContractTypeDto>('/contract-types', {
      nameEn: 'Unused',
      nameAr: 'غير مستخدم',
    });
    expect((await org.owner.del(`/contract-types/${unused.body.id}`)).body).toEqual({
      archived: false,
    });

    const c = await org.manager.post<ContractDto>('/contracts', {
      contractTypeId: loan.body.id,
      teamId: org.teamA.id,
    });
    expect(c.status).toBe(201);
    expect(c.body.snapshot.clauses).toHaveLength(1);
    expect((await org.owner.del(`/contract-types/${loan.body.id}`)).body).toEqual({
      archived: true,
    });
    // Archived types can't start new contracts.
    expect(
      (await org.manager.post('/contracts', { contractTypeId: loan.body.id, teamId: org.teamA.id }))
        .status,
    ).toBe(400);
    expect((await org.owner.del(`/contract-types/${await typeId(org.owner)}`)).status).toBe(400);
  });
});

describe('drafting', () => {
  test('a draft copies the template and pre-fills from the roster member and organization defaults', async () => {
    const org = await contractOrg();
    const pid = await typeId(org.manager);
    const template = (await org.manager.get<TemplateClauseDto[]>(`/contract-types/${pid}/clauses`))
      .body;
    const res = await org.manager.post<ContractDto>('/contracts', {
      contractTypeId: pid,
      teamId: org.teamA.id,
      rosterMemberId: org.player.id,
    });
    expect(res.status).toBe(201);
    const c = res.body;
    expect(c.number).toMatch(/^CT-\d{4}-0001$/);
    expect(c).toMatchObject({ status: 'draft', currentVersion: 1, teamName: 'Valorant Team A' });
    expect(c.snapshot.details.recipient).toMatchObject({
      kind: 'player',
      fullNameEn: 'Saad Alharbi',
      nationality: 'Saudi',
      dateOfBirth: '2001-04-02',
    });
    expect(c.snapshot.details.compensation.currency).toBe('USD'); // the org's reporting currency (financeOrg uses USD)
    expect(c.snapshot.details.language).toBe('bilingual');
    expect(c.snapshot.gameName).toBe('VALORANT');
    expect(
      c.snapshot.clauses.map((x) => [x.templateClauseId, x.required, x.source, x.included]),
    ).toEqual(template.map((x) => [x.id, x.required, 'template', true]));
    expect(c.missing).toEqual(expect.arrayContaining(['startDate', 'salary']));
    const second = await org.manager.post<ContractDto>('/contracts', {
      contractTypeId: pid,
      teamId: org.teamA.id,
    });
    expect(second.body.number).toMatch(/-0002$/);
  });

  test('new organizations draft in SAR', async () => {
    const { client: owner } = await registerOwner(t);
    const c = await owner.post<ContractDto>('/contracts', {
      contractTypeId: await typeId(owner, 'staff'),
    });
    expect(c.status).toBe(201);
    expect(c.body.snapshot.details.compensation.currency).toBe('SAR');
    expect(c.body.snapshot.details.buyout.currency).toBe('SAR');
  });

  test('required clauses cannot be removed or excluded, and clause origins cannot be forged', async () => {
    const org = await contractOrg();
    const c = await draft(org);
    const details = c.snapshot.details;
    const req = c.snapshot.clauses.find((x) => x.required)!;
    const opt = c.snapshot.clauses.find((x) => !x.required)!;

    const excluded = c.snapshot.clauses.map((x) =>
      x.id === req.id ? { ...x, included: false } : x,
    );
    expect(
      (await org.manager.put(`/contracts/${c.id}`, savePayload(c, details, excluded))).status,
    ).toBe(400);
    // Claiming "not required" in the request doesn't help: the stored flag wins.
    const forged = c.snapshot.clauses.map((x) =>
      x.id === req.id ? { ...x, required: false, included: false } : x,
    );
    const r1 = await org.manager.put(`/contracts/${c.id}`, savePayload(c, details, forged));
    expect(r1.status).toBe(400);
    expect(r1.body.error.code).toBe('required_clause');
    const removed = c.snapshot.clauses.filter((x) => x.id !== req.id);
    expect(
      (await org.manager.put(`/contracts/${c.id}`, savePayload(c, details, removed))).body.error
        .code,
    ).toBe('required_clause');

    // Optional clauses can be excluded or removed; a new clause is always custom and optional.
    const custom = {
      id: crypto.randomUUID(),
      templateClauseId: req.templateClauseId,
      source: 'template' as const,
      required: true,
      included: true,
      titleEn: 'Extra',
      titleAr: 'إضافي',
      bodyEn: 'Extra terms.',
      bodyAr: 'شروط إضافية.',
    };
    const list = [
      ...c.snapshot.clauses.map((x) => (x.id === opt.id ? { ...x, included: false } : x)),
      custom,
    ];
    const ok = await org.manager.put<ContractDto>(
      `/contracts/${c.id}`,
      savePayload(c, details, list),
    );
    expect(ok.status).toBe(200);
    const stored = ok.body.snapshot.clauses.find((x) => x.id === custom.id)!;
    expect(stored).toMatchObject({ source: 'custom', required: false, templateClauseId: null });
    expect(ok.body.snapshot.clauses.find((x) => x.id === opt.id)!.included).toBe(false);
  });

  test('every save is a new immutable version; saving nothing new creates none', async () => {
    const org = await contractOrg();
    const c = await draft(org); // v2
    expect(c.versions.map((v) => v.version)).toEqual([1, 2]);
    const same = await org.manager.put<ContractDto & { unchanged?: boolean }>(
      `/contracts/${c.id}`,
      savePayload(c, c.snapshot.details),
    );
    expect(same.body.unchanged).toBe(true);
    expect(same.body.currentVersion).toBe(2);

    // Wording edits to template clauses are flagged for the approver.
    const edited = c.snapshot.clauses.map((x, i) =>
      i === 0 ? { ...x, bodyEn: `${x.bodyEn} Amended.` } : x,
    );
    const v3 = await org.manager.put<ContractDto>(
      `/contracts/${c.id}`,
      savePayload(c, c.snapshot.details, edited, 'Tightened parties clause'),
    );
    expect(v3.body.currentVersion).toBe(3);
    expect(v3.body.modifiedClauseIds).toEqual([c.snapshot.clauses[0]!.id]);
    expect(v3.body.versions.at(-1)).toMatchObject({
      version: 3,
      note: 'Tightened parties clause',
      verified: true,
    });

    // The database refuses to change or delete history.
    await expect(
      Promise.resolve(
        t.db
          .update(entityVersions)
          .set({ note: 'tampered' })
          .where(eq(entityVersions.entityId, c.id)),
      ),
    ).rejects.toThrow();
    await expect(
      Promise.resolve(t.db.delete(entityVersions).where(eq(entityVersions.entityId, c.id))),
    ).rejects.toThrow();
    const v1 = await org.manager.get(`/contracts/${c.id}/versions/1`);
    expect(v1.body.snapshot.details.startDate ?? null).toBeNull();
    expect(v1.body.verified).toBe(true);
  });

  test('missing details and merge fields block submission', async () => {
    const org = await contractOrg();
    const created = (
      await org.manager.post<ContractDto>('/contracts', {
        contractTypeId: await typeId(org.manager),
        teamId: org.teamA.id,
      })
    ).body;
    const res = await org.manager.post(`/contracts/${created.id}/submit`, {});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('contract_incomplete');
    expect(res.body.error.details.missing).toEqual(
      expect.arrayContaining(['recipientName', 'startDate', 'salary', 'role']),
    );
    const html = await org.manager.get(`/contracts/${created.id}/preview`);
    expect(html.text).toContain('class="missing"');
  });
});

describe('approval workflow (Phase 3 Definition of Done)', () => {
  test('draft → submit → reject with reason → revise → resubmit → delegated approval → stamped document, with audit trail', async () => {
    const org = await contractOrg();
    // The Owner configures the approval stamp.
    const stamp = await org.owner.upload<StoredFileDto>('/files?kind=stamp', PNG, 'image/png');
    expect(stamp.status).toBe(201);
    expect(
      (
        await org.owner.put('/contract-settings/stamp', {
          stampFileId: stamp.body.id,
          stampPosition: 'end',
          stampWidthMm: 30,
        })
      ).status,
    ).toBe(200);

    // 1–6: the manager drafts from the template and saves.
    const c = await draft(org);
    expect(c.missing).toEqual([]);
    expect(c.can).toMatchObject({ edit: true, submit: true, decide: false });

    // 7–8: submit; approvers are notified in-app.
    const sub = await org.manager.post<ContractDto>(`/contracts/${c.id}/submit`, {
      note: 'Ready for review',
    });
    expect(sub.status).toBe(200);
    expect(sub.body.status).toBe('pending_approval');
    const notified = await t.db
      .select()
      .from(notifications)
      .where(eq(notifications.type, 'contract.approval_requested'));
    expect(notified.map((n) => n.recipientUserId).sort()).toEqual(
      [org.ownerId, org.approverId].sort(),
    );
    // Nothing can change while it is under review, and the manager can't approve.
    expect(
      (await org.manager.put(`/contracts/${c.id}`, savePayload(c, c.snapshot.details))).body.error
        .code,
    ).toBe('contract_not_editable');
    expect((await org.manager.post(`/contracts/${c.id}/approve`, {})).status).toBe(403);

    // 9: the approver sees it in the approvals view and rejects — a reason is mandatory.
    const queue = (await org.approver.get<ContractSummaryDto[]>('/contracts?view=approvals')).body;
    expect(queue.map((x) => [x.id, x.canDecide])).toEqual([[c.id, true]]);
    expect((await org.approver.post(`/contracts/${c.id}/reject`, {})).status).toBe(400);
    expect((await org.approver.post(`/contracts/${c.id}/reject`, { reason: '  ' })).status).toBe(
      400,
    );
    const rej = await org.approver.post<ContractDto>(`/contracts/${c.id}/reject`, {
      reason: 'Salary must be stated as gross monthly pay.',
    });
    expect(rej.status).toBe(200);
    expect(rej.body.status).toBe('changes_requested');
    const [rejNote] = await t.db
      .select()
      .from(notifications)
      .where(eq(notifications.type, 'contract.rejected'));
    expect(rejNote).toMatchObject({ recipientUserId: org.managerId });
    expect(rejNote!.data).toMatchObject({
      reason: 'Salary must be stated as gross monthly pay.',
      version: 2,
    });

    // 10: resubmitting unchanged is refused; revise, then resubmit.
    expect((await org.manager.post(`/contracts/${c.id}/submit`, {})).body.error.code).toBe(
      'no_changes_since_rejection',
    );
    const revised = await org.manager.put<ContractDto>(
      `/contracts/${c.id}`,
      savePayload(
        c,
        completeDetails(c, {
          compensation: { amount: '13500', currency: 'SAR', frequency: 'monthly' },
        }),
        c.snapshot.clauses,
        'Gross monthly salary',
      ),
    );
    expect(revised.body.currentVersion).toBe(3);
    expect((await org.manager.post(`/contracts/${c.id}/submit`, {})).status).toBe(200);

    // The rejected attempt is preserved with its reason, reviewer and time.
    const mid = (await org.manager.get<ContractDto>(`/contracts/${c.id}`)).body;
    expect(mid.requests.map((r) => [r.version, r.status])).toEqual([
      [2, 'rejected'],
      [3, 'pending'],
    ]);
    expect(mid.requests[0]).toMatchObject({
      comment: 'Salary must be stated as gross monthly pay.',
      decidedBy: { id: org.approverId },
    });
    expect(mid.requests[0]!.decidedAt).toBeTruthy();
    const old = await org.manager.get(`/contracts/${c.id}/versions/2`);
    expect(old.body.snapshot.details.compensation.amount).toBe('12000');

    // 11: the delegated approver (not the Owner) approves; the stamped document is generated.
    const app = await org.approver.post<ContractDto>(`/contracts/${c.id}/approve`, {
      comment: 'Approved.',
    });
    expect(app.status).toBe(200);
    expect(app.body.status).toBe('approved');
    expect(app.body.requests[1]).toMatchObject({
      status: 'approved',
      decidedBy: { id: org.approverId, displayName: 'Noura Approver' },
      selfApproved: false,
    });
    expect(app.body.approvedDocument).toMatchObject({ version: 3, verified: true });

    // 12: the requesting manager is notified and sees the stamped approved document.
    const [okNote] = await t.db
      .select()
      .from(notifications)
      .where(eq(notifications.type, 'contract.approved'));
    expect(okNote).toMatchObject({ recipientUserId: org.managerId });
    expect(
      (await org.manager.get<ContractSummaryDto[]>('/contracts?view=approved')).body.map(
        (x) => x.id,
      ),
    ).toEqual([c.id]);
    const pdf = await org.manager.get(`/contracts/${c.id}/approved.pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(sha(pdf.bytes)).toBe(app.body.approvedDocument!.sha256);
    expect(pdf.headers.get('x-document-sha256')).toBe(app.body.approvedDocument!.sha256);
    const text = pdfText(pdf.bytes, 'approved');
    expect(text).toContain(c.number);
    expect(text).toContain('Approved by');
    expect(text).toContain('Noura Approver');
    expect(text).toContain(app.body.versions[2]!.sha256);
    expect(text).toContain('13,500.00');
    expect(pdfText(pdf.bytes, 'approved-raw', 'raw')).not.toContain('DRAFT');
    // The stamp image is in the approved PDF.
    const images = execFileSync('pdfimages', ['-list', join(dir, 'approved.pdf')]).toString();
    expect(images.trim().split('\n').length).toBeGreaterThan(2);
    // The rejected version still renders, watermarked as a draft.
    const v2 = await org.manager.get(`/contracts/${c.id}/document.pdf?version=2`);
    const v2Text = pdfText(v2.bytes, 'v2');
    expect(pdfText(v2.bytes, 'v2-raw', 'raw')).toMatch(/DRAFT —\s+NOT APPROVED/);
    expect(v2Text).toContain('12,000.00');

    // Approved contracts are final in Phase 3.
    expect(
      (await org.manager.put(`/contracts/${c.id}`, savePayload(c, c.snapshot.details))).status,
    ).toBe(409);
    expect((await org.manager.post(`/contracts/${c.id}/cancel`, {})).status).toBe(409);

    // Full audit trail: who did what, on which version.
    const trail = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.targetType, 'contract'), eq(auditLogs.targetId, c.id)))
      .orderBy(asc(auditLogs.createdAt));
    expect(trail.map((a) => a.action)).toEqual([
      'contract.created',
      'contract.saved',
      'contract.submitted',
      'contract.rejected',
      'contract.saved',
      'contract.submitted',
      'contract.approved',
      'contract.exported',
      'contract.exported',
    ]);
    const by = (action: string) => trail.filter((a) => a.action === action);
    expect(by('contract.rejected')[0]).toMatchObject({ actorUserId: org.approverId });
    expect(by('contract.rejected')[0]!.metadata).toMatchObject({
      version: 2,
      reason: 'Salary must be stated as gross monthly pay.',
    });
    expect(by('contract.approved')[0]).toMatchObject({ actorUserId: org.approverId });
    expect(by('contract.approved')[0]!.metadata).toMatchObject({
      version: 3,
      documentSha256: app.body.approvedDocument!.sha256,
      selfApproved: false,
    });
    expect(
      by('contract.submitted').map((a) => (a.metadata as { resubmission: boolean }).resubmission),
    ).toEqual([false, true]);
    expect(
      trail
        .filter((a) => a.action !== 'contract.rejected' && a.action !== 'contract.approved')
        .every((a) => a.actorUserId === org.managerId),
    ).toBe(true);
  }, 120_000);

  test('nobody decides their own request, except an Owner, whose self-approval is recorded', async () => {
    const org = await contractOrg();
    const role = await org.owner.post('/roles', {
      nameEn: 'Senior manager',
      permissions: ['contracts.view', 'contracts.create', 'contracts.edit', 'contracts.approve'],
    });
    const senior = await inviteAndAccept(t, org.owner, 'senior@example.com', [
      { roleId: role.body.id, scopeType: 'organization' },
    ]);
    const c = await draft(org, senior.client);
    await senior.client.post(`/contracts/${c.id}/submit`, {});
    const self = await senior.client.post(`/contracts/${c.id}/approve`, {});
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('self_approval_not_allowed');
    expect(
      (await senior.client.post(`/contracts/${c.id}/reject`, { reason: 'Never mind' })).body.error
        .code,
    ).toBe('self_approval_not_allowed');
    expect((await senior.client.get<ContractDto>(`/contracts/${c.id}`)).body.can.decide).toBe(
      false,
    );

    const own = await draft(org, org.owner);
    await org.owner.post(`/contracts/${own.id}/submit`, {});
    const ok = await org.owner.post<ContractDto>(`/contracts/${own.id}/approve`, {});
    expect(ok.status).toBe(200);
    expect(ok.body.requests[0]!.selfApproved).toBe(true);
    const [log] = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'contract.approved'), eq(auditLogs.targetId, own.id)));
    expect(log!.metadata).toMatchObject({ selfApproved: true });
  }, 60_000);

  test('one open request at a time; withdrawing returns the contract to editing', async () => {
    const org = await contractOrg();
    const c = await draft(org);
    await org.manager.post(`/contracts/${c.id}/submit`, {});
    expect((await org.manager.post(`/contracts/${c.id}/submit`, {})).body.error.code).toBe(
      'contract_invalid_transition',
    );
    const w = await org.manager.post<ContractDto>(`/contracts/${c.id}/withdraw`, {});
    expect(w.body.status).toBe('draft');
    expect(w.body.requests.map((r) => r.status)).toEqual(['withdrawn']);
    expect((await org.approver.post(`/contracts/${c.id}/approve`, {})).status).toBe(409);
    const cancelled = await org.manager.post<ContractDto>(`/contracts/${c.id}/cancel`, {});
    expect(cancelled.body.status).toBe('cancelled');
    expect((await org.manager.post(`/contracts/${c.id}/submit`, {})).status).toBe(409);
  });

  test('the database itself refuses a rejection without a reason and a second pending request', async () => {
    const org = await contractOrg();
    const c = await draft(org);
    await org.manager.post(`/contracts/${c.id}/submit`, {});
    await expect(
      Promise.resolve(
        t.db
          .update(approvalRequests)
          .set({ status: 'rejected', comment: null })
          .where(eq(approvalRequests.contractId, c.id)),
      ),
    ).rejects.toThrow();
    const [req] = await t.db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.contractId, c.id));
    await expect(
      Promise.resolve(t.db.insert(approvalRequests).values({ ...req!, id: crypto.randomUUID() })),
    ).rejects.toThrow();
    await expect(
      Promise.resolve(
        t.db
          .update(approvalRequests)
          .set({ status: 'approved' })
          .where(eq(approvalRequests.contractId, c.id)),
      ),
    ).rejects.toThrow();
  });
});

describe('scope and views', () => {
  test("a team-scoped manager sees and acts only on their team's contracts", async () => {
    const org = await contractOrg();
    const pid = await typeId(org.owner);
    const b = (
      await org.owner.post<ContractDto>('/contracts', { contractTypeId: pid, teamId: org.teamB.id })
    ).body;
    const none = (await org.owner.post<ContractDto>('/contracts', { contractTypeId: pid })).body;
    const a = await draft(org);
    expect((await org.manager.get(`/contracts/${b.id}`)).status).toBe(404);
    expect((await org.manager.get(`/contracts/${none.id}`)).status).toBe(404);
    expect(
      (await org.manager.put(`/contracts/${b.id}`, savePayload(b, b.snapshot.details))).status,
    ).toBe(404);
    expect((await org.manager.get(`/contracts/${b.id}/preview`)).status).toBe(404);
    expect(
      (await org.manager.post(`/contracts/${b.id}/proposals`, { purpose: 'A streaming clause' }))
        .status,
    ).toBe(404);
    expect(
      (await org.manager.get<ContractSummaryDto[]>('/contracts')).body.map((x) => x.id),
    ).toEqual([a.id]);
    // Creating outside their scope, or with no team, is forbidden.
    expect(
      (await org.manager.post('/contracts', { contractTypeId: pid, teamId: org.teamB.id })).status,
    ).toBe(403);
    expect((await org.manager.post('/contracts', { contractTypeId: pid })).status).toBe(403);
    // Moving their contract to another team is too.
    expect(
      (
        await org.manager.put(`/contracts/${a.id}`, {
          ...savePayload(a, a.snapshot.details),
          teamId: org.teamB.id,
          rosterMemberId: null,
        })
      ).status,
    ).toBe(403);
    // The Owner sees everything.
    expect((await org.owner.get<ContractSummaryDto[]>('/contracts')).body).toHaveLength(3);
  });

  test('a team-scoped approver decides only for that team', async () => {
    const org = await contractOrg();
    const role = await org.owner.post('/roles', {
      nameEn: 'Team A approver',
      permissions: ['contracts.view', 'contracts.approve'],
    });
    const teamApprover = await inviteAndAccept(t, org.owner, 'ta@example.com', [
      { roleId: role.body.id, scopeType: 'team', scopeId: org.teamA.id },
    ]);
    const a = await draft(org);
    await org.manager.post(`/contracts/${a.id}/submit`, {});
    const b = await draft(org, org.owner);
    const bOnB = await org.owner.put<ContractDto>(`/contracts/${b.id}`, {
      ...savePayload(b, b.snapshot.details),
      teamId: org.teamB.id,
      rosterMemberId: null,
    });
    expect(bOnB.status).toBe(200);
    await org.owner.post(`/contracts/${b.id}/submit`, {});
    expect((await teamApprover.client.post(`/contracts/${b.id}/approve`, {})).status).toBe(404);
    expect(
      (await teamApprover.client.get<ContractSummaryDto[]>('/contracts?view=approvals')).body.map(
        (x) => x.id,
      ),
    ).toEqual([a.id]);
    expect((await teamApprover.client.post(`/contracts/${a.id}/approve`, {})).status).toBe(200);
  }, 60_000);

  test('approval requests, approved and signed contracts are separate views', async () => {
    const org = await contractOrg();
    const d = await draft(org);
    const p = await draft(org);
    await org.manager.post(`/contracts/${p.id}/submit`, {});
    const ap = await draft(org);
    await org.manager.post(`/contracts/${ap.id}/submit`, {});
    await org.approver.post(`/contracts/${ap.id}/approve`, {});
    const ids = async (view: string) =>
      (await org.owner.get<ContractSummaryDto[]>(`/contracts?view=${view}`)).body.map((x) => x.id);
    expect(await ids('drafts')).toEqual([d.id]);
    expect(await ids('approvals')).toEqual([p.id]);
    expect(await ids('approved')).toEqual([ap.id]);
    expect(await ids('signed')).toEqual([]); // signatures arrive in Phase 4
    expect((await ids('all')).sort()).toEqual([d.id, p.id, ap.id].sort());
  }, 60_000);
});

describe('document setup', () => {
  test('uploads are identified by their bytes and checked against their kind and size', async () => {
    const org = await contractOrg();
    expect((await org.owner.upload('/files?kind=logo', PNG, 'image/jpeg')).body.error.code).toBe(
      'unsupported_file_type',
    );
    expect(
      (
        await org.owner.upload(
          '/files?kind=logo',
          Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
          'image/png',
        )
      ).status,
    ).toBe(415);
    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
    const tooBig = await org.owner.upload('/files?kind=logo', big, 'image/png');
    expect(tooBig.status).toBe(413);
    expect(tooBig.body.error.code).toBe('file_too_large');
    expect((await org.manager.upload('/files?kind=logo', PNG, 'image/png')).status).toBe(403);
    const logo = await org.owner.upload<StoredFileDto>('/files?kind=logo', PNG, 'image/png');
    expect(logo.status).toBe(201);
    expect(logo.body.sha256).toBe(sha(PNG));
    const served = await org.manager.get(`/files/${logo.body.id}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(served.bytes.equals(PNG)).toBe(true);
    // Another organization can't read it.
    const other = await registerOwner(t, { slug: 'other-org', email: 'other@example.com' });
    expect((await other.client.get(`/files/${logo.body.id}`)).status).toBe(404);
  });

  test('layout is Owner-only, file ids must match their kind, and changes are audited', async () => {
    const org = await contractOrg();
    const stamp = (await org.owner.upload<StoredFileDto>('/files?kind=stamp', PNG, 'image/png'))
      .body;
    const logo = (await org.owner.upload<StoredFileDto>('/files?kind=logo', PNG, 'image/png')).body;
    const settings = (await org.owner.get<DocumentSettingsDto>('/contract-settings')).body;
    expect(settings).toMatchObject({
      organizationName: 'Riyadh Falcons',
      defaultLanguage: 'bilingual',
      marginTopMm: 20,
      backgroundKind: 'none',
    });
    const {
      organizationName: _n,
      stampFileId: _s,
      stampPosition: _p,
      stampWidthMm: _w,
      ...layout
    } = settings;
    expect((await org.manager.get('/contract-settings')).status).toBe(403);
    expect((await org.manager.put('/contract-settings/document', layout)).status).toBe(403);
    expect(
      (await org.owner.put('/contract-settings/document', { ...layout, logoFileId: stamp.id }))
        .status,
    ).toBe(400);
    const pdfBg = await PDFDocument.create();
    pdfBg.addPage([595.28, 841.89]);
    const bg = (
      await org.owner.upload<StoredFileDto>(
        '/files?kind=background',
        Buffer.from(await pdfBg.save()),
        'application/pdf',
      )
    ).body;
    expect(
      (
        await org.owner.put('/contract-settings/document', {
          ...layout,
          backgroundKind: 'image',
          backgroundFileId: bg.id,
        })
      ).status,
    ).toBe(400);
    const saved = await org.owner.put<DocumentSettingsDto>('/contract-settings/document', {
      ...layout,
      legalNameEn: 'Riyadh Falcons Esports Co.',
      legalNameAr: 'شركة صقور الرياض للرياضات الإلكترونية',
      commercialRegistration: '1010000000',
      logoFileId: logo.id,
      logoPosition: 'center',
      backgroundKind: 'pdf',
      backgroundFileId: bg.id,
      pageBorder: true,
      marginTopMm: 25,
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      logoPosition: 'center',
      backgroundKind: 'pdf',
      marginTopMm: 25,
    });
    const [log] = await t.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'document_settings.updated'));
    expect((log!.metadata as { changes: Record<string, unknown> }).changes).toHaveProperty(
      'marginTopMm',
    );
    // The stamp needs sensitive-settings rights (Owner-only).
    expect(
      (await org.manager.put('/contract-settings/stamp', { stampFileId: stamp.id })).status,
    ).toBe(403);
    expect((await org.owner.put('/contract-settings/stamp', { stampFileId: logo.id })).status).toBe(
      400,
    );
  });

  test('the sample renders as HTML and as PDF in each language, with image and PDF backgrounds', async () => {
    const org = await contractOrg();
    const settings = (await org.owner.get<DocumentSettingsDto>('/contract-settings')).body;
    const {
      organizationName: _n,
      stampFileId: _s,
      stampPosition: _p,
      stampWidthMm: _w,
      ...layout
    } = settings;
    const html = await org.owner.get('/contract-settings/sample.html?language=bilingual');
    expect(html.status).toBe(200);
    expect(html.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(html.text).toContain('dir="rtl"');
    expect(html.text).toContain('DRAFT');
    expect(html.text).not.toMatch(/<script/i);

    const bg = (await org.owner.upload<StoredFileDto>('/files?kind=background', PNG, 'image/png'))
      .body;
    await org.owner.put('/contract-settings/document', {
      ...layout,
      backgroundKind: 'image',
      backgroundFileId: bg.id,
    });
    const imgPdf = await org.owner.get('/contract-settings/sample.pdf?language=en');
    expect(imgPdf.status).toBe(200);
    expect(pdfText(imgPdf.bytes, 'sample-en')).toContain('Contract Particulars');

    const pdfBg = await PDFDocument.create();
    pdfBg.addPage([595.28, 841.89]).drawText('LETTERHEAD-BACKGROUND', { x: 40, y: 20, size: 8 });
    const bgPdf = (
      await org.owner.upload<StoredFileDto>(
        '/files?kind=background',
        Buffer.from(await pdfBg.save()),
        'application/pdf',
      )
    ).body;
    await org.owner.put('/contract-settings/document', {
      ...layout,
      backgroundKind: 'pdf',
      backgroundFileId: bgPdf.id,
    });
    const ar = await org.owner.get('/contract-settings/sample.pdf?language=ar&approved=1');
    const arText = pdfText(ar.bytes, 'sample-ar', 'raw');
    expect(arText).toContain('LETTERHEAD-BACKGROUND');
    expect(arText).not.toContain('DRAFT');
    expect(pdfText(imgPdf.bytes, 'sample-en-raw', 'raw')).toMatch(/DRAFT —\s+NOT APPROVED/);
  }, 60_000);
});

describe('custom clause assistant', () => {
  test('proposals never change the contract; only explicit acceptance adds exactly that clause', async () => {
    const org = await contractOrg();
    const c = await draft(org);
    expect((await org.manager.get('/contracts/assistant-status')).body).toEqual({
      configured: true,
      provider: 'fake',
      model: 'fake-model',
    });

    const p1 = await org.manager.post<ClauseProposalDto>(`/contracts/${c.id}/proposals`, {
      purpose: 'The player must stream on our channel every week.',
    });
    expect(p1.status).toBe(201);
    expect(p1.body).toMatchObject({
      status: 'proposed',
      titleEn: DRAFT.titleEn,
      questions: DRAFT.questions,
    });
    // The model saw the request and the clause titles, but no personal data.
    const prompt = ai.calls[0]!.prompt;
    expect(prompt).toContain('stream on our channel');
    expect(prompt).toContain('{{recipientName}}');
    for (const secret of ['Saad', 'سعد', '1098765432', '12000', '2001-04-02'])
      expect(prompt).not.toContain(secret);
    expect(ai.calls[0]!.system).toMatch(/Never state or imply that the clause is legally valid/);

    // Revising sends the previous draft and the feedback; still no change to the contract.
    ai.next = { ...DRAFT, bodyEn: `${DRAFT.bodyEn.replace('[number]', '10')}`, questions: [] };
    const p2 = await org.manager.post<ClauseProposalDto>(`/contracts/${c.id}/proposals`, {
      purpose: p1.body.purpose,
      revisionOf: p1.body.id,
      feedback: 'Ten hours a week.',
    });
    expect(ai.calls[1]!.prompt).toContain(DRAFT.bodyEn);
    expect(ai.calls[1]!.prompt).toContain('Ten hours a week.');
    const unchanged = (await org.manager.get<ContractDto>(`/contracts/${c.id}`)).body;
    expect(unchanged.currentVersion).toBe(c.currentVersion);
    expect(unchanged.snapshot).toEqual(c.snapshot);

    // Rejecting is also a no-op on the contract.
    expect(
      (
        await org.manager.post<ClauseProposalDto>(
          `/contracts/${c.id}/proposals/${p1.body.id}/reject`,
          {},
        )
      ).body.status,
    ).toBe('rejected');
    expect(
      (await org.manager.post(`/contracts/${c.id}/proposals/${p1.body.id}/accept`, {})).status,
    ).toBe(409);

    // Accepting inserts exactly that clause where asked; every other clause is unchanged.
    const before = c.snapshot.clauses[3]!.id;
    const acc = await org.manager.post<{ clauseId: string; contract: ContractDto }>(
      `/contracts/${c.id}/proposals/${p2.body.id}/accept`,
      { beforeClauseId: before },
    );
    expect(acc.status).toBe(200);
    const after = acc.body.contract;
    expect(after.currentVersion).toBe(c.currentVersion + 1);
    expect(after.snapshot.clauses).toHaveLength(c.snapshot.clauses.length + 1);
    expect(after.snapshot.clauses[3]).toMatchObject({
      id: acc.body.clauseId,
      source: 'assistant',
      required: false,
      included: true,
      bodyEn: ai.next && (ai.next as typeof DRAFT).bodyEn,
    });
    expect(after.snapshot.clauses.filter((x) => x.id !== acc.body.clauseId)).toEqual(
      c.snapshot.clauses,
    );
    expect(after.snapshot.details).toEqual(c.snapshot.details);
    expect(
      (await org.manager.post(`/contracts/${c.id}/proposals/${p2.body.id}/accept`, {})).status,
    ).toBe(409);
    const list = (await org.manager.get<ClauseProposalDto[]>(`/contracts/${c.id}/proposals`)).body;
    expect(list.map((p) => p.status)).toEqual(['accepted', 'rejected']);
    const actions = (await t.db.select().from(auditLogs).where(eq(auditLogs.targetId, c.id))).map(
      (a) => a.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        'contract.clause_proposed',
        'contract.clause_proposal_rejected',
        'contract.clause_accepted',
      ]),
    );
  });

  test('the assistant needs editing rights and an editable contract; bad output is not stored', async () => {
    const org = await contractOrg();
    const c = await draft(org);
    expect(
      (
        await org.approver.post(`/contracts/${c.id}/proposals`, {
          purpose: 'Something useful here',
        })
      ).status,
    ).toBe(403);
    ai.next = { ...DRAFT, bodyAr: '' };
    const bad = await org.manager.post(`/contracts/${c.id}/proposals`, {
      purpose: 'Something useful here',
    });
    expect(bad.status).toBe(502);
    expect(bad.body.error.code).toBe('ai_unavailable');
    expect((await org.manager.get(`/contracts/${c.id}/proposals`)).body).toEqual([]);
    ai.next = null;
    await org.manager.post(`/contracts/${c.id}/submit`, {});
    expect(
      (await org.manager.post(`/contracts/${c.id}/proposals`, { purpose: 'Something useful here' }))
        .status,
    ).toBe(409);
  });
});

describe('without an Anthropic API key', () => {
  test('the assistant reports "not configured" and refuses proposals; contracts still work', async () => {
    await t.close();
    const plain = await startApp(); // no AI override, no ANTHROPIC_API_KEY
    try {
      const { client: owner } = await registerOwner(plain);
      expect((await owner.get('/contracts/assistant-status')).body).toEqual({
        configured: false,
        provider: null,
        model: null,
      });
      const c = await owner.post<ContractDto>('/contracts', {
        contractTypeId: await typeId(owner),
      });
      expect(c.status).toBe(201);
      const r = await owner.post(`/contracts/${c.body.id}/proposals`, {
        purpose: 'A streaming clause please',
      });
      expect(r.status).toBe(503);
      expect(r.body.error.code).toBe('ai_not_configured');
    } finally {
      await plain.close();
      t = await startApp({ ai });
    }
  });
});

describe('structural checks', () => {
  test('migrations 0005 + 0007 grant existing roles exactly the template contract permissions', () => {
    const fromSql: Record<string, string[]> = {};
    for (const file of ['0005_contracts_hardening.sql', '0007_signatures_hardening.sql']) {
      const sqlText = readFileSync(join(import.meta.dir, '../drizzle', file), 'utf8');
      for (const m of sqlText.matchAll(
        /unnest\(ARRAY\[([\s\S]*?)\]\)[\s\S]*?template_key = '(\w+)'/g,
      )) {
        const keys = [...m[1]!.matchAll(/'([\w.]+)'/g)].map((x) => x[1]!);
        fromSql[m[2]!] = [...(fromSql[m[2]!] ?? []), ...keys].sort();
      }
    }
    const fromTemplates = Object.fromEntries(
      DEFAULT_ROLE_TEMPLATES.filter((r) => r.templateKey !== 'owner')
        .map(
          (r) =>
            [
              r.templateKey,
              r.permissions
                .filter((p) => PERMISSIONS[p as PermissionKey].domain === 'contracts')
                .sort(),
            ] as const,
        )
        .filter(([, p]) => p.length),
    );
    expect(fromSql).toEqual(fromTemplates);
    // Approval is never part of a default template: the Owner delegates it deliberately.
    expect(
      DEFAULT_ROLE_TEMPLATES.some((r) => (r.permissions as string[]).includes('contracts.approve')),
    ).toBe(false);
  });
});

describe('Saudi riyal sign (U+20C1)', () => {
  const post = (c: Client, path: string, body: unknown) =>
    fetch(`${t.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost:3000',
        cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, bytes: Buffer.from(await r.arrayBuffer()) }));
  const fontsIn = (bytes: Buffer, name: string) => {
    const p = join(dir, `${name}.pdf`);
    writeFileSync(p, bytes);
    return execFileSync('pdffonts', [p]).toString('utf8');
  };

  test('PDFs print it from the embedded font (Arabic and English); data exports keep "SAR"', async () => {
    const { client: owner } = await registerOwner(t);
    expect(
      (await owner.post('/finance/expenses', expense({ amount: '1250', currency: 'SAR' }))).status,
    ).toBe(201);
    for (const locale of ['en', 'ar']) {
      const pdf = await post(owner, '/finance/reports/export', {
        query: { scope: 'organization' },
        format: 'pdf',
        locale,
      });
      expect(pdf.status).toBe(200);
      expect(pdfText(pdf.bytes, `riyal-report-${locale}`)).toContain('⃁ 1,250.00');
      expect(pdfText(pdf.bytes, `riyal-report-${locale}`)).not.toContain('SAR 1,250.00');
      // The glyph comes from the bundled riyal font, embedded like IBM Plex (no system fallback).
      const fonts = fontsIn(pdf.bytes, `riyal-report-${locale}-fonts`);
      expect(fonts).toMatch(/saudi_riyal/i);
      expect(fonts).toMatch(/IBMPlexSans/i);
      expect(fonts).not.toMatch(/unifont|dejavu|liberation/i);
    }
    // Data files are opened in other software, whose fonts may lack the glyph: ISO code there.
    const file = async (format: string) =>
      (
        await post(owner, '/finance/reports/export', {
          query: { scope: 'organization' },
          format,
          locale: 'en',
        })
      ).bytes.toString('utf8');
    const csv = await file('csv');
    expect(csv).toContain('Reporting currency,SAR');
    expect(csv).toContain(',1250.00,SAR,');
    expect(csv).not.toContain(RIYAL_SIGN);
    const txt = (await file('txt')).replace(ISOLATES, '');
    expect(txt).toContain('SAR 1,250.00');
    expect(txt).not.toContain(RIYAL_SIGN);
  }, 120_000);

  test('contract documents use it for SAR amounts, in the clauses and the particulars', async () => {
    const org = await contractOrg();
    const c = await draft(org);
    const pdf = await org.manager.get(`/contracts/${c.id}/document.pdf`);
    const text = pdfText(pdf.bytes, 'riyal-contract');
    expect(text).toContain('⃁ 12,000.00');
    expect(text).not.toContain('SAR 12,000.00');
    expect(fontsIn(pdf.bytes, 'riyal-contract-fonts')).toMatch(/saudi_riyal/i);
    const html = await org.manager.get(`/contracts/${c.id}/preview`);
    expect(html.text).toContain('⃁ 12,000.00');
    expect(html.text).toContain('unicode-range:U+20C1');
  }, 60_000);

  test('the bundled font files are the reviewed ones and cover U+20C1', () => {
    for (const rel of ['../assets/fonts/saudi-riyal', '../../web/public/fonts/saudi-riyal']) {
      const base = join(import.meta.dir, rel);
      expect(sha(readFileSync(join(base, 'saudi-riyal-regular.woff2')))).toBe(
        'c15a031a5a2fdee1d92da7b8d32554463c2136331283a469eaf706beb761499d',
      );
      expect(sha(readFileSync(join(base, 'saudi-riyal-bold.woff2')))).toBe(
        'cf3b4adaa1a456e4a416ee999a16d9240f3c7babf082c30cd540dbb84f8a337f',
      );
      expect(readFileSync(join(base, 'OFL.txt'), 'utf8')).toContain(
        'SIL OPEN FONT LICENSE Version 1.1',
      );
    }
  });
});
