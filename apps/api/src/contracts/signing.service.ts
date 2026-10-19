/**
 * Electronic signatures (spec §7.7, Phase 4).
 *
 * Flow: an approved contract → "start signing" fixes the required signers from the approved
 * version (the recipient; a parent or guardian too when the recipient is under 18 that day) →
 * the manager creates a link per signer → the signer opens it, proves who they are with a
 * 6-digit code (emailed to the address in the contract, or handed over by the manager through
 * another channel), reviews the approved document and signs (typed in blue, or drawn) → when
 * every required signature is in, the signed PDF (approved PDF + signature record) is stored
 * with its SHA-256 and the contract becomes `signed`.
 *
 * Safeguards:
 * - link tokens are 256-bit random values stored only as SHA-256; links expire (7 days by
 *   default), can be revoked, and are replaced when a new one is created for the same signer;
 * - nothing about the contract is shown before the code check; 5 wrong codes lock the link;
 * - codes are stored as keyed hashes (HMAC with SESSION_SECRET);
 * - signing order is enforced (the guardian signs after the recipient); a signature is
 *   recorded with a conditional update, so a link can't sign twice and two signers can't race;
 * - each signature stores the verbatim consent statement, method, time, IP, browser, the
 *   approved document's SHA-256 and a SHA-256 over the whole record; the database refuses any
 *   change to a recorded signature (migration 0007);
 * - the approved PDF is kept unchanged; the signed PDF is a separate stored file.
 *
 * Authorization (manager side): `contracts.send_for_signature` covering the contract's team to
 * start, create/revoke links and cancel; seeing the signing status needs the contract to be
 * visible; downloading the signed PDF needs `contracts.export`.
 */
