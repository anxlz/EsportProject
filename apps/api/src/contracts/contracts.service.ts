/**
 * Contracts (spec §7.5, §7.6): drafting from a template, version history, submission, approval
 * with the configured stamp, rejection with a mandatory reason, resubmission.
 *
 * Authorization (on top of the Phase 1 guards), always against the contract's team:
 *   see      contracts.view or contracts.approve (approvers must see what they approve)
 *   create   contracts.create
 *   edit     contracts.edit, or contracts.create for a contract the user created
 *   submit / withdraw / cancel   same as edit
 *   decide   contracts.approve; nobody decides their own request except an Owner, and an
 *            Owner's self-approval is recorded as such
 *   PDFs     contracts.export
 * A contract with no team is covered only by organization-wide grants. A contract outside the
 * caller's scope is reported as not found; one they can see but not act on, as forbidden.
 *
 * History: every save is a new immutable version (VersioningService). Each approval request
 * points at the exact version it submitted, so rejected attempts stay visible with their reason.
 * The stamped approved PDF is stored with its SHA-256 and served as stored.
 */
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  type ApprovalRequestDto,
  type ContractClause,
  type ContractCreateInput,
  type ContractDetailsInput,
  type ContractDto,
  type ContractSaveInput,
  type ContractSnapshot,
  type ContractStatus,
  type ContractSummaryDto,
  type ContractTypeDto,
  completenessIssues,
  contractDetailsSchema,
  type DocumentSettingsDto,
  EDITABLE_STATUSES,
  type MergeContext,
  type RecipientKind,
  type RosterRole,
} from '@esports/shared';
import { and, asc, desc, eq, ilike, inArray, or, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Access, TeamRef } from '../authz/access';
import type { TenantContext } from '../authz/context';
import { scopeCondition } from '../authz/scope-filter';
import { AuditService } from '../audit/audit.service';
import { AppError, Errors } from '../common/errors';
import { DB, type Database, type DbOrTx } from '../db/client';
import { games, organizations, teams, users } from '../db/schema';
import {
  approvalRequests,
  contracts,
  contractCounters,
  contractTypes,
  storedFiles,
} from '../db/schema-contracts';
import { rosterMembers } from '../db/schema-finance';
import { FilesService } from '../files/files.service';
import { coversRecord, loadTeamRef } from '../finance/scope';
import { NotificationService } from '../notifications/notification.service';
import { PdfService } from '../pdf/pdf.service';
import {
  canonicalJson,
  sha256Hex,
  VersioningService,
  type VersionRecord,
} from '../versioning/versioning.service';
import {
  type ApprovalInfo,
  contractHtml,
  contractMargins,
  PAGE_NUMBER_FOOTER,
  type RenderInput,
} from './contract-document';
import { ContractTypesService } from './contract-types.service';
import { DocumentSettingsService } from './document-settings.service';
import { renderGuard } from './http';

export const CONTRACT_ENTITY = 'contract';
const APPROVED_DOCUMENT_KIND = 'contract_approved';

type ContractRow = typeof contracts.$inferSelect;
type RequestRow = typeof approvalRequests.$inferSelect;

export interface LoadedContract {
  row: ContractRow;
  team: (TeamRef & { name: string }) | null;
}

const ROSTER_KIND: Record<RosterRole, RecipientKind> = {
  starter: 'player',
  substitute: 'player',
  head_coach: 'coach',
  assistant_coach: 'coach',
  analyst: 'staff',
  manager: 'manager',
  staff: 'staff',
};
const ARABIC = /[؀-ۿ]/;

/** Visibility filter: view OR approve scope. An organization-wide grant of either shows all. */
function visibleCondition(access: Access): SQL | undefined {
  const cols = { teamId: contracts.teamId, departmentId: teams.departmentId };
  const view = access.scope('contracts.view');
  const approve = access.scope('contracts.approve');
  if (view?.all || approve?.all) return undefined;
  return or(scopeCondition(view, cols) ?? sql`true`, scopeCondition(approve, cols) ?? sql`true`);
}

