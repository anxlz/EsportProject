import { Inject, Injectable } from '@nestjs/common';
import {
  type ContractTerminationDto,
  type ContractTerminationEventDto,
  type ContractTerminationRequestInput,
  type ContractTerminationViewDto,
  type ContractSnapshot,
  type TerminationStatus,
  type TerminationReasonCode,
} from '@esports/shared';
import { and, desc, eq, inArray, lte, lt, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { TenantContext } from '../authz/context';
import { AccessService } from '../authz/access.service';
import { AuditService } from '../audit/audit.service';
import { AppError, Errors } from '../common/errors';
import { DB, type Database, type DbOrTx } from '../db/client';
import { organizations, users } from '../db/schema';
import {
  contractTerminationEvents,
  contractTerminations,
  contractSigners,
  contracts,
  entityVersions,
  signingLinks,
  signingRounds,
} from '../db/schema-contracts';
import { coversRecord } from '../finance/scope';
import { CLOCK, type Clock } from '../finance/clock';
import { MailService } from '../mail/mail.service';
import { NotificationService } from '../notifications/notification.service';
import { PdfService, escapeHtml, pdfFonts } from '../pdf/pdf.service';
import { ContractsService, CONTRACT_ENTITY } from './contracts.service';

const ACTIVE_TERMINATIONS: TerminationStatus[] = ['requested', 'pending_counterparty', 'accepted'];
const TERMINABLE_CONTRACT_STATUSES = ['approved', 'awaiting_signatures', 'signed'] as const;
const HISTORY_LIMIT = 100;
const REQUEST_EXPIRY_DAYS = 30;

type TerminationRow = typeof contractTerminations.$inferSelect;
type EventAction = 'requested' | 'accepted' | 'rejected' | 'withdrawn' | 'executed' | 'expired';

export function addUtcDays(date: string, days: number): string {
  const result = new Date(`${date}T00:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

const reasonLabels: Record<TerminationReasonCode, { en: string; ar: string }> = {
  breach: { en: 'Breach', ar: 'إخلال' },
  mutual_agreement: { en: 'Mutual agreement', ar: 'اتفاق متبادل' },
  non_performance: { en: 'Non-performance', ar: 'عدم التنفيذ' },
  force_majeure: { en: 'Force majeure', ar: 'قوة قاهرة' },
  convenience: { en: 'Convenience', ar: 'للمصلحة' },
  other: { en: 'Other', ar: 'أخرى' },
};

@Injectable()
export class ContractTerminationsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly contracts: ContractsService,
    private readonly mail: MailService,
    private readonly notifications: NotificationService,
    private readonly pdf: PdfService,
  ) {}

  private role(ctx: TenantContext): string {
    if (ctx.access.isOwner) return 'owner';
    return ctx.access.has('contracts.approve') ? 'approver' : 'editor';
  }

  private mayRespond(ctx: TenantContext, team: Parameters<typeof coversRecord>[2]) {
    return coversRecord(ctx.access, 'contracts.approve', team);
  }

  private async latest(db: DbOrTx, organizationId: string, contractId: string) {
    const [row] = await db
      .select()
      .from(contractTerminations)
      .where(
        and(
          eq(contractTerminations.organizationId, organizationId),
          eq(contractTerminations.contractId, contractId),
        ),
      )
      .orderBy(desc(contractTerminations.createdAt))
      .limit(1);
    return row ?? null;
  }

  private async event(
    tx: DbOrTx,
    p: {
      organizationId: string;
      terminationId: string;
      actorUserId: string | null;
      actorRole: string;
      action: EventAction;
      fromStatus: TerminationStatus | null;
      toStatus: TerminationStatus;
      note?: string | null;
    },
  ) {
    await tx.insert(contractTerminationEvents).values({
      organizationId: p.organizationId,
      terminationId: p.terminationId,
      actorUserId: p.actorUserId,
      actorRole: p.actorRole,
      action: p.action,
      fromStatus: p.fromStatus,
      toStatus: p.toStatus,
      note: p.note ?? null,
    });
  }

  private async dto(row: TerminationRow, db: DbOrTx): Promise<ContractTerminationDto> {
    const [initiator] = await db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, row.initiatedByUserId));
    return {
      id: row.id,
      contractId: row.contractId,
      initiatedBy: { id: row.initiatedByUserId, displayName: initiator?.displayName ?? '' },
      initiatorRole: row.initiatorRole,
      reasonCode: row.reasonCode,
      reasonDetails: row.reasonDetails,
      effectiveDate: row.effectiveDate,
      noticePeriodDays: row.noticePeriodDays,
      status: row.status,
      counterpartyResponseAt: row.counterpartyResponseAt?.toISOString() ?? null,
      counterpartyNote: row.counterpartyNote,
      settlementNotes: row.settlementNotes,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async view(ctx: TenantContext, contractId: string): Promise<ContractTerminationViewDto> {
    const contract = await this.contracts.loadVisible(ctx, contractId);
    const row = await this.latest(this.db, ctx.organizationId, contractId);
    const actor = alias(users, 'termination_actor');
    const rows = row
      ? await this.db
          .select({ event: contractTerminationEvents, displayName: actor.displayName })
          .from(contractTerminationEvents)
          .leftJoin(actor, eq(actor.id, contractTerminationEvents.actorUserId))
          .where(
            and(
              eq(contractTerminationEvents.organizationId, ctx.organizationId),
              eq(contractTerminationEvents.terminationId, row.id),
            ),
          )
          .orderBy(desc(contractTerminationEvents.createdAt), desc(contractTerminationEvents.id))
          .limit(HISTORY_LIMIT)
      : [];
    const canEdit = this.contracts.canEdit(ctx, contract);
    const canRespond = this.mayRespond(ctx, contract.team);
    const pending = row?.status === 'requested' || row?.status === 'pending_counterparty';
    const active = row !== null && ACTIVE_TERMINATIONS.includes(row.status);
    const events: ContractTerminationEventDto[] = [...rows]
      .reverse()
      .map(({ event, displayName }) => ({
        id: event.id,
        action: event.action as EventAction,
        fromStatus: event.fromStatus ?? null,
        toStatus: event.toStatus,
        actor: event.actorUserId ? { id: event.actorUserId, displayName: displayName ?? '' } : null,
        actorRole: event.actorRole,
        note: event.note,
        createdAt: event.createdAt.toISOString(),
      }));
    return {
      current: row ? await this.dto(row, this.db) : null,
      events,
      can: {
        request:
          canEdit &&
          !active &&
          TERMINABLE_CONTRACT_STATUSES.includes(
            contract.row.status as (typeof TERMINABLE_CONTRACT_STATUSES)[number],
          ),
        respond:
          !!row &&
          pending &&
          canRespond &&
          (row.initiatedByUserId !== ctx.user.id || ctx.access.isOwner),
        withdraw: !!row && pending && row.initiatedByUserId === ctx.user.id,
        execute:
          !!row && row.status === 'accepted' && canEdit && row.effectiveDate <= this.clock.today(),
      },
    };
  }

  async request(
    ctx: TenantContext,
    contractId: string,
    input: ContractTerminationRequestInput,
  ): Promise<ContractTerminationViewDto> {
    const contract = await this.contracts.loadVisible(ctx, contractId);
    if (
      !this.contracts.canEdit(ctx, contract) ||
      !TERMINABLE_CONTRACT_STATUSES.includes(
        contract.row.status as (typeof TERMINABLE_CONTRACT_STATUSES)[number],
      )
    )
      throw Errors.conflict('contract_termination_not_allowed');
    const today = this.clock.today();
    if (input.effectiveDate < addUtcDays(today, input.noticePeriodDays))
      throw Errors.validation([{ path: 'effectiveDate', message: 'notice_period_not_met' }]);
    const holders = await this.access.usersWithPermission(
      ctx.organizationId,
      'contracts.approve',
      contract.team ?? 'organization',
    );
    const recipients = holders.filter((id) => id !== ctx.user.id);
    await this.db.transaction(async (tx) => {
      const currentContract = await this.contracts.loadVisible(ctx, contractId, tx, true);
      if (!this.contracts.canEdit(ctx, currentContract)) throw Errors.forbidden();
      const previous = await this.latest(tx, ctx.organizationId, contractId);
      if (previous && ACTIVE_TERMINATIONS.includes(previous.status))
        throw Errors.conflict('contract_termination_not_allowed');
      if (
        !TERMINABLE_CONTRACT_STATUSES.includes(
          currentContract.row.status as (typeof TERMINABLE_CONTRACT_STATUSES)[number],
        )
      )
        throw Errors.conflict('contract_termination_not_allowed');
      const [created] = await tx
        .insert(contractTerminations)
        .values({
          organizationId: ctx.organizationId,
          contractId,
          initiatedByUserId: ctx.user.id,
          initiatorRole: this.role(ctx),
          reasonCode: input.reasonCode,
          reasonDetails: input.reasonDetails ?? null,
          effectiveDate: input.effectiveDate,
          noticePeriodDays: input.noticePeriodDays,
          status: 'requested',
        })
        .returning();
      if (!created) throw new AppError('internal_error', 500, 'Termination request was not stored');
      await this.event(tx, {
        organizationId: ctx.organizationId,
        terminationId: created.id,
        actorUserId: ctx.user.id,
        actorRole: this.role(ctx),
        action: 'requested',
        fromStatus: null,
        toStatus: 'requested',
        note: input.reasonDetails ?? null,
      });
      await this.audit.fromCtx(
        ctx,
        'contract.termination_requested',
        { type: 'contract_termination', id: created.id },
        { contractId, reasonCode: input.reasonCode, effectiveDate: input.effectiveDate },
        tx,
      );
      await this.notifications.notify(
        {
          organizationId: ctx.organizationId,
          recipientUserIds: recipients,
          type: 'contract.termination_requested',
          data: { contractNumber: contract.row.number, terminationId: created.id },
          link: `/dashboard/contracts/${contractId}`,
        },
        tx,
      );
    });
    await this.sendInternalEmails(
      recipients,
      contract.row.number,
      'requested',
      input.reasonDetails,
    );
    return this.view(ctx, contractId);
  }

  async respond(
    ctx: TenantContext,
    contractId: string,
    decision: 'accepted' | 'rejected',
    note: string | null,
  ): Promise<ContractTerminationViewDto> {
    const contract = await this.contracts.loadVisible(ctx, contractId);
    if (!this.mayRespond(ctx, contract.team)) throw Errors.forbidden();
    const [termination] = await this.db
      .select()
      .from(contractTerminations)
      .where(
        and(
          eq(contractTerminations.organizationId, ctx.organizationId),
          eq(contractTerminations.contractId, contractId),
        ),
      )
      .orderBy(desc(contractTerminations.createdAt))
      .limit(1);
    if (!termination || !['requested', 'pending_counterparty'].includes(termination.status))
      throw Errors.conflict('contract_termination_not_allowed');
    if (termination.initiatedByUserId === ctx.user.id && !ctx.access.isOwner)
      throw Errors.forbidden();
    await this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(contractTerminations)
        .where(
          and(
            eq(contractTerminations.id, termination.id),
            eq(contractTerminations.organizationId, ctx.organizationId),
          ),
        )
        .for('update');
      if (!locked || !['requested', 'pending_counterparty'].includes(locked.status))
        throw Errors.conflict('contract_termination_not_allowed');
      const next: TerminationStatus = decision;
      await tx
        .update(contractTerminations)
        .set({
          status: next,
          counterpartyResponseAt: new Date(),
          counterpartyNote: note,
          updatedAt: new Date(),
        })
        .where(eq(contractTerminations.id, locked.id));
      await this.event(tx, {
        organizationId: ctx.organizationId,
        terminationId: locked.id,
        actorUserId: ctx.user.id,
        actorRole: this.role(ctx),
        action: decision,
        fromStatus: locked.status,
        toStatus: next,
        note,
      });
      await this.audit.fromCtx(
        ctx,
        `contract.termination_${decision}`,
        { type: 'contract_termination', id: locked.id },
        { contractId, note },
        tx,
      );
      await this.notifications.notify(
        {
          organizationId: ctx.organizationId,
          recipientUserIds: [locked.initiatedByUserId],
          type: 'contract.termination_updated',
          data: { contractNumber: contract.row.number, status: next },
          link: `/dashboard/contracts/${contractId}`,
        },
        tx,
      );
    });
    await this.sendUserEmail(termination.initiatedByUserId, contract.row.number, decision, note);
    return this.view(ctx, contractId);
  }

  async withdraw(ctx: TenantContext, contractId: string): Promise<ContractTerminationViewDto> {
    const contract = await this.contracts.loadVisible(ctx, contractId);
    const termination = await this.latest(this.db, ctx.organizationId, contractId);
    if (
      !termination ||
      termination.initiatedByUserId !== ctx.user.id ||
      !['requested', 'pending_counterparty'].includes(termination.status)
    )
      throw Errors.conflict('contract_termination_not_allowed');
    const approvers = await this.access.usersWithPermission(
      ctx.organizationId,
      'contracts.approve',
      contract.team ?? 'organization',
    );
    await this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(contractTerminations)
        .where(eq(contractTerminations.id, termination.id))
        .for('update');
      if (!locked || !['requested', 'pending_counterparty'].includes(locked.status))
        throw Errors.conflict('contract_termination_not_allowed');
      await tx
        .update(contractTerminations)
        .set({ status: 'withdrawn', updatedAt: new Date() })
        .where(eq(contractTerminations.id, locked.id));
      await this.event(tx, {
        organizationId: ctx.organizationId,
        terminationId: locked.id,
        actorUserId: ctx.user.id,
        actorRole: this.role(ctx),
        action: 'withdrawn',
        fromStatus: locked.status,
        toStatus: 'withdrawn',
      });
      await this.audit.fromCtx(
        ctx,
        'contract.termination_withdrawn',
        { type: 'contract_termination', id: locked.id },
        { contractId },
        tx,
      );
      await this.notifications.notify(
        {
          organizationId: ctx.organizationId,
          recipientUserIds: approvers.filter((id) => id !== ctx.user.id),
          type: 'contract.termination_updated',
          data: { contractNumber: contract.row.number, status: 'withdrawn' },
          link: `/dashboard/contracts/${contractId}`,
        },
        tx,
      );
    });
    await this.sendInternalEmails(
      approvers.filter((id) => id !== ctx.user.id),
      contract.row.number,
      'withdrawn',
    );
    return this.view(ctx, contractId);
  }

  async execute(ctx: TenantContext, contractId: string, settlementNotes: string | null) {
    const contract = await this.contracts.loadVisible(ctx, contractId);
    if (!this.contracts.canEdit(ctx, contract)) throw Errors.forbidden();
    const termination = await this.latest(this.db, ctx.organizationId, contractId);
    if (
      !termination ||
      termination.status !== 'accepted' ||
      termination.effectiveDate > this.clock.today()
    )
      throw Errors.conflict('contract_termination_not_allowed');
    const executed = await this.db.transaction((tx) =>
      this.executeInTransaction(tx, termination, ctx.user.id, this.role(ctx), settlementNotes),
    );
    if (!executed) throw Errors.conflict('contract_termination_not_allowed');
    await this.sendUserEmail(
      termination.initiatedByUserId,
      contract.row.number,
      'executed',
      settlementNotes,
    );
    await this.sendExternalNotice(
      ctx.organizationId,
      contractId,
      contract.row.number,
      termination.effectiveDate,
    );
    return this.view(ctx, contractId);
  }

  private async executeInTransaction(
    tx: DbOrTx,
    termination: TerminationRow,
    actorUserId: string | null,
    actorRole: string,
    settlementNotes: string | null,
  ) {
    const [locked] = await tx
      .select()
      .from(contractTerminations)
      .where(eq(contractTerminations.id, termination.id))
      .for('update');
    if (!locked || locked.status !== 'accepted' || locked.effectiveDate > this.clock.today())
      return false;
    const [contract] = await tx
      .select()
      .from(contracts)
      .where(
        and(
          eq(contracts.id, locked.contractId),
          eq(contracts.organizationId, locked.organizationId),
        ),
      )
      .for('update');
    if (!contract || !TERMINABLE_CONTRACT_STATUSES.some((status) => status === contract.status))
      return false;
    const now = new Date();
    await tx
      .update(contractTerminations)
      .set({ status: 'executed', settlementNotes, updatedAt: now })
      .where(eq(contractTerminations.id, locked.id));
    await tx
      .update(contracts)
      .set({ status: 'terminated', updatedAt: now })
      .where(eq(contracts.id, contract.id));
    const openRounds = await tx
      .select({ id: signingRounds.id })
      .from(signingRounds)
      .where(
        and(
          eq(signingRounds.organizationId, contract.organizationId),
          eq(signingRounds.contractId, contract.id),
          eq(signingRounds.status, 'in_progress'),
        ),
      );
    for (const round of openRounds) {
      const signers = await tx
        .select({ id: contractSigners.id })
        .from(contractSigners)
        .where(eq(contractSigners.roundId, round.id));
      if (signers.length) {
        await tx
          .update(signingLinks)
          .set({ revokedAt: now, revokeReason: 'Contract terminated' })
          .where(
            and(
              eq(signingLinks.organizationId, contract.organizationId),
              inArray(
                signingLinks.signerId,
                signers.map((signer) => signer.id),
              ),
              sql`${signingLinks.revokedAt} is null`,
            ),
          );
      }
      await tx
        .update(signingRounds)
        .set({
          status: 'cancelled',
          cancelledAt: now,
          cancelledByUserId: actorUserId,
          cancelReason: 'Contract terminated',
        })
        .where(eq(signingRounds.id, round.id));
    }
    await this.event(tx, {
      organizationId: locked.organizationId,
      terminationId: locked.id,
      actorUserId,
      actorRole,
      action: 'executed',
      fromStatus: 'accepted',
      toStatus: 'executed',
      note: settlementNotes,
    });
    await this.audit.log(
      {
        organizationId: locked.organizationId,
        actorUserId,
        actorType: actorUserId ? 'user' : 'system',
        action: 'contract.terminated',
        targetType: 'contract',
        targetId: contract.id,
        metadata: { terminationId: locked.id },
      },
      tx,
    );
    await this.notifications.notify(
      {
        organizationId: locked.organizationId,
        recipientUserIds: [locked.initiatedByUserId],
        type: 'contract.terminated',
        data: { contractNumber: contract.number },
        link: `/dashboard/contracts/${contract.id}`,
      },
      tx,
    );
    return true;
  }

  async tick(): Promise<void> {
    const today = this.clock.today();
    const expireBefore = new Date(`${addUtcDays(today, -REQUEST_EXPIRY_DAYS)}T00:00:00.000Z`);
    const due = await this.db
      .select()
      .from(contractTerminations)
      .where(
        and(
          eq(contractTerminations.status, 'accepted'),
          lte(contractTerminations.effectiveDate, today),
        ),
      );
    for (const row of due) {
      const executed = await this.db.transaction((tx) =>
        this.executeInTransaction(tx, row, null, 'system', null),
      );
      if (executed) {
        const [contract] = await this.db
          .select({ number: contracts.number })
          .from(contracts)
          .where(
            and(eq(contracts.organizationId, row.organizationId), eq(contracts.id, row.contractId)),
          );
        if (contract)
          await this.sendUserEmail(row.initiatedByUserId, contract.number, 'executed', null);
        await this.sendExternalNotice(
          row.organizationId,
          row.contractId,
          undefined,
          row.effectiveDate,
        );
      }
    }
    const expired = await this.db
      .select()
      .from(contractTerminations)
      .where(
        and(
          inArray(contractTerminations.status, ['requested', 'pending_counterparty']),
          lt(contractTerminations.createdAt, expireBefore),
        ),
      );
    for (const row of expired) {
      const contractNumber = await this.db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(contractTerminations)
          .where(eq(contractTerminations.id, row.id))
          .for('update');
        if (!locked || !['requested', 'pending_counterparty'].includes(locked.status)) return null;
        await tx
          .update(contractTerminations)
          .set({ status: 'expired', updatedAt: new Date() })
          .where(eq(contractTerminations.id, locked.id));
        await this.event(tx, {
          organizationId: locked.organizationId,
          terminationId: locked.id,
          actorUserId: null,
          actorRole: 'system',
          action: 'expired',
          fromStatus: locked.status,
          toStatus: 'expired',
        });
        await this.audit.log(
          {
            organizationId: locked.organizationId,
            actorUserId: null,
            actorType: 'system',
            action: 'contract.termination_expired',
            targetType: 'contract_termination',
            targetId: locked.id,
          },
          tx,
        );
        const [contract] = await tx
          .select({ number: contracts.number })
          .from(contracts)
          .where(
            and(
              eq(contracts.organizationId, locked.organizationId),
              eq(contracts.id, locked.contractId),
            ),
          );
        await this.notifications.notify(
          {
            organizationId: locked.organizationId,
            recipientUserIds: [locked.initiatedByUserId],
            type: 'contract.termination_updated',
            data: { contractNumber: contract?.number ?? '', status: 'expired' },
            link: `/dashboard/contracts/${locked.contractId}`,
          },
          tx,
        );
        return contract?.number ?? null;
      });
      if (contractNumber)
        await this.sendUserEmail(row.initiatedByUserId, contractNumber, 'expired', null);
    }
  }

  async noticePdf(
    ctx: TenantContext,
    contractId: string,
  ): Promise<{ pdf: Buffer; filename: string }> {
    const contract = await this.contracts.loadVisible(ctx, contractId);
    if (!coversRecord(ctx.access, 'contracts.export', contract.team)) throw Errors.forbidden();
    const view = await this.view(ctx, contractId);
    if (!view.current || view.current.status !== 'executed')
      throw Errors.notFound('Termination notice');
    const doc = await this.contracts.get(ctx, contractId);
    const reason = reasonLabels[view.current.reasonCode];
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>${pdfFonts()}body{font-family:Plex,sans-serif;color:#14213d}h1{text-align:center}p,td{font-size:12pt}.meta{margin:28px 0}.note{white-space:pre-wrap;border-top:1px solid #ccc;padding-top:16px}.rtl{direction:rtl;text-align:right}table{width:100%;border-collapse:collapse}td{padding:10px;border-bottom:1px solid #ddd}</style></head><body><h1>Contract termination notice</h1><h1 class="rtl">إشعار إنهاء العقد</h1><table><tr><td>Contract / العقد</td><td>${escapeHtml(doc.number)}</td></tr><tr><td>Recipient / الطرف الثاني</td><td>${escapeHtml(doc.recipientName ?? '')}</td></tr><tr><td>Reason / السبب</td><td>${escapeHtml(reason.en)} / ${escapeHtml(reason.ar)}</td></tr><tr><td>Effective date / تاريخ السريان</td><td>${escapeHtml(view.current.effectiveDate)}</td></tr><tr><td>Notice period / مدة الإشعار</td><td>${view.current.noticePeriodDays}</td></tr><tr><td>Status / الحالة</td><td>Executed / تم التنفيذ</td></tr></table>${view.current.reasonDetails ? `<p class="note">${escapeHtml(view.current.reasonDetails)}</p>` : ''}${view.current.settlementNotes ? `<p class="note">${escapeHtml(view.current.settlementNotes)}</p>` : ''}<p>This is a supplemental notice. The approved and signed contract document is retained unchanged.</p><p class="rtl">هذا إشعار تكميلي. يتم الاحتفاظ بمستند العقد المعتمد والموقّع دون تغيير.</p></body></html>`;
    const pdf = await this.pdf.render(html, {
      margin: { top: '18mm', bottom: '18mm', left: '18mm', right: '18mm' },
    });
    return { pdf, filename: `${contract.row.number}-termination-notice.pdf` };
  }

  private async sendInternalEmails(
    userIds: string[],
    contractNumber: string,
    status: string,
    note?: string | null,
  ) {
    const recipients = [...new Set(userIds)];
    if (!recipients.length) return;
    const emails = await this.db
      .select({ email: users.email })
      .from(users)
      .where(inArray(users.id, recipients));
    if (emails.length)
      await this.mail.sendContractTermination(emails.map((row) => row.email).join(', '), {
        contractNumber,
        status,
        note: note ?? null,
      });
  }

  private async sendUserEmail(
    userId: string,
    contractNumber: string,
    status: string,
    note: string | null,
  ) {
    const [user] = await this.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId));
    if (user) await this.mail.sendContractTermination(user.email, { contractNumber, status, note });
  }

  private async sendExternalNotice(
    organizationId: string,
    contractId: string,
    contractNumber?: string,
    effectiveDate?: string,
  ) {
    const [contract] = await this.db
      .select()
      .from(contracts)
      .where(and(eq(contracts.organizationId, organizationId), eq(contracts.id, contractId)));
    if (!contract) return;
    const [version] = await this.db
      .select({ snapshot: entityVersions.snapshot })
      .from(entityVersions)
      .where(
        and(
          eq(entityVersions.organizationId, organizationId),
          eq(entityVersions.entityType, CONTRACT_ENTITY),
          eq(entityVersions.entityId, contractId),
          eq(entityVersions.version, contract.currentVersion),
        ),
      );
    const snapshot = version?.snapshot as ContractSnapshot | undefined;
    const email = snapshot?.details.recipient.email;
    if (!email) return;
    const [org] = await this.db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    await this.mail.sendContractTermination(email, {
      contractNumber: contractNumber ?? contract.number,
      status: 'executed',
      note: `The termination takes effect ${effectiveDate ?? this.clock.today()}. Please contact ${org?.name ?? 'the organization'} with any questions.`,
    });
  }
}