import { randomInt, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CONSENT_VERSION,
  consentText,
  type ContractLocale,
  type ContractSigningDto,
  type ContractSnapshot,
  type CreateSigningLinkInput,
  EMAIL_CODE_MINUTES,
  maskEmail,
  type PublicSigningInfo,
  type PublicSigningSession,
  type PublicSigningState,
  type PublicSigningVerified,
  requiredSigners,
  type SignatureFontKey,
  type SignatureMethod,
  type SignerDto,
  type SignerRole,
  type SignerStatus,
  type SigningLinkCreatedDto,
  type SigningLinkState,
  type SigningRoundDto,
  type SigningRoundStatus,
  type SignInput,
  SIGNING_SESSION_MINUTES,
  type VerificationMethod,
  VERIFY_MAX_ATTEMPTS,
} from '@esports/shared';
import { and, asc, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import type { ClientMeta, TenantContext } from '../authz/context';
import { AuditService } from '../audit/audit.service';
import { hmacSha256, randomToken, safeEqual, sha256 } from '../common/crypto';
import { AppError, Errors } from '../common/errors';
import { type Env, ENV } from '../config/env';
import { REDIS } from '../core/core.module';
import { DB, type Database, type DbOrTx } from '../db/client';
import { users } from '../db/schema';
import {
  approvalRequests,
  contracts,
  contractSigners,
  signingLinks,
  signingRounds,
} from '../db/schema-contracts';
import { FilesService } from '../files/files.service';
import { CLOCK, type Clock } from '../finance/clock';
import { coversRecord } from '../finance/scope';
import { MailService } from '../mail/mail.service';
import { NotificationService } from '../notifications/notification.service';
import { PdfService } from '../pdf/pdf.service';
import { canonicalJson, sha256Hex, VersioningService } from '../versioning/versioning.service';
import { CONTRACT_ENTITY, ContractsService, type LoadedContract } from './contracts.service';
import { DocumentSettingsService } from './document-settings.service';
import { renderGuard } from './http';
import { certificateFooter, certificateHtml, type CertificateSigner } from './signing-document';

const PERM = 'contracts.send_for_signature';
const SIGNED_DOCUMENT_KIND = 'contract_signed';
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const CODE_RESEND_SECONDS = 60;
const MAX_EMAIL_CODES = 5;
const SESSION_PREFIX = 'signing:session:';

type RoundRow = typeof signingRounds.$inferSelect;
type SignerRow = typeof contractSigners.$inferSelect;
type LinkRow = typeof signingLinks.$inferSelect;

interface Resolved {
  link: LinkRow;
  signer: SignerRow;
  round: RoundRow;
  contract: { id: string; number: string; title: string; status: string };
}

interface SessionData {
  linkId: string;
  verifiedAt: string;
}

const sixDigits = () => randomInt(0, 1_000_000).toString().padStart(6, '0');

export function linkState(l: LinkRow | undefined, now: Date): SigningLinkState {
  if (!l) return 'none';
  if (l.usedAt) return 'used';
  if (l.revokedAt) return 'revoked';
  if (l.lockedAt) return 'locked';
  if (l.expiresAt <= now) return 'expired';
  return 'active';
}

/** The document's own title rule: the given title, else the contract type's name. */
const contractTitle = (s: ContractSnapshot) => ({
  en: s.details.title || s.typeNameEn,
  ar: s.details.title || s.typeNameAr,
});

const signerName = (s: Pick<SignerRow, 'nameEn' | 'nameAr'>, locale: ContractLocale) =>
  (locale === 'ar' ? s.nameAr || s.nameEn : s.nameEn || s.nameAr) ?? '';

@Injectable()
export class SigningService {
  private readonly logger = new Logger('Signing');

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly env: Env,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly files: FilesService,
    private readonly pdf: PdfService,
    private readonly mail: MailService,
    private readonly versions: VersioningService,
    private readonly contracts: ContractsService,
    private readonly settings: DocumentSettingsService,
  ) {}

  // ================================================================ manager side

  private canManage(ctx: TenantContext, c: LoadedContract) {
    return coversRecord(ctx.access, PERM, c.team);
  }

  private requireManage(ctx: TenantContext, c: LoadedContract) {
    if (!this.canManage(ctx, c)) throw Errors.forbidden();
  }

  private async openRound(db: DbOrTx, contractId: string, lock = false) {
    const q = db
      .select()
      .from(signingRounds)
      .where(
        and(eq(signingRounds.contractId, contractId), eq(signingRounds.status, 'in_progress')),
      );
    const [r] = lock ? await q.for('update') : await q;
    return r ?? null;
  }

  private async roundSigners(db: DbOrTx, roundId: string) {
    return db
      .select()
      .from(contractSigners)
      .where(eq(contractSigners.roundId, roundId))
      .orderBy(asc(contractSigners.signOrder));
  }

  /** The approved version's snapshot behind a round (what the signers sign). */
  private async approvedSnapshot(
    organizationId: string,
    contractId: string,
    approvalRequestId: string,
  ): Promise<ContractSnapshot> {
    const [req] = await this.db
      .select({ version: approvalRequests.version, versionId: approvalRequests.versionId })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalRequestId));
    const v = req
      ? await this.versions.get<ContractSnapshot>(
          organizationId,
          CONTRACT_ENTITY,
          contractId,
          req.version,
        )
      : null;
    if (!v || v.id !== req!.versionId) throw Errors.notFound('Approved version');
    return v.snapshot;
  }

  async start(ctx: TenantContext, id: string): Promise<ContractSigningDto> {
    const c = await this.contracts.loadVisible(ctx, id);
    this.requireManage(ctx, c);
    if (c.row.status === 'awaiting_signatures')
      throw Errors.conflict('signing_in_progress', 'Signing has already started');
    if (c.row.status !== 'approved' || !c.row.approvedRequestId)
      throw Errors.conflict(
        'contract_invalid_transition',
        'Only an approved contract can be signed',
      );
    const requestId = c.row.approvedRequestId;
    const approved = await this.contracts.approvedFile(ctx.organizationId, requestId, c.row.number);
    const snapshot = await this.approvedSnapshot(ctx.organizationId, id, requestId);
    const today = this.clock.today();
    const required = requiredSigners(snapshot, today);
    if ('error' in required) {
      throw Errors.badRequest(
        required.error,
        required.error === 'date_of_birth_required'
          ? "The recipient's date of birth is needed to know who must sign"
          : 'A parent or guardian (name, relationship and an email or phone) is needed: the recipient is under 18',
      );
    }

    const roundId = await this.db.transaction(async (tx) => {
      const again = await this.contracts.loadVisible(ctx, id, tx, true);
      if (again.row.status !== 'approved' || again.row.approvedRequestId !== requestId)
        throw Errors.conflict('contract_invalid_transition', 'The contract changed; reload');
      const [round] = await tx
        .insert(signingRounds)
        .values({
          organizationId: ctx.organizationId,
          contractId: id,
          approvalRequestId: requestId,
          minor: required.minor,
          minorOn: today,
          approvedDocumentSha256: approved.sha256,
          startedByUserId: ctx.user.id,
        })
        .returning();
      await tx.insert(contractSigners).values(
        required.signers.map((s) => ({
          organizationId: ctx.organizationId,
          roundId: round!.id,
          role: s.role,
          signOrder: s.order,
          nameEn: s.nameEn,
          nameAr: s.nameAr,
          email: s.email?.toLowerCase() ?? null,
          phone: s.phone,
          relationship: s.relationship,
        })),
      );
      await tx
        .update(contracts)
        .set({ status: 'awaiting_signatures', updatedByUserId: ctx.user.id, updatedAt: new Date() })
        .where(eq(contracts.id, id));
      await this.audit.fromCtx(
        ctx,
        'contract.signing_started',
        { type: 'contract', id },
        {
          number: c.row.number,
          roundId: round!.id,
          minor: required.minor,
          minorOn: today,
          signers: required.signers.map((s) => s.role),
          approvedDocumentSha256: approved.sha256,
        },
        tx,
      );
      return round!.id;
    });
    this.logger.log(`Signing started for ${c.row.number} (round ${roundId.slice(0, 8)})`);
    return this.state(ctx, id);
  }

  async createLink(
    ctx: TenantContext,
    id: string,
    signerId: string,
    input: CreateSigningLinkInput,
  ): Promise<SigningLinkCreatedDto> {
    const c = await this.contracts.loadVisible(ctx, id);
    this.requireManage(ctx, c);
    const token = randomToken();
    const linkId = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.expiresInDays * 86_400_000);

    const result = await this.db.transaction(async (tx) => {
      await this.contracts.loadVisible(ctx, id, tx, true);
      const round = await this.openRound(tx, id, true);
      if (!round) throw Errors.conflict('not_signing', 'This contract is not out for signature');
      const [signer] = await tx
        .select()
        .from(contractSigners)
        .where(and(eq(contractSigners.id, signerId), eq(contractSigners.roundId, round.id)));
      if (!signer) throw Errors.notFound('Signer');
      if (signer.status === 'signed') throw Errors.conflict('already_signed', 'Already signed');

      let destination: string | null = null;
      let accessCode: string | null = null;
      if (input.method === 'email_code') {
        destination = (input.email ?? signer.email)?.trim().toLowerCase() || null;
        if (!destination)
          throw Errors.badRequest('email_unavailable', 'No email address for this signer');
      } else {
        accessCode = sixDigits();
      }
      const replaced = await tx
        .update(signingLinks)
        .set({ revokedAt: now, revokedByUserId: ctx.user.id, revokeReason: 'replaced' })
        .where(
          and(
            eq(signingLinks.signerId, signer.id),
            isNull(signingLinks.revokedAt),
            isNull(signingLinks.usedAt),
          ),
        )
        .returning({ id: signingLinks.id });
      await tx.insert(signingLinks).values({
        id: linkId,
        organizationId: ctx.organizationId,
        signerId: signer.id,
        tokenHash: sha256(token),
        method: input.method,
        destination,
        createdByUserId: ctx.user.id,
        expiresAt,
        accessCodeHash: accessCode ? this.codeHash(linkId, accessCode) : null,
      });
      await this.audit.fromCtx(
        ctx,
        'contract.signing_link_created',
        { type: 'contract', id },
        {
          number: c.row.number,
          roundId: round.id,
          signerId: signer.id,
          role: signer.role,
          linkId,
          method: input.method,
          destination: destination ? maskEmail(destination) : null,
          expiresAt: expiresAt.toISOString(),
          replacedLinks: replaced.length,
        },
        tx,
      );
      return { signer, destination, accessCode };
    });
    return {
      signerId: result.signer.id,
      url: `${this.env.WEB_APP_URL.replace(/\/$/, '')}/sign/${token}`,
      expiresAt: expiresAt.toISOString(),
      method: input.method,
      accessCode: result.accessCode,
      destination: result.destination,
    };
  }

  async revokeLink(ctx: TenantContext, id: string, signerId: string): Promise<ContractSigningDto> {
    const c = await this.contracts.loadVisible(ctx, id);
    this.requireManage(ctx, c);
    await this.db.transaction(async (tx) => {
      const round = await this.openRound(tx, id, true);
      if (!round) throw Errors.conflict('not_signing', 'This contract is not out for signature');
      const [signer] = await tx
        .select({ id: contractSigners.id, role: contractSigners.role })
        .from(contractSigners)
        .where(and(eq(contractSigners.id, signerId), eq(contractSigners.roundId, round.id)));
      if (!signer) throw Errors.notFound('Signer');
      const revoked = await tx
        .update(signingLinks)
        .set({ revokedAt: new Date(), revokedByUserId: ctx.user.id, revokeReason: 'revoked' })
        .where(
          and(
            eq(signingLinks.signerId, signer.id),
            isNull(signingLinks.revokedAt),
            isNull(signingLinks.usedAt),
          ),
        )
        .returning({ id: signingLinks.id });
      if (!revoked.length) throw Errors.notFound('Signing link');
      await this.audit.fromCtx(
        ctx,
        'contract.signing_link_revoked',
        { type: 'contract', id },
        {
          number: c.row.number,
          roundId: round.id,
          signerId: signer.id,
          role: signer.role,
          linkIds: revoked.map((r) => r.id),
        },
        tx,
      );
    });
    return this.state(ctx, id);
  }

  async cancel(ctx: TenantContext, id: string, reason: string): Promise<ContractSigningDto> {
    const trimmed = reason.trim();
    if (trimmed.length < 3)
      throw Errors.validation([{ path: ['reason'], message: 'reason_required' }]);
    const c = await this.contracts.loadVisible(ctx, id);
    this.requireManage(ctx, c);
    await this.db.transaction(async (tx) => {
      await this.contracts.loadVisible(ctx, id, tx, true);
      const round = await this.openRound(tx, id, true);
      if (!round) throw Errors.conflict('not_signing', 'This contract is not out for signature');
      const signers = await this.roundSigners(tx, round.id);
      if (signers.every((s) => s.status === 'signed'))
        throw Errors.conflict(
          'contract_invalid_transition',
          'Every signature is in; the signed document is being prepared',
        );
      const now = new Date();
      await tx
        .update(signingRounds)
        .set({
          status: 'cancelled',
          cancelledAt: now,
          cancelledByUserId: ctx.user.id,
          cancelReason: trimmed,
        })
        .where(eq(signingRounds.id, round.id));
      await tx
        .update(signingLinks)
        .set({ revokedAt: now, revokedByUserId: ctx.user.id, revokeReason: 'signing_cancelled' })
        .where(
          and(
            inArray(
              signingLinks.signerId,
              signers.map((s) => s.id),
            ),
            isNull(signingLinks.revokedAt),
            isNull(signingLinks.usedAt),
          ),
        );
      await tx
        .update(contracts)
        .set({ status: 'approved', updatedByUserId: ctx.user.id, updatedAt: now })
        .where(eq(contracts.id, id));
      await this.audit.fromCtx(
        ctx,
        'contract.signing_cancelled',
        { type: 'contract', id },
        {
          number: c.row.number,
          roundId: round.id,
          reason: trimmed,
          signedBefore: signers.filter((s) => s.status === 'signed').map((s) => s.role),
        },
        tx,
      );
    });
    return this.state(ctx, id);
  }

  async state(ctx: TenantContext, id: string): Promise<ContractSigningDto> {
    const c = await this.contracts.loadVisible(ctx, id);
    // A round whose last signature is in but whose signed PDF failed to render is finished here.
    const open = await this.openRound(this.db, id);
    if (open) {
      const s = await this.roundSigners(this.db, open.id);
      if (s.every((x) => x.status === 'signed')) {
        await this.finalize(ctx.organizationId, open.id).catch((e: unknown) =>
          this.logger.error(`Finalizing ${c.row.number} failed: ${String(e)}`),
        );
      }
    }
    const rounds = await this.db
      .select()
      .from(signingRounds)
      .where(
        and(eq(signingRounds.contractId, id), eq(signingRounds.organizationId, ctx.organizationId)),
      )
      .orderBy(desc(signingRounds.startedAt));
    const signers = rounds.length
      ? await this.db
          .select()
          .from(contractSigners)
          .where(
            inArray(
              contractSigners.roundId,
              rounds.map((r) => r.id),
            ),
          )
          .orderBy(asc(contractSigners.signOrder))
      : [];
    const links = signers.length
      ? await this.db
          .select()
          .from(signingLinks)
          .where(
            inArray(
              signingLinks.signerId,
              signers.map((s) => s.id),
            ),
          )
          .orderBy(desc(signingLinks.createdAt))
      : [];
    const userIds = [
      ...new Set(
        [
          ...rounds.flatMap((r) => [r.startedByUserId, r.cancelledByUserId]),
          ...links.map((l) => l.createdByUserId),
        ].filter((x): x is string => !!x),
      ),
    ];
    const names = new Map(
      userIds.length
        ? (
            await this.db
              .select({ id: users.id, name: users.displayName })
              .from(users)
              .where(inArray(users.id, userIds))
          ).map((u) => [u.id, u.name])
        : [],
    );
    const who = (uid: string | null) =>
      uid ? { id: uid, displayName: names.get(uid) ?? '' } : null;
    const now = new Date();

    const out: SigningRoundDto[] = [];
    for (const r of rounds) {
      const rs = signers.filter((s) => s.roundId === r.id);
      let signedDocument: SigningRoundDto['signedDocument'] = null;
      if (r.signedDocumentFileId) {
        const f = await this.files.get(ctx.organizationId, r.signedDocumentFileId);
        if (f)
          signedDocument = {
            sha256: r.signedDocumentSha256!,
            sizeBytes: f.sizeBytes,
            verified: sha256Hex(f.data) === r.signedDocumentSha256,
          };
      }
      out.push({
        id: r.id,
        status: r.status as SigningRoundStatus,
        minor: r.minor,
        minorOn: r.minorOn,
        approvedDocumentSha256: r.approvedDocumentSha256,
        startedAt: r.startedAt.toISOString(),
        startedBy: who(r.startedByUserId),
        completedAt: r.completedAt?.toISOString() ?? null,
        cancelledAt: r.cancelledAt?.toISOString() ?? null,
        cancelledBy: who(r.cancelledByUserId),
        cancelReason: r.cancelReason,
        signedDocument,
        signers: rs.map((s): SignerDto => {
          const l = links.find((x) => x.signerId === s.id);
          return {
            id: s.id,
            role: s.role as SignerRole,
            order: s.signOrder,
            nameEn: s.nameEn,
            nameAr: s.nameAr,
            email: s.email,
            phone: s.phone,
            relationship: s.relationship,
            status: s.status as SignerStatus,
            turn:
              r.status === 'in_progress' &&
              s.status === 'pending' &&
              rs.every((o) => o.signOrder >= s.signOrder || o.status === 'signed'),
            link: {
              state: linkState(l, now),
              method: (l?.method as VerificationMethod) ?? null,
              destination: l?.destination ?? null,
              createdAt: l?.createdAt.toISOString() ?? null,
              expiresAt: l?.expiresAt.toISOString() ?? null,
              createdBy: who(l?.createdByUserId ?? null),
            },
            signature:
              s.status === 'signed'
                ? {
                    method: s.signatureMethod as SignatureMethod,
                    typedName: s.typedName,
                    fontKey: s.fontKey as SignatureFontKey | null,
                    strokes: s.strokes,
                    signedAt: s.signedAt!.toISOString(),
                    verification: s.verificationMethod as VerificationMethod,
                    verifiedAt: s.verifiedAt!.toISOString(),
                    ip: s.ip,
                    userAgent: s.userAgent,
                    consentLocale: s.consentLocale as 'ar' | 'en',
                    consentText: s.consentText!,
                    documentSha256: s.documentSha256!,
                  }
                : null,
          };
        }),
      });
    }
    const current = out.find((r) => r.status === 'in_progress');
    const manage = this.canManage(ctx, c);
    return {
      rounds: out,
      can: {
        start: manage && c.row.status === 'approved',
        manageLinks: manage && !!current,
        cancel: manage && !!current,
        download:
          coversRecord(ctx.access, 'contracts.export', c.team) &&
          out.some((r) => r.status === 'completed'),
      },
    };
  }

  /** The fully signed PDF exactly as stored, after checking its hash. */
  async signedPdf(ctx: TenantContext, id: string) {
    const c = await this.contracts.loadVisible(ctx, id);
    if (!coversRecord(ctx.access, 'contracts.export', c.team)) throw Errors.forbidden();
    const f = await this.signedFile(ctx.organizationId, id, c.row.number);
    await this.audit.fromCtx(
      ctx,
      'contract.exported',
      { type: 'contract', id },
      { number: c.row.number, kind: 'signed', sha256: f.sha256 },
    );
    return { pdf: f.data, filename: `${c.row.number}-signed.pdf`, sha256: f.sha256 };
  }

  private async signedFile(organizationId: string, contractId: string, number: string) {
    const [r] = await this.db
      .select()
      .from(signingRounds)
      .where(
        and(
          eq(signingRounds.organizationId, organizationId),
          eq(signingRounds.contractId, contractId),
          eq(signingRounds.status, 'completed'),
        ),
      );
    const f = r?.signedDocumentFileId
      ? await this.files.get(organizationId, r.signedDocumentFileId)
      : null;
    if (!r || !f) throw Errors.notFound('Signed document');
    if (sha256Hex(f.data) !== r.signedDocumentSha256) {
      this.logger.error(`Integrity check failed for signed ${number} (file ${f.id})`);
      throw new AppError('internal_error', 500, 'The stored document failed its integrity check');
    }
    return { data: f.data, sha256: r.signedDocumentSha256 };
  }

  // ================================================================ completion

  /**
   * When every required signer has signed: build the signed PDF (the approved PDF, unchanged,
   * followed by the signature record), store it with its SHA-256, close the round, mark the
   * contract signed and notify. Idempotent; safe to call again if a previous attempt failed.
   */
  async finalize(organizationId: string, roundId: string): Promise<boolean> {
    const [round] = await this.db
      .select()
      .from(signingRounds)
      .where(and(eq(signingRounds.id, roundId), eq(signingRounds.organizationId, organizationId)));
    if (!round || round.status !== 'in_progress') return false;
    const signers = await this.roundSigners(this.db, roundId);
    if (!signers.length || signers.some((s) => s.status !== 'signed')) return false;
    const [contract] = await this.db
      .select()
      .from(contracts)
      .where(eq(contracts.id, round.contractId));
    if (!contract) return false;

    const approved = await this.contracts.approvedFile(
      organizationId,
      round.approvalRequestId,
      contract.number,
    );
    if (approved.sha256 !== round.approvedDocumentSha256)
      throw new AppError('internal_error', 500, 'Approved document changed during signing');
    const snapshot = await this.approvedSnapshot(
      organizationId,
      contract.id,
      round.approvalRequestId,
    );
    const settings = await this.settings.get(organizationId);
    const completedAt = new Date(
      Math.max(...signers.map((s) => s.signedAt!.getTime()), Date.now()),
    );
    const r = snapshot.details.recipient;
    const html = certificateHtml({
      organizationName: {
        en: settings.legalNameEn || settings.legalNameAr || settings.organizationName,
        ar: settings.legalNameAr || settings.legalNameEn || settings.organizationName,
      },
      contractNumber: contract.number,
      contractTitle: contractTitle(snapshot),
      language: snapshot.details.language,
      recipientName: { en: r.fullNameEn ?? null, ar: r.fullNameAr ?? null },
      approvedVersion: approved.version,
      approverName: approved.deciderName,
      approvedDocumentSha256: approved.sha256,
      completedAt,
      signers: signers.map((s): CertificateSigner => ({
        role: s.role as SignerRole,
        nameEn: s.nameEn,
        nameAr: s.nameAr,
        relationship: s.relationship,
        signatureMethod: s.signatureMethod as SignatureMethod,
        typedName: s.typedName,
        fontKey: s.fontKey as SignatureFontKey | null,
        strokes: s.strokes,
        signedAt: s.signedAt!,
        verificationMethod: s.verificationMethod as VerificationMethod,
        verificationDestination: s.verificationDestination,
        verifiedAt: s.verifiedAt!,
        ip: s.ip,
        userAgent: s.userAgent,
        consentText: s.consentText!,
        consentLocale: s.consentLocale as ContractLocale,
        recordSha256: s.recordSha256!,
      })),
    });
    const record = await renderGuard(() =>
      this.pdf.render(html, {
        margin: { top: '16mm', bottom: '18mm', left: '16mm', right: '16mm' },
        footerTemplate: certificateFooter(contract.number),
      }),
    );
    const signedPdf = await appendPages(approved.data, record, {
      title: `${contract.number} — ${contractTitle(snapshot).en}`,
      keywords: [contract.number, `approved-sha256:${approved.sha256}`],
      date: completedAt,
    });

    const done = await this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(signingRounds)
        .where(eq(signingRounds.id, roundId))
        .for('update');
      if (!locked || locked.status !== 'in_progress') return null;
      const again = await this.roundSigners(tx, roundId);
      if (again.some((s) => s.status !== 'signed')) return null;
      const file = await this.files.put(
        tx,
        organizationId,
        null,
        SIGNED_DOCUMENT_KIND,
        'application/pdf',
        signedPdf,
      );
      await tx
        .update(signingRounds)
        .set({
          status: 'completed',
          completedAt,
          signedDocumentFileId: file.id,
          signedDocumentSha256: file.sha256,
        })
        .where(eq(signingRounds.id, roundId));
      await tx
        .update(contracts)
        .set({ status: 'signed', updatedAt: completedAt })
        .where(and(eq(contracts.id, contract.id), eq(contracts.status, 'awaiting_signatures')));
      await this.audit.log(
        {
          organizationId,
          actorUserId: null,
          actorType: 'system',
          action: 'contract.fully_signed',
          targetType: 'contract',
          targetId: contract.id,
          metadata: {
            number: contract.number,
            roundId,
            signers: again.map((s) => ({ role: s.role, recordSha256: s.recordSha256 })),
            approvedDocumentSha256: approved.sha256,
            signedDocumentFileId: file.id,
            signedDocumentSha256: file.sha256,
          },
        },
        tx,
      );
      return file;
    });
    if (!done) return false;

    const direct = await this.interestedUsers(round);
    await this.notifications.notify({
      organizationId,
      recipientUserIds: direct,
      type: 'contract.fully_signed',
      data: { contractId: contract.id, number: contract.number },
      link: `/dashboard/contracts/${contract.id}?tab=signatures`,
    });
    // The Owners (spec §7.7: notify the requesting manager and the Owner).
    await this.notifications.notifyPermissionHolders({
      organizationId,
      permission: 'org.ownership.manage',
      excludeUserIds: direct,
      type: 'contract.fully_signed',
      data: { contractId: contract.id, number: contract.number },
      link: `/dashboard/contracts/${contract.id}?tab=signatures`,
    });
    this.logger.log(`Fully signed ${contract.number} (${done.sha256.slice(0, 12)})`);
    return true;
  }

  /** Who follows a round: who started it, who requested the approval, who created its links. */
  private async interestedUsers(round: RoundRow): Promise<string[]> {
    const [req] = await this.db
      .select({ by: approvalRequests.requestedByUserId })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, round.approvalRequestId));
    const creators = await this.db
      .selectDistinct({ by: signingLinks.createdByUserId })
      .from(signingLinks)
      .innerJoin(contractSigners, eq(contractSigners.id, signingLinks.signerId))
      .where(eq(contractSigners.roundId, round.id));
    return [
      ...new Set(
        [round.startedByUserId, req?.by, ...creators.map((c) => c.by)].filter(
          (x): x is string => !!x,
        ),
      ),
    ];
  }

  // ================================================================ public side

  private codeHash(linkId: string, code: string) {
    return hmacSha256(this.env.SESSION_SECRET, `signing-code:${linkId}:${code}`);
  }

  private async resolve(token: string): Promise<Resolved> {
    if (!TOKEN_RE.test(token))
      throw new AppError('link_invalid', 404, 'This signing link is not valid');
    const [r] = await this.db
      .select({
        link: signingLinks,
        signer: contractSigners,
        round: signingRounds,
        contract: {
          id: contracts.id,
          number: contracts.number,
          title: contracts.title,
          status: contracts.status,
        },
      })
      .from(signingLinks)
      .innerJoin(contractSigners, eq(contractSigners.id, signingLinks.signerId))
      .innerJoin(signingRounds, eq(signingRounds.id, contractSigners.roundId))
      .innerJoin(contracts, eq(contracts.id, signingRounds.contractId))
      .where(eq(signingLinks.tokenHash, sha256(token)));
    if (!r) throw new AppError('link_invalid', 404, 'This signing link is not valid');
    return r;
  }

  /** Revoked, locked or expired links are refused. A used link stays readable until it expires. */
  private assertOpen(r: Resolved) {
    if (r.link.revokedAt || r.round.status === 'cancelled')
      throw new AppError('link_revoked', 410, 'This signing link has been withdrawn');
    if (r.link.lockedAt)
      throw new AppError('link_locked', 410, 'This link is locked after too many wrong codes');
    if (r.link.expiresAt <= new Date())
      throw new AppError('link_expired', 410, 'This signing link has expired');
  }

  private publicState(r: Resolved, signers: SignerRow[]): PublicSigningState {
    if (r.round.status === 'completed') return 'completed';
    if (r.signer.status === 'signed') return 'signed';
    const waiting = signers.some((s) => s.signOrder < r.signer.signOrder && s.status !== 'signed');
    return waiting ? 'waiting' : 'ready';
  }

  async info(token: string): Promise<PublicSigningInfo> {
    const r = await this.resolve(token);
    this.assertOpen(r);
    if (!r.link.openedAt)
      await this.db
        .update(signingLinks)
        .set({ openedAt: new Date() })
        .where(and(eq(signingLinks.id, r.link.id), isNull(signingLinks.openedAt)));
    const settings = await this.settings.get(r.link.organizationId);
    const state: PublicSigningState =
      r.round.status === 'completed'
        ? 'completed'
        : r.signer.status === 'signed'
          ? 'signed'
          : 'verify';
    return {
      state,
      organizationName: settings.organizationName,
      contractNumber: r.contract.number,
      signerRole: r.signer.role as SignerRole,
      method: r.link.method as VerificationMethod,
      destination: r.link.destination ? maskEmail(r.link.destination) : null,
      expiresAt: r.link.expiresAt.toISOString(),
    };
  }

  async sendCode(token: string, meta: ClientMeta) {
    const r = await this.resolve(token);
    this.assertOpen(r);
    if (r.link.method !== 'email_code' || !r.link.destination)
      throw Errors.badRequest('validation_failed', 'This link uses an access code');
    const now = new Date();
    const since = r.link.lastCodeSentAt
      ? (now.getTime() - r.link.lastCodeSentAt.getTime()) / 1000
      : Infinity;
    if (since < CODE_RESEND_SECONDS) {
      const wait = Math.ceil(CODE_RESEND_SECONDS - since);
      throw new AppError('rate_limited', 429, 'Please wait before requesting another code', {
        retryAfterSeconds: wait,
      });
    }
    const code = sixDigits();
    const expiresAt = new Date(now.getTime() + EMAIL_CODE_MINUTES * 60_000);
    const [updated] = await this.db
      .update(signingLinks)
      .set({
        emailCodeHash: this.codeHash(r.link.id, code),
        emailCodeExpiresAt: expiresAt,
        emailCodesSent: sql`${signingLinks.emailCodesSent} + 1`,
        lastCodeSentAt: now,
      })
      .where(
        and(
          eq(signingLinks.id, r.link.id),
          lt(signingLinks.emailCodesSent, MAX_EMAIL_CODES),
          isNull(signingLinks.lockedAt),
        ),
      )
      .returning({ sent: signingLinks.emailCodesSent });
    if (!updated)
      throw new AppError('rate_limited', 429, 'Too many codes for this link; ask for a new link', {
        limit: MAX_EMAIL_CODES,
      });
    const settings = await this.settings.get(r.link.organizationId);
    const ok = await this.mail.sendSigningCode(r.link.destination, {
      organizationName: settings.organizationName,
      contractNumber: r.contract.number,
      code,
      minutes: EMAIL_CODE_MINUTES,
    });
    await this.audit.log({
      organizationId: r.link.organizationId,
      actorUserId: null,
      actorType: 'anonymous',
      action: 'contract.signing_code_sent',
      targetType: 'contract',
      targetId: r.contract.id,
      metadata: {
        number: r.contract.number,
        signerId: r.signer.id,
        role: r.signer.role,
        linkId: r.link.id,
        destination: maskEmail(r.link.destination),
        delivered: ok,
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    if (!ok)
      throw new AppError('email_unavailable', 503, 'The code could not be sent; try again later');
    return {
      destination: maskEmail(r.link.destination),
      expiresAt: expiresAt.toISOString(),
      resendAfterSeconds: CODE_RESEND_SECONDS,
    };
  }

  async verify(token: string, code: string, meta: ClientMeta): Promise<PublicSigningVerified> {
    const r = await this.resolve(token);
    this.assertOpen(r);
    const now = new Date();
    if (
      r.link.method === 'email_code' &&
      (!r.link.emailCodeHash || !r.link.emailCodeExpiresAt || r.link.emailCodeExpiresAt <= now)
    )
      throw new AppError('verification_required', 400, 'Request a code first');

    // Reserve an attempt before comparing, so parallel guesses can't exceed the limit.
    const [reserved] = await this.db
      .update(signingLinks)
      .set({ failedAttempts: sql`${signingLinks.failedAttempts} + 1` })
      .where(
        and(
          eq(signingLinks.id, r.link.id),
          isNull(signingLinks.lockedAt),
          lt(signingLinks.failedAttempts, VERIFY_MAX_ATTEMPTS),
        ),
      )
      .returning();
    if (!reserved)
      throw new AppError('link_locked', 410, 'This link is locked after too many wrong codes');

    const candidate = this.codeHash(r.link.id, code);
    const expected =
      reserved.method === 'access_code'
        ? reserved.accessCodeHash
        : reserved.emailCodeExpiresAt && reserved.emailCodeExpiresAt > now
          ? reserved.emailCodeHash
          : null;
    const ok = !!expected && safeEqual(candidate, expected);
    const base = {
      organizationId: r.link.organizationId,
      actorUserId: null,
      actorType: 'anonymous' as const,
      targetType: 'contract',
      targetId: r.contract.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
    };

    if (!ok) {
      const locked = reserved.failedAttempts >= VERIFY_MAX_ATTEMPTS;
      if (locked)
        await this.db
          .update(signingLinks)
          .set({ lockedAt: now })
          .where(and(eq(signingLinks.id, r.link.id), isNull(signingLinks.lockedAt)));
      await this.audit.log({
        ...base,
        action: 'contract.signer_verification_failed',
        metadata: {
          number: r.contract.number,
          signerId: r.signer.id,
          role: r.signer.role,
          linkId: r.link.id,
          attempts: reserved.failedAttempts,
          locked,
        },
      });
      if (locked)
        throw new AppError('link_locked', 410, 'This link is locked after too many wrong codes', {
          attemptsLeft: 0,
        });
      throw new AppError('verification_failed', 400, 'That code is not correct', {
        attemptsLeft: VERIFY_MAX_ATTEMPTS - reserved.failedAttempts,
      });
    }

    await this.db
      .update(signingLinks)
      .set({
        failedAttempts: sql`${signingLinks.failedAttempts} - 1`,
        verifiedAt: now,
        // An emailed code works once.
        ...(reserved.method === 'email_code'
          ? { emailCodeHash: null, emailCodeExpiresAt: null }
          : {}),
      })
      .where(eq(signingLinks.id, r.link.id));
    const sessionToken = randomToken();
    const ttl = Math.max(
      1,
      Math.min(
        SIGNING_SESSION_MINUTES * 60,
        Math.floor((r.link.expiresAt.getTime() - now.getTime()) / 1000),
      ),
    );
    const data: SessionData = { linkId: r.link.id, verifiedAt: now.toISOString() };
    await this.redis.set(SESSION_PREFIX + sha256(sessionToken), JSON.stringify(data), 'EX', ttl);
    await this.audit.log({
      ...base,
      action: 'contract.signer_verified',
      metadata: {
        number: r.contract.number,
        signerId: r.signer.id,
        role: r.signer.role,
        linkId: r.link.id,
        method: reserved.method,
        destination: reserved.destination ? maskEmail(reserved.destination) : null,
      },
    });
    const fresh = await this.resolve(token);
    return {
      sessionToken,
      session: await this.sessionDto(fresh, new Date(now.getTime() + ttl * 1000)),
    };
  }

  private async requireSession(token: string, sessionToken: string | undefined) {
    const r = await this.resolve(token);
    this.assertOpen(r);
    if (!sessionToken || sessionToken.length > 64)
      throw new AppError('verification_required', 401, 'Enter your code first');
    const key = SESSION_PREFIX + sha256(sessionToken);
    const [raw, ttl] = await Promise.all([this.redis.get(key), this.redis.ttl(key)]);
    const data = raw ? (JSON.parse(raw) as SessionData) : null;
    if (!data || data.linkId !== r.link.id)
      throw new AppError('verification_required', 401, 'Enter your code first');
    return { r, data, expiresAt: new Date(Date.now() + Math.max(ttl, 0) * 1000) };
  }

  private async sessionDto(r: Resolved, expiresAt: Date): Promise<PublicSigningSession> {
    const [settings, snapshot, signers] = await Promise.all([
      this.settings.get(r.link.organizationId),
      this.approvedSnapshot(r.link.organizationId, r.contract.id, r.round.approvalRequestId),
      this.roundSigners(this.db, r.round.id),
    ]);
    const rec = snapshot.details.recipient;
    const params = (l: ContractLocale) => ({
      signerName: signerName(r.signer, l),
      recipientName:
        (l === 'ar' ? rec.fullNameAr || rec.fullNameEn : rec.fullNameEn || rec.fullNameAr) ?? '',
      contractNumber: r.contract.number,
      organizationName: settings.organizationName,
    });
    return {
      state: this.publicState(r, signers),
      organizationName: settings.organizationName,
      contractNumber: r.contract.number,
      contractTitle: contractTitle(snapshot),
      documentLanguage: snapshot.details.language,
      documentSha256: r.round.approvedDocumentSha256,
      signer: {
        role: r.signer.role as SignerRole,
        nameEn: r.signer.nameEn,
        nameAr: r.signer.nameAr,
        relationship: r.signer.relationship,
      },
      recipientName: { en: rec.fullNameEn ?? null, ar: rec.fullNameAr ?? null },
      consent: {
        version: CONSENT_VERSION,
        en: consentText(r.signer.role as SignerRole, 'en', params('en')),
        ar: consentText(r.signer.role as SignerRole, 'ar', params('ar')),
      },
      signers: signers.map((s) => ({
        role: s.role as SignerRole,
        status: s.status as SignerStatus,
        signedAt: s.signedAt?.toISOString() ?? null,
      })),
      signedAt: r.signer.signedAt?.toISOString() ?? null,
      sessionExpiresAt: expiresAt.toISOString(),
    };
  }

  async session(token: string, sessionToken: string | undefined): Promise<PublicSigningSession> {
    const { r, expiresAt } = await this.requireSession(token, sessionToken);
    return this.sessionDto(r, expiresAt);
  }

  async documentHtml(token: string, sessionToken: string | undefined): Promise<string> {
    const { r } = await this.requireSession(token, sessionToken);
    return this.contracts.approvedHtml(
      r.link.organizationId,
      r.contract.id,
      r.round.approvalRequestId,
      r.contract.number,
    );
  }

  /** The approved PDF being signed, exactly as stored (hash-checked). */
  async documentPdf(token: string, sessionToken: string | undefined) {
    const { r } = await this.requireSession(token, sessionToken);
    const f = await this.contracts.approvedFile(
      r.link.organizationId,
      r.round.approvalRequestId,
      r.contract.number,
    );
    if (f.sha256 !== r.round.approvedDocumentSha256)
      throw new AppError('internal_error', 500, 'The stored document failed its integrity check');
    return { pdf: f.data, filename: `${r.contract.number}-approved.pdf`, sha256: f.sha256 };
  }

  /** After every signature is in, each signer can download the fully signed copy. */
  async signedCopy(token: string, sessionToken: string | undefined) {
    const { r } = await this.requireSession(token, sessionToken);
    if (r.round.status !== 'completed') throw Errors.notFound('Signed document');
    const f = await this.signedFile(r.link.organizationId, r.contract.id, r.contract.number);
    return { pdf: f.data, filename: `${r.contract.number}-signed.pdf`, sha256: f.sha256 };
  }

  async sign(
    token: string,
    sessionToken: string | undefined,
    input: SignInput,
    meta: ClientMeta,
  ): Promise<PublicSigningSession> {
    const { r, data, expiresAt } = await this.requireSession(token, sessionToken);
    if (r.signer.status === 'signed' || r.link.usedAt)
      throw Errors.conflict('already_signed', 'This signature has already been given');
    if (r.round.status !== 'in_progress')
      throw Errors.conflict('not_signing', 'This contract is no longer out for signature');
    const signers = await this.roundSigners(this.db, r.round.id);
    if (signers.some((s) => s.signOrder < r.signer.signOrder && s.status !== 'signed'))
      throw Errors.conflict('not_your_turn', 'An earlier signer has not signed yet');

    // The document must still be exactly the one approved.
    const approved = await this.contracts.approvedFile(
      r.link.organizationId,
      r.round.approvalRequestId,
      r.contract.number,
    );
    if (approved.sha256 !== r.round.approvedDocumentSha256)
      throw new AppError('internal_error', 500, 'The stored document failed its integrity check');

    const session = await this.sessionDto(r, expiresAt);
    const consent = input.locale === 'ar' ? session.consent.ar : session.consent.en;
    const signedAt = new Date();
    const verifiedAt = new Date(data.verifiedAt);
    const typedName = input.method === 'typed' ? input.typedName!.trim() : null;
    const fontKey = input.method === 'typed' ? input.fontKey! : null;
    const strokes = input.method === 'drawn' ? input.strokes! : null;
    const destination = r.link.destination ? maskEmail(r.link.destination) : null;
    const record = {
      contractId: r.contract.id,
      contractNumber: r.contract.number,
      roundId: r.round.id,
      signerId: r.signer.id,
      role: r.signer.role,
      name: { en: r.signer.nameEn, ar: r.signer.nameAr },
      signature: { method: input.method, typedName, fontKey, strokes },
      consent: { version: CONSENT_VERSION, locale: input.locale, text: consent },
      documentSha256: approved.sha256,
      verification: { method: r.link.method, destination, verifiedAt: verifiedAt.toISOString() },
      signedAt: signedAt.toISOString(),
      ip: meta.ip,
      userAgent: meta.userAgent,
    };
    const recordSha256 = sha256Hex(canonicalJson(record));

    await this.db.transaction(async (tx) => {
      const [round] = await tx
        .select({ status: signingRounds.status })
        .from(signingRounds)
        .where(eq(signingRounds.id, r.round.id))
        .for('update');
      if (round?.status !== 'in_progress')
        throw Errors.conflict('not_signing', 'This contract is no longer out for signature');
      const earlier = await tx
        .select({ status: contractSigners.status })
        .from(contractSigners)
        .where(
          and(
            eq(contractSigners.roundId, r.round.id),
            lt(contractSigners.signOrder, r.signer.signOrder),
          ),
        );
      if (earlier.some((s) => s.status !== 'signed'))
        throw Errors.conflict('not_your_turn', 'An earlier signer has not signed yet');
      const [link] = await tx
        .update(signingLinks)
        .set({ usedAt: signedAt })
        .where(
          and(
            eq(signingLinks.id, r.link.id),
            isNull(signingLinks.usedAt),
            isNull(signingLinks.revokedAt),
            isNull(signingLinks.lockedAt),
          ),
        )
        .returning({ id: signingLinks.id });
      if (!link) throw Errors.conflict('already_signed', 'This link has already been used');
      const [signed] = await tx
        .update(contractSigners)
        .set({
          status: 'signed',
          signedAt,
          signedViaLinkId: r.link.id,
          verificationMethod: r.link.method,
          verificationDestination: destination,
          verifiedAt,
          signatureMethod: input.method,
          typedName,
          fontKey,
          strokes,
          consentVersion: CONSENT_VERSION,
          consentLocale: input.locale,
          consentText: consent,
          documentSha256: approved.sha256,
          recordSha256,
          ip: meta.ip,
          userAgent: meta.userAgent,
        })
        .where(and(eq(contractSigners.id, r.signer.id), eq(contractSigners.status, 'pending')))
        .returning({ id: contractSigners.id });
      if (!signed) throw Errors.conflict('already_signed', 'This signature has already been given');
      await this.audit.log(
        {
          organizationId: r.link.organizationId,
          actorUserId: null,
          actorType: 'anonymous',
          action: 'contract.signed',
          targetType: 'contract',
          targetId: r.contract.id,
          metadata: {
            number: r.contract.number,
            roundId: r.round.id,
            signerId: r.signer.id,
            role: r.signer.role,
            signerName: signerName(r.signer, 'en'),
            linkId: r.link.id,
            signatureMethod: input.method,
            verificationMethod: r.link.method,
            documentSha256: approved.sha256,
            recordSha256,
          },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });

    await this.notifications.notify({
      organizationId: r.link.organizationId,
      recipientUserIds: await this.interestedUsers(r.round),
      type: 'contract.signature_received',
      data: {
        contractId: r.contract.id,
        number: r.contract.number,
        role: r.signer.role,
        signerName: signerName(r.signer, 'en'),
        signerNameAr: signerName(r.signer, 'ar'),
      },
      link: `/dashboard/contracts/${r.contract.id}?tab=signatures`,
    });

    const remaining = signers.filter((s) => s.id !== r.signer.id && s.status !== 'signed');
    if (!remaining.length) {
      try {
        await this.finalize(r.link.organizationId, r.round.id);
      } catch (e) {
        // The signature is recorded; the signed PDF is retried when the round is next viewed.
        this.logger.error(`Finalizing ${r.contract.number} failed: ${String(e)}`);
      }
    }
    return this.sessionDto(await this.resolve(token), expiresAt);
  }
}

/** The approved PDF's pages, unchanged, followed by the signature record's pages. */
async function appendPages(
  base: Buffer,
  extra: Buffer,
  meta: { title: string; keywords: string[]; date: Date },
): Promise<Buffer> {
  const { PDFDocument } = await import('pdf-lib');
  const out = await PDFDocument.load(base);
  const add = await PDFDocument.load(extra);
  for (const p of await out.copyPages(add, add.getPageIndices())) out.addPage(p);
  out.setTitle(meta.title);
  out.setSubject('Signed contract with signature record');
  out.setKeywords(meta.keywords);
  out.setModificationDate(meta.date);
  return Buffer.from(await out.save());
}