@Injectable()
export class ContractsService {
  private readonly logger = new Logger('Contracts');

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly versions: VersioningService,
    private readonly files: FilesService,
    private readonly pdf: PdfService,
    private readonly types: ContractTypesService,
    private readonly settings: DocumentSettingsService,
  ) {}

  // ---------------------------------------------------------------- permissions

  canSee(access: Access, team: TeamRef | null) {
    return (
      coversRecord(access, 'contracts.view', team) ||
      coversRecord(access, 'contracts.approve', team)
    );
  }

  canEdit(ctx: TenantContext, c: LoadedContract) {
    return (
      coversRecord(ctx.access, 'contracts.edit', c.team) ||
      (coversRecord(ctx.access, 'contracts.create', c.team) &&
        c.row.createdByUserId === ctx.user.id)
    );
  }

  canDecide(
    ctx: TenantContext,
    team: TeamRef | null,
    request: Pick<RequestRow, 'requestedByUserId'>,
  ) {
    if (!coversRecord(ctx.access, 'contracts.approve', team)) return false;
    return request.requestedByUserId !== ctx.user.id || ctx.access.isOwner;
  }

  // ---------------------------------------------------------------- loading

  private async loadRow(
    db: DbOrTx,
    organizationId: string,
    id: string,
    lock = false,
  ): Promise<LoadedContract | null> {
    // Row lock first, on the contract alone (Postgres won't take FOR UPDATE OF a
    // schema-qualified name, and the team row needn't be locked).
    if (lock) {
      await db
        .select({ id: contracts.id })
        .from(contracts)
        .where(and(eq(contracts.id, id), eq(contracts.organizationId, organizationId)))
        .for('update');
    }
    const [r] = await db
      .select({ c: contracts, teamDepartmentId: teams.departmentId, teamName: teams.name })
      .from(contracts)
      .leftJoin(teams, eq(teams.id, contracts.teamId))
      .where(and(eq(contracts.id, id), eq(contracts.organizationId, organizationId)));
    if (!r) return null;
    return {
      row: r.c,
      team: r.c.teamId
        ? { id: r.c.teamId, departmentId: r.teamDepartmentId, name: r.teamName ?? '' }
        : null,
    };
  }

  /** The contract if the caller may see it; otherwise "not found" (no existence leak). */
  async loadVisible(
    ctx: TenantContext,
    id: string,
    db: DbOrTx = this.db,
    lock = false,
  ): Promise<LoadedContract> {
    const c = await this.loadRow(db, ctx.organizationId, id, lock);
    if (!c || !this.canSee(ctx.access, c.team)) throw Errors.notFound('Contract');
    return c;
  }

  private async latest(organizationId: string, contractId: string, db: DbOrTx = this.db) {
    const v = await this.versions.get<ContractSnapshot>(
      organizationId,
      CONTRACT_ENTITY,
      contractId,
      undefined,
      db,
    );
    if (!v) throw new AppError('internal_error', 500, 'Contract has no versions');
    return v;
  }

  private mergeContext(s: DocumentSettingsDto, number: string): MergeContext {
    return {
      organizationName: s.organizationName,
      legalNameEn: s.legalNameEn,
      legalNameAr: s.legalNameAr,
      contractNumber: number,
    };
  }

  // ---------------------------------------------------------------- creation

  private async nextNumber(tx: DbOrTx, organizationId: string, now: Date) {
    const year = now.getUTCFullYear();
    const [row] = await tx
      .insert(contractCounters)
      .values({ organizationId, year, last: 1 })
      .onConflictDoUpdate({
        target: [contractCounters.organizationId, contractCounters.year],
        set: { last: sql`${contractCounters.last} + 1` },
      })
      .returning({ last: contractCounters.last });
    return `CT-${year}-${String(row!.last).padStart(4, '0')}`;
  }

  /** Validates references and freezes names into the snapshot. */
  private async buildSnapshot(
    db: DbOrTx,
    organizationId: string,
    type: Pick<ContractTypeDto, 'id' | 'nameEn' | 'nameAr'>,
    team: (TeamRef & { name: string }) | null,
    rosterMemberId: string | null,
    details: ContractDetailsInput,
    clauses: ContractClause[],
  ): Promise<ContractSnapshot> {
    if (rosterMemberId) {
      if (!team) throw Errors.badRequest('validation_failed', 'A roster member needs a team');
      const [rm] = await db
        .select({ id: rosterMembers.id })
        .from(rosterMembers)
        .where(
          and(
            eq(rosterMembers.id, rosterMemberId),
            eq(rosterMembers.organizationId, organizationId),
            eq(rosterMembers.teamId, team.id),
          ),
        );
      if (!rm)
        throw Errors.badRequest('validation_failed', 'That roster member is not on this team');
    }
    let gameName: string | null = null;
    if (details.gameId) {
      const [g] = await db
        .select({ name: games.name })
        .from(games)
        .where(and(eq(games.id, details.gameId), eq(games.organizationId, organizationId)));
      if (!g) throw Errors.badRequest('validation_failed', 'Unknown game');
      gameName = g.name;
    }
    return {
      contractTypeId: type.id,
      typeNameEn: type.nameEn,
      typeNameAr: type.nameAr,
      teamId: team?.id ?? null,
      teamName: team?.name ?? null,
      gameName,
      rosterMemberId,
      details,
      clauses,
    };
  }

  async create(ctx: TenantContext, input: ContractCreateInput): Promise<ContractDto> {
    await this.types.ensureDefaults(ctx);
    const type = await this.types.load(this.db, ctx.organizationId, input.contractTypeId);
    if (type.archivedAt)
      throw Errors.badRequest('validation_failed', 'This contract type is archived');
    const team = await loadTeamRef(this.db, ctx.organizationId, input.teamId);
    if (!coversRecord(ctx.access, 'contracts.create', team)) throw Errors.forbidden();
    if (input.rosterMemberId && !team)
      throw Errors.badRequest('validation_failed', 'A roster member needs a team');

    const settings = await this.settings.get(ctx.organizationId);
    const [org] = await this.db
      .select({ base: organizations.baseCurrency })
      .from(organizations)
      .where(eq(organizations.id, ctx.organizationId));
    const [teamRow] = team
      ? await this.db.select({ gameId: teams.gameId }).from(teams).where(eq(teams.id, team.id))
      : [];
    const [rm] = input.rosterMemberId
      ? await this.db
          .select()
          .from(rosterMembers)
          .where(
            and(
              eq(rosterMembers.id, input.rosterMemberId),
              eq(rosterMembers.organizationId, ctx.organizationId),
              eq(rosterMembers.teamId, team!.id),
            ),
          )
      : [];
    if (input.rosterMemberId && !rm)
      throw Errors.badRequest('validation_failed', 'That roster member is not on this team');

    const kind: RecipientKind = rm
      ? (ROSTER_KIND[rm.role as RosterRole] ?? 'other')
      : ((type.key as RecipientKind | null) ?? 'other');
    const currency = org?.base ?? 'SAR';
    const details = contractDetailsSchema.parse({
      language: settings.defaultLanguage,
      recipient: {
        kind,
        fullNameEn: rm && !ARABIC.test(rm.fullName) ? rm.fullName : null,
        fullNameAr: rm && ARABIC.test(rm.fullName) ? rm.fullName : null,
        nationality: rm?.nationality ?? null,
        dateOfBirth: rm?.dateOfBirth ?? null,
        email: rm?.email ?? null,
        phone: rm?.phone ?? null,
      },
      gameId: teamRow?.gameId ?? null,
      role: rm?.position ?? null,
      compensation: { currency, frequency: 'monthly' },
      buyout: { currency },
    });
    const template = await this.types.clauses(ctx.organizationId, type.id);
    const clauses: ContractClause[] = template.map((c) => ({
      id: randomUUID(),
      templateClauseId: c.id,
      source: 'template',
      required: c.required,
      included: true,
      titleEn: c.titleEn,
      titleAr: c.titleAr,
      bodyEn: c.bodyEn,
      bodyAr: c.bodyAr,
    }));

    const id = await this.db.transaction(async (tx) => {
      const snapshot = await this.buildSnapshot(
        tx,
        ctx.organizationId,
        type,
        team,
        rm?.id ?? null,
        details,
        clauses,
      );
      const number = await this.nextNumber(tx, ctx.organizationId, new Date());
      const [row] = await tx
        .insert(contracts)
        .values({
          organizationId: ctx.organizationId,
          number,
          contractTypeId: type.id,
          teamId: team?.id ?? null,
          rosterMemberId: rm?.id ?? null,
          gameId: details.gameId ?? null,
          status: 'draft',
          title: details.title ?? '',
          recipientName: recipientName(details),
          currentVersion: 1,
          createdByUserId: ctx.user.id,
          updatedByUserId: ctx.user.id,
        })
        .returning({ id: contracts.id });
      const v = await this.versions.record(tx, {
        organizationId: ctx.organizationId,
        entityType: CONTRACT_ENTITY,
        entityId: row!.id,
        snapshot,
        userId: ctx.user.id,
        note: null,
      });
      await this.audit.fromCtx(
        ctx,
        'contract.created',
        { type: 'contract', id: row!.id },
        {
          number,
          contractTypeId: type.id,
          teamId: team?.id ?? null,
          rosterMemberId: rm?.id ?? null,
          version: v.version,
          versionSha256: v.sha256,
        },
        tx,
      );
      return row!.id;
    });
    return this.get(ctx, id);
  }

  // ---------------------------------------------------------------- editing

  /**
   * Saves a new version. Template rules hold per contract: a required clause can't be removed or
   * excluded, and a clause's origin (template / custom / assistant) and required flag are taken
   * from the stored version, never from the request. New clauses are custom and optional.
   */
  async save(
    ctx: TenantContext,
    id: string,
    input: ContractSaveInput,
  ): Promise<ContractDto & { unchanged?: boolean }> {
    const result = await this.db.transaction(async (tx) => {
      const c = await this.loadVisible(ctx, id, tx, true);
      if (!this.canEdit(ctx, c)) throw Errors.forbidden();
      if (!EDITABLE_STATUSES.includes(c.row.status as ContractStatus)) {
        throw Errors.conflict(
          'contract_not_editable',
          'Only drafts and contracts with requested changes can be edited',
        );
      }
      const team = await loadTeamRef(tx, ctx.organizationId, input.teamId);
      // Moving a contract to another team (or to none) needs the same right there too.
      if (team?.id !== c.team?.id && !this.canEdit(ctx, { ...c, team })) throw Errors.forbidden();
      const prev = await this.latest(ctx.organizationId, id, tx);
      const clauses = mergeClauses(prev.snapshot.clauses, input.clauses);
      const type = await this.types.load(tx, ctx.organizationId, c.row.contractTypeId);
      const snapshot = await this.buildSnapshot(
        tx,
        ctx.organizationId,
        { id: type.id, nameEn: prev.snapshot.typeNameEn, nameAr: prev.snapshot.typeNameAr },
        team,
        input.rosterMemberId ?? null,
        input.details,
        clauses,
      );
      if (canonicalJson(snapshot) === canonicalJson(prev.snapshot)) return { unchanged: true };

      const v = await this.versions.record(tx, {
        organizationId: ctx.organizationId,
        entityType: CONTRACT_ENTITY,
        entityId: id,
        snapshot,
        userId: ctx.user.id,
        note: input.note ?? null,
      });
      await tx
        .update(contracts)
        .set({
          teamId: team?.id ?? null,
          rosterMemberId: input.rosterMemberId ?? null,
          gameId: input.details.gameId ?? null,
          title: input.details.title ?? '',
          recipientName: recipientName(input.details),
          currentVersion: v.version,
          updatedByUserId: ctx.user.id,
          updatedAt: new Date(),
        })
        .where(eq(contracts.id, id));
      await this.audit.fromCtx(
        ctx,
        'contract.saved',
        { type: 'contract', id },
        {
          number: c.row.number,
          version: v.version,
          versionSha256: v.sha256,
          changed: changedParts(prev.snapshot, snapshot),
          note: input.note ?? null,
        },
        tx,
      );
      return { unchanged: false };
    });
    const dto = await this.get(ctx, id);
    return result.unchanged ? { ...dto, unchanged: true } : dto;
  }

  /** Adds one clause (used by the Custom Clause Assistant on explicit acceptance). Nothing else changes. */
  async insertClause(
    ctx: TenantContext,
    tx: DbOrTx,
    id: string,
    clause: Omit<ContractClause, 'id' | 'templateClauseId' | 'required' | 'included'>,
    beforeClauseId: string | null | undefined,
    note: string,
  ) {
    const c = await this.loadVisible(ctx, id, tx, true);
    if (!this.canEdit(ctx, c)) throw Errors.forbidden();
    if (!EDITABLE_STATUSES.includes(c.row.status as ContractStatus))
      throw Errors.conflict('contract_not_editable');
    const prev = await this.latest(ctx.organizationId, id, tx);
    const added: ContractClause = {
      ...clause,
      id: randomUUID(),
      templateClauseId: null,
      required: false,
      included: true,
    };
    const clauses = [...prev.snapshot.clauses];
    const at = beforeClauseId ? clauses.findIndex((x) => x.id === beforeClauseId) : -1;
    if (beforeClauseId && at < 0) throw Errors.badRequest('validation_failed', 'Unknown clause');
    clauses.splice(at < 0 ? clauses.length : at, 0, added);
    const snapshot: ContractSnapshot = { ...prev.snapshot, clauses };
    const v = await this.versions.record(tx, {
      organizationId: ctx.organizationId,
      entityType: CONTRACT_ENTITY,
      entityId: id,
      snapshot,
      userId: ctx.user.id,
      note,
    });
    await tx
      .update(contracts)
      .set({ currentVersion: v.version, updatedByUserId: ctx.user.id, updatedAt: new Date() })
      .where(eq(contracts.id, id));
    return { clauseId: added.id, version: v.version, sha256: v.sha256, number: c.row.number };
  }

  // ---------------------------------------------------------------- workflow

  async submit(
    ctx: TenantContext,
    id: string,
    note: string | null | undefined,
  ): Promise<ContractDto> {
    const settings = await this.settings.get(ctx.organizationId);
    const { team, number } = await this.db.transaction(async (tx) => {
      const c = await this.loadVisible(ctx, id, tx, true);
      if (!this.canEdit(ctx, c)) throw Errors.forbidden();
      if (!EDITABLE_STATUSES.includes(c.row.status as ContractStatus)) {
        throw Errors.conflict(
          'contract_invalid_transition',
          'This contract cannot be submitted in its current state',
        );
      }
      const v = await this.latest(ctx.organizationId, id, tx);
      const missing = completenessIssues(v.snapshot, this.mergeContext(settings, c.row.number));
      if (missing.length)
        throw new AppError('contract_incomplete', 400, 'Some details are still missing', {
          missing,
        });
      if (c.row.status === 'changes_requested') {
        const [last] = await tx
          .select({ version: approvalRequests.version })
          .from(approvalRequests)
          .where(and(eq(approvalRequests.contractId, id), eq(approvalRequests.status, 'rejected')))
          .orderBy(desc(approvalRequests.requestedAt))
          .limit(1);
        if (last && last.version === v.version) {
          throw Errors.conflict(
            'no_changes_since_rejection',
            'Revise the contract before submitting it again',
          );
        }
      }
      const [req] = await tx
        .insert(approvalRequests)
        .values({
          organizationId: ctx.organizationId,
          contractId: id,
          versionId: v.id,
          version: v.version,
          status: 'pending',
          note: note ?? null,
          requestedByUserId: ctx.user.id,
        })
        .returning({ id: approvalRequests.id });
      await tx
        .update(contracts)
        .set({ status: 'pending_approval', updatedAt: new Date() })
        .where(eq(contracts.id, id));
      await this.audit.fromCtx(
        ctx,
        'contract.submitted',
        { type: 'contract', id },
        {
          number: c.row.number,
          requestId: req!.id,
          version: v.version,
          versionSha256: v.sha256,
          resubmission: c.row.status === 'changes_requested',
        },
        tx,
      );
      return { team: c.team, number: c.row.number };
    });
    await this.notifications.notifyPermissionHolders({
      organizationId: ctx.organizationId,
      permission: 'contracts.approve',
      team: team ?? 'organization',
      excludeUserIds: [ctx.user.id],
      type: 'contract.approval_requested',
      data: { contractId: id, number, requestedBy: ctx.user.displayName },
      link: `/dashboard/contracts/${id}`,
    });
    return this.get(ctx, id);
  }

  async withdraw(ctx: TenantContext, id: string): Promise<ContractDto> {
    await this.db.transaction(async (tx) => {
      const c = await this.loadVisible(ctx, id, tx, true);
      const req = await this.pendingRequest(tx, id);
      if (c.row.status !== 'pending_approval' || !req)
        throw Errors.conflict('contract_invalid_transition');
      if (!this.canEdit(ctx, c) && req.requestedByUserId !== ctx.user.id) throw Errors.forbidden();
      await tx
        .update(approvalRequests)
        .set({ status: 'withdrawn', decidedAt: new Date(), decidedByUserId: ctx.user.id })
        .where(eq(approvalRequests.id, req.id));
      const rejectedBefore = await tx
        .select({ id: approvalRequests.id })
        .from(approvalRequests)
        .where(and(eq(approvalRequests.contractId, id), eq(approvalRequests.status, 'rejected')))
        .limit(1);
      await tx
        .update(contracts)
        .set({
          status: rejectedBefore.length ? 'changes_requested' : 'draft',
          updatedAt: new Date(),
        })
        .where(eq(contracts.id, id));
      await this.audit.fromCtx(
        ctx,
        'contract.withdrawn',
        { type: 'contract', id },
        { number: c.row.number, requestId: req.id, version: req.version },
        tx,
      );
    });
    return this.get(ctx, id);
  }

  async cancel(ctx: TenantContext, id: string): Promise<ContractDto> {
    await this.db.transaction(async (tx) => {
      const c = await this.loadVisible(ctx, id, tx, true);
      if (!this.canEdit(ctx, c)) throw Errors.forbidden();
      if (!EDITABLE_STATUSES.includes(c.row.status as ContractStatus)) {
        throw Errors.conflict(
          'contract_invalid_transition',
          'Withdraw the approval request first; approved contracts are final',
        );
      }
      await tx
        .update(contracts)
        .set({ status: 'cancelled', updatedByUserId: ctx.user.id, updatedAt: new Date() })
        .where(eq(contracts.id, id));
      await this.audit.fromCtx(
        ctx,
        'contract.cancelled',
        { type: 'contract', id },
        { number: c.row.number, version: c.row.currentVersion },
        tx,
      );
    });
    return this.get(ctx, id);
  }

  private async pendingRequest(db: DbOrTx, contractId: string) {
    const [r] = await db
      .select()
      .from(approvalRequests)
      .where(
        and(eq(approvalRequests.contractId, contractId), eq(approvalRequests.status, 'pending')),
      );
    return r ?? null;
  }

  /** Checks shared by approve and reject: pending request, approve scope, not your own request. */
  private async decisionTarget(ctx: TenantContext, db: DbOrTx, id: string, lock: boolean) {
    const c = await this.loadVisible(ctx, id, db, lock);
    const req = await this.pendingRequest(db, id);
    if (c.row.status !== 'pending_approval' || !req)
      throw Errors.conflict('contract_invalid_transition', 'There is no pending approval request');
    if (!coversRecord(ctx.access, 'contracts.approve', c.team)) throw Errors.forbidden();
    if (!this.canDecide(ctx, c.team, req)) {
      throw new AppError(
        'self_approval_not_allowed',
        403,
        'Someone else with approval rights must decide on your own request',
      );
    }
    return { c, req };
  }

  async approve(
    ctx: TenantContext,
    id: string,
    comment: string | null | undefined,
  ): Promise<ContractDto> {
    // Render outside the transaction (Chromium is slow); re-check everything before committing.
    const { c, req } = await this.decisionTarget(ctx, this.db, id, false);
    const version = await this.versions.get<ContractSnapshot>(
      ctx.organizationId,
      CONTRACT_ENTITY,
      id,
      req.version,
    );
    if (!version || version.id !== req.versionId)
      throw new AppError('internal_error', 500, 'Submitted version not found');
    const approvedAt = new Date();
    const approval: ApprovalInfo = {
      approverName: ctx.user.displayName,
      approvedAt,
      version: version.version,
      sha256: version.sha256,
    };
    const pdf = await renderGuard(() =>
      this.renderPdf(ctx.organizationId, c.row.number, version.snapshot, approval),
    );
    const selfApproved = req.requestedByUserId === ctx.user.id;

    const doc = await this.db.transaction(async (tx) => {
      const again = await this.decisionTarget(ctx, tx, id, true);
      if (again.req.id !== req.id || again.c.row.currentVersion !== c.row.currentVersion) {
        throw Errors.conflict(
          'contract_invalid_transition',
          'The request changed while it was being approved; reload and try again',
        );
      }
      const file = await this.files.put(
        tx,
        ctx.organizationId,
        ctx.user.id,
        APPROVED_DOCUMENT_KIND,
        'application/pdf',
        pdf,
      );
      await tx
        .update(approvalRequests)
        .set({
          status: 'approved',
          decidedByUserId: ctx.user.id,
          decidedAt: approvedAt,
          comment: comment ?? null,
          selfApproved,
          documentFileId: file.id,
          documentSha256: file.sha256,
        })
        .where(eq(approvalRequests.id, req.id));
      await tx
        .update(contracts)
        .set({
          status: 'approved',
          approvedAt,
          approvedByUserId: ctx.user.id,
          approvedRequestId: req.id,
          updatedAt: approvedAt,
        })
        .where(eq(contracts.id, id));
      await this.audit.fromCtx(
        ctx,
        'contract.approved',
        { type: 'contract', id },
        {
          number: c.row.number,
          requestId: req.id,
          version: version.version,
          versionSha256: version.sha256,
          documentFileId: file.id,
          documentSha256: file.sha256,
          selfApproved,
          comment: comment ?? null,
        },
        tx,
      );
      return file;
    });
    await this.notifications.notify({
      organizationId: ctx.organizationId,
      recipientUserIds: [req.requestedByUserId].filter((u) => u !== ctx.user.id),
      type: 'contract.approved',
      data: {
        contractId: id,
        number: c.row.number,
        approvedBy: ctx.user.displayName,
        version: version.version,
      },
      link: `/dashboard/contracts/${id}`,
    });
    this.logger.log(`Approved ${c.row.number} v${version.version} (${doc.sha256.slice(0, 12)})`);
    return this.get(ctx, id);
  }

  async reject(ctx: TenantContext, id: string, reason: string): Promise<ContractDto> {
    const trimmed = reason.trim();
    if (trimmed.length < 3)
      throw Errors.validation([{ path: ['reason'], message: 'reason_required' }]);
    const { number, requester, version } = await this.db.transaction(async (tx) => {
      const { c, req } = await this.decisionTarget(ctx, tx, id, true);
      const now = new Date();
      await tx
        .update(approvalRequests)
        .set({
          status: 'rejected',
          decidedByUserId: ctx.user.id,
          decidedAt: now,
          comment: trimmed,
          selfApproved: req.requestedByUserId === ctx.user.id,
        })
        .where(eq(approvalRequests.id, req.id));
      await tx
        .update(contracts)
        .set({ status: 'changes_requested', updatedAt: now })
        .where(eq(contracts.id, id));
      await this.audit.fromCtx(
        ctx,
        'contract.rejected',
        { type: 'contract', id },
        {
          number: c.row.number,
          requestId: req.id,
          version: req.version,
          reason: trimmed,
        },
        tx,
      );
      return { number: c.row.number, requester: req.requestedByUserId, version: req.version };
    });
    await this.notifications.notify({
      organizationId: ctx.organizationId,
      recipientUserIds: [requester].filter((u) => u !== ctx.user.id),
      type: 'contract.rejected',
      data: { contractId: id, number, rejectedBy: ctx.user.displayName, reason: trimmed, version },
      link: `/dashboard/contracts/${id}`,
    });
    return this.get(ctx, id);
  }

  // ---------------------------------------------------------------- documents

  private async renderInput(
    organizationId: string,
    number: string,
    snapshot: ContractSnapshot,
    approval: ApprovalInfo | null,
    mode: 'print' | 'screen',
  ): Promise<{ input: RenderInput; underlay: { data: Buffer; contentType: string } | null }> {
    const s = await this.settings.get(organizationId);
    const { assets, background } = await this.settings.assets(organizationId, s);
    return {
      input: { snapshot, contractNumber: number, settings: s, assets, approval, mode, background },
      underlay: background,
    };
  }

  async renderPdf(
    organizationId: string,
    number: string,
    snapshot: ContractSnapshot,
    approval: ApprovalInfo | null,
  ): Promise<Buffer> {
    const { input, underlay } = await this.renderInput(
      organizationId,
      number,
      snapshot,
      approval,
      'print',
    );
    return this.pdf.render(contractHtml(input), {
      margin: contractMargins(input),
      footerTemplate: PAGE_NUMBER_FOOTER,
      underlay,
    });
  }

  /** Approval details for a version that was approved (so its preview carries the stamp). */
  private async approvalFor(
    organizationId: string,
    contractId: string,
    version: VersionRecord<ContractSnapshot>,
  ): Promise<ApprovalInfo | null> {
    const decider = alias(users, 'decider');
    const [r] = await this.db
      .select({ decidedAt: approvalRequests.decidedAt, name: decider.displayName })
      .from(approvalRequests)
      .leftJoin(decider, eq(decider.id, approvalRequests.decidedByUserId))
      .where(
        and(
          eq(approvalRequests.organizationId, organizationId),
          eq(approvalRequests.contractId, contractId),
          eq(approvalRequests.versionId, version.id),
          eq(approvalRequests.status, 'approved'),
        ),
      );
    return r?.decidedAt
      ? {
          approverName: r.name ?? '',
          approvedAt: r.decidedAt,
          version: version.version,
          sha256: version.sha256,
        }
      : null;
  }

  private async versionOrLatest(ctx: TenantContext, id: string, version?: number) {
    const v = await this.versions.get<ContractSnapshot>(
      ctx.organizationId,
      CONTRACT_ENTITY,
      id,
      version,
    );
    if (!v) throw Errors.notFound('Version');
    return v;
  }

  async previewHtml(ctx: TenantContext, id: string, version?: number): Promise<string> {
    const c = await this.loadVisible(ctx, id);
    const v = await this.versionOrLatest(ctx, id, version);
    const approval = await this.approvalFor(ctx.organizationId, id, v);
    const { input } = await this.renderInput(
      ctx.organizationId,
      c.row.number,
      v.snapshot,
      approval,
      'screen',
    );
    return contractHtml(input);
  }

  /** PDF of any version (watermarked unless that version was approved). */
  async documentPdf(
    ctx: TenantContext,
    id: string,
    version?: number,
  ): Promise<{ pdf: Buffer; filename: string }> {
    const c = await this.loadVisible(ctx, id);
    if (!coversRecord(ctx.access, 'contracts.export', c.team)) throw Errors.forbidden();
    const v = await this.versionOrLatest(ctx, id, version);
    const approval = await this.approvalFor(ctx.organizationId, id, v);
    const pdf = await this.renderPdf(ctx.organizationId, c.row.number, v.snapshot, approval);
    await this.audit.fromCtx(
      ctx,
      'contract.exported',
      { type: 'contract', id },
      { number: c.row.number, version: v.version, kind: approval ? 'approved_render' : 'draft' },
    );
    return { pdf, filename: `${c.row.number}-v${v.version}${approval ? '' : '-draft'}.pdf` };
  }

  /** The stamped PDF exactly as stored at approval, after checking its hash. */
  async approvedPdf(
    ctx: TenantContext,
    id: string,
  ): Promise<{ pdf: Buffer; filename: string; sha256: string }> {
    const c = await this.loadVisible(ctx, id);
    if (!coversRecord(ctx.access, 'contracts.export', c.team)) throw Errors.forbidden();
    if (c.row.status !== 'approved' || !c.row.approvedRequestId)
      throw Errors.notFound('Approved document');
    const [r] = await this.db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, c.row.approvedRequestId));
    const f = r?.documentFileId ? await this.files.get(ctx.organizationId, r.documentFileId) : null;
    if (!r || !f) throw Errors.notFound('Approved document');
    if (sha256Hex(f.data) !== r.documentSha256) {
      this.logger.error(`Integrity check failed for ${c.row.number} (file ${f.id})`);
      throw new AppError('internal_error', 500, 'The stored document failed its integrity check');
    }
    await this.audit.fromCtx(
      ctx,
      'contract.exported',
      { type: 'contract', id },
      { number: c.row.number, version: r.version, kind: 'approved', sha256: r.documentSha256 },
    );
    return {
      pdf: f.data,
      filename: `${c.row.number}-v${r.version}-approved.pdf`,
      sha256: r.documentSha256!,
    };
  }

  /** Sample contract for the document-settings preview (no stored contract involved). */
  async samplePdf(ctx: TenantContext, language: 'bilingual' | 'ar' | 'en', approved: boolean) {
    const snapshot = await this.sampleSnapshot(ctx, language);
    return this.renderPdf(
      ctx.organizationId,
      'CT-0000-0000',
      snapshot,
      approved ? sampleApproval(ctx) : null,
    );
  }

  async sampleHtml(ctx: TenantContext, language: 'bilingual' | 'ar' | 'en', approved: boolean) {
    const snapshot = await this.sampleSnapshot(ctx, language);
    const { input } = await this.renderInput(
      ctx.organizationId,
      'CT-0000-0000',
      snapshot,
      approved ? sampleApproval(ctx) : null,
      'screen',
    );
    return contractHtml(input);
  }

  private async sampleSnapshot(
    ctx: TenantContext,
    language: 'bilingual' | 'ar' | 'en',
  ): Promise<ContractSnapshot> {
    const list = await this.types.list(ctx);
    const type = list.find((t) => t.key === 'player') ?? list[0]!;
    const clauses = (await this.types.clauses(ctx.organizationId, type.id)).slice(0, 4);
    const [org] = await this.db
      .select({ base: organizations.baseCurrency })
      .from(organizations)
      .where(eq(organizations.id, ctx.organizationId));
    return {
      contractTypeId: type.id,
      typeNameEn: type.nameEn,
      typeNameAr: type.nameAr,
      teamId: null,
      teamName: 'Sample Team',
      gameName: 'Sample Game',
      rosterMemberId: null,
      details: contractDetailsSchema.parse({
        language,
        recipient: { kind: 'player', fullNameEn: 'Sample Recipient', fullNameAr: 'اسم تجريبي' },
        role: 'Player',
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        compensation: { amount: '10000', currency: org?.base ?? 'SAR', frequency: 'monthly' },
      }),
      clauses: clauses.map(({ position: _p, ...c }) => ({
        ...c,
        templateClauseId: c.id,
        source: 'template' as const,
        included: true,
      })),
    };
  }

  // ---------------------------------------------------------------- views

  async list(
    ctx: TenantContext,
    q: {
      view: 'all' | 'drafts' | 'approvals' | 'approved' | 'signed';
      teamId?: string;
      status?: string;
      q?: string;
      limit: number;
    },
  ): Promise<ContractSummaryDto[]> {
    // Signatures arrive in Phase 4; nothing is signed yet.
    if (q.view === 'signed') return [];
    const conds: (SQL | undefined)[] = [
      eq(contracts.organizationId, ctx.organizationId),
      visibleCondition(ctx.access),
    ];
    if (q.view === 'drafts') conds.push(inArray(contracts.status, ['draft', 'changes_requested']));
    if (q.view === 'approvals') conds.push(eq(contracts.status, 'pending_approval'));
    if (q.view === 'approved') conds.push(eq(contracts.status, 'approved'));
    if (q.status) conds.push(eq(contracts.status, q.status));
    if (q.teamId === 'none') conds.push(sql`${contracts.teamId} is null`);
    else if (q.teamId) conds.push(eq(contracts.teamId, q.teamId));
    if (q.q) {
      const like = `%${q.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
      conds.push(
        or(
          ilike(contracts.number, like),
          ilike(contracts.title, like),
          ilike(contracts.recipientName, like),
        ),
      );
    }
    const rows = await this.summaryQuery()
      .where(and(...conds))
      .orderBy(desc(contracts.updatedAt))
      .limit(q.limit);
    return rows.map((r) => this.toSummary(ctx, r));
  }

  private summaryQuery() {
    const creator = alias(users, 'creator');
    return this.db
      .select({
        c: contracts,
        teamName: teams.name,
        teamDepartmentId: teams.departmentId,
        typeNameEn: contractTypes.nameEn,
        typeNameAr: contractTypes.nameAr,
        creatorName: creator.displayName,
        pendingId: approvalRequests.id,
        pendingBy: approvalRequests.requestedByUserId,
      })
      .from(contracts)
      .leftJoin(teams, eq(teams.id, contracts.teamId))
      .innerJoin(contractTypes, eq(contractTypes.id, contracts.contractTypeId))
      .leftJoin(creator, eq(creator.id, contracts.createdByUserId))
      .leftJoin(
        approvalRequests,
        and(eq(approvalRequests.contractId, contracts.id), eq(approvalRequests.status, 'pending')),
      );
  }

  private toSummary(
    ctx: TenantContext,
    r: {
      c: ContractRow;
      teamName: string | null;
      teamDepartmentId: string | null;
      typeNameEn: string;
      typeNameAr: string;
      creatorName: string | null;
      pendingId: string | null;
      pendingBy: string | null;
    },
  ): ContractSummaryDto {
    const team = r.c.teamId ? { id: r.c.teamId, departmentId: r.teamDepartmentId } : null;
    return {
      id: r.c.id,
      number: r.c.number,
      title: r.c.title,
      status: r.c.status as ContractStatus,
      contractTypeId: r.c.contractTypeId,
      typeNameEn: r.typeNameEn,
      typeNameAr: r.typeNameAr,
      teamId: r.c.teamId,
      teamName: r.teamName,
      recipientName: r.c.recipientName,
      currentVersion: r.c.currentVersion,
      pendingRequestId: r.pendingId,
      canDecide: !!r.pendingId && this.canDecide(ctx, team, { requestedByUserId: r.pendingBy! }),
      createdBy: r.c.createdByUserId
        ? { id: r.c.createdByUserId, displayName: r.creatorName ?? '' }
        : null,
      updatedAt: r.c.updatedAt.toISOString(),
      approvedAt: r.c.approvedAt?.toISOString() ?? null,
    };
  }

  async get(ctx: TenantContext, id: string): Promise<ContractDto> {
    const c = await this.loadVisible(ctx, id);
    const [summaryRow] = await this.summaryQuery().where(eq(contracts.id, id));
    const summary = this.toSummary(ctx, summaryRow!);
    const history = await this.versions.list<ContractSnapshot>(
      ctx.organizationId,
      CONTRACT_ENTITY,
      id,
    );
    const current = history.at(-1)!;
    const settings = await this.settings.get(ctx.organizationId);
    const requests = await this.requests(ctx.organizationId, id, c.row.number, c.row.title);

    // Template clauses whose wording changed since the contract was drafted from the template.
    const original = new Map(history[0]!.snapshot.clauses.map((x) => [x.id, x]));
    const modifiedClauseIds = current.snapshot.clauses
      .filter((x) => x.source === 'template')
      .filter((x) => {
        const o = original.get(x.id);
        return (
          !o ||
          o.titleEn !== x.titleEn ||
          o.titleAr !== x.titleAr ||
          o.bodyEn !== x.bodyEn ||
          o.bodyAr !== x.bodyAr
        );
      })
      .map((x) => x.id);

    let approvedDocument: ContractDto['approvedDocument'] = null;
    const approvedReq = requests.find((r) => r.id === c.row.approvedRequestId);
    if (approvedReq) {
      const [raw] = await this.db
        .select({ data: storedFiles.data, sizeBytes: storedFiles.sizeBytes })
        .from(storedFiles)
        .innerJoin(approvalRequests, eq(approvalRequests.documentFileId, storedFiles.id))
        .where(eq(approvalRequests.id, approvedReq.id));
      if (raw) {
        approvedDocument = {
          version: approvedReq.version,
          sha256: approvedReq.documentSha256!,
          sizeBytes: raw.sizeBytes,
          verified: sha256Hex(raw.data) === approvedReq.documentSha256,
        };
      }
    }

    const editable =
      EDITABLE_STATUSES.includes(c.row.status as ContractStatus) && this.canEdit(ctx, c);
    const pending = requests.find((r) => r.status === 'pending');
    return {
      ...summary,
      snapshot: current.snapshot,
      missing: completenessIssues(current.snapshot, this.mergeContext(settings, c.row.number)),
      versions: history.map((v) => ({
        version: v.version,
        sha256: v.sha256,
        verified: this.versions.verify(v),
        note: v.note,
        createdBy: v.createdBy,
        createdAt: v.createdAt.toISOString(),
      })),
      requests,
      modifiedClauseIds,
      approvedDocument,
      can: {
        edit: editable,
        submit: editable,
        withdraw: !!pending && (this.canEdit(ctx, c) || pending.requestedBy.id === ctx.user.id),
        cancel: editable,
        decide:
          !!pending && this.canDecide(ctx, c.team, { requestedByUserId: pending.requestedBy.id }),
        export: coversRecord(ctx.access, 'contracts.export', c.team),
      },
    };
  }

  async version(ctx: TenantContext, id: string, version: number) {
    await this.loadVisible(ctx, id);
    const v = await this.versions.get<ContractSnapshot>(
      ctx.organizationId,
      CONTRACT_ENTITY,
      id,
      version,
    );
    if (!v) throw Errors.notFound('Version');
    return {
      version: v.version,
      sha256: v.sha256,
      verified: this.versions.verify(v),
      note: v.note,
      createdBy: v.createdBy,
      createdAt: v.createdAt.toISOString(),
      snapshot: v.snapshot,
    };
  }

  private async requests(
    organizationId: string,
    contractId: string,
    number: string,
    title: string,
  ): Promise<ApprovalRequestDto[]> {
    const requester = alias(users, 'requester');
    const decider = alias(users, 'decider');
    const rows = await this.db
      .select({
        r: approvalRequests,
        requesterName: requester.displayName,
        deciderName: decider.displayName,
      })
      .from(approvalRequests)
      .innerJoin(requester, eq(requester.id, approvalRequests.requestedByUserId))
      .leftJoin(decider, eq(decider.id, approvalRequests.decidedByUserId))
      .where(
        and(
          eq(approvalRequests.organizationId, organizationId),
          eq(approvalRequests.contractId, contractId),
        ),
      )
      .orderBy(asc(approvalRequests.requestedAt));
    return rows.map(({ r, requesterName, deciderName }) => ({
      id: r.id,
      contractId,
      contractNumber: number,
      contractTitle: title,
      version: r.version,
      status: r.status as ApprovalRequestDto['status'],
      note: r.note,
      requestedBy: { id: r.requestedByUserId, displayName: requesterName },
      requestedAt: r.requestedAt.toISOString(),
      decidedBy: r.decidedByUserId
        ? { id: r.decidedByUserId, displayName: deciderName ?? '' }
        : null,
      decidedAt: r.decidedAt?.toISOString() ?? null,
      comment: r.comment,
      selfApproved: r.selfApproved,
      documentSha256: r.documentSha256,
    }));
  }
}

function recipientName(d: ContractDetailsInput): string | null {
  return d.recipient.fullNameEn || d.recipient.fullNameAr || null;
}

/** Applies a client's clause list to the stored one, keeping each clause's origin and rules. */
export function mergeClauses(
  previous: ContractClause[],
  incoming: Pick<ContractClause, 'id' | 'included' | 'titleEn' | 'titleAr' | 'bodyEn' | 'bodyAr'>[],
): ContractClause[] {
  const prev = new Map(previous.map((c) => [c.id, c]));
  const seen = new Set<string>();
  const out = incoming.map((c): ContractClause => {
    const p = prev.get(c.id);
    seen.add(c.id);
    const base = {
      id: c.id,
      included: c.included,
      titleEn: c.titleEn,
      titleAr: c.titleAr,
      bodyEn: c.bodyEn,
      bodyAr: c.bodyAr,
    };
    if (!p) return { ...base, templateClauseId: null, source: 'custom', required: false };
    return {
      ...base,
      templateClauseId: p.templateClauseId,
      source: p.source,
      required: p.required,
    };
  });
  for (const c of out) {
    if (c.required && !c.included)
      throw new AppError(
        'required_clause',
        400,
        `"${c.titleEn || c.titleAr}" is required by the template`,
      );
  }
  for (const p of previous) {
    if (p.required && !seen.has(p.id))
      throw new AppError(
        'required_clause',
        400,
        `"${p.titleEn || p.titleAr}" is required by the template and cannot be removed`,
      );
  }
  return out;
}

/** Which parts of the snapshot changed (for the audit log). */
function changedParts(a: ContractSnapshot, b: ContractSnapshot): string[] {
  const parts: string[] = [];
  if (a.teamId !== b.teamId) parts.push('team');
  if (a.rosterMemberId !== b.rosterMemberId) parts.push('rosterMember');
  for (const k of Object.keys({ ...a.details, ...b.details }) as (keyof ContractDetailsInput)[]) {
    if (canonicalJson(a.details[k]) !== canonicalJson(b.details[k])) parts.push(`details.${k}`);
  }
  const ac = new Map(a.clauses.map((c) => [c.id, canonicalJson(c)]));
  const bc = new Map(b.clauses.map((c) => [c.id, canonicalJson(c)]));
  const added = [...bc.keys()].filter((k) => !ac.has(k)).length;
  const removed = [...ac.keys()].filter((k) => !bc.has(k)).length;
  const edited = [...bc.keys()].filter((k) => ac.has(k) && ac.get(k) !== bc.get(k)).length;
  const reordered =
    a.clauses
      .filter((c) => bc.has(c.id))
      .map((c) => c.id)
      .join() !==
    b.clauses
      .filter((c) => ac.has(c.id))
      .map((c) => c.id)
      .join();
  if (added) parts.push(`clauses.added:${added}`);
  if (removed) parts.push(`clauses.removed:${removed}`);
  if (edited) parts.push(`clauses.edited:${edited}`);
  if (reordered) parts.push('clauses.reordered');
  return parts;
}

function sampleApproval(ctx: TenantContext): ApprovalInfo {
  return {
    approverName: ctx.user.displayName,
    approvedAt: new Date(),
    version: 1,
    sha256: '0'.repeat(64),
  };
}
