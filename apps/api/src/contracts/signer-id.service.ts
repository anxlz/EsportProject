/**
 * Identity documents uploaded by signers (ID-document patch to the Phase 4 signing flow).
 *
 * Before the recipient can sign, they upload a photo or scan of a passport or national ID. The
 * guardian of a minor is not asked (a minor's guardian signs on someone else's behalf, and the
 * minor may hold neither document). This is the most sensitive personal data in the system, so:
 *
 * - the file is checked by its bytes (PNG, JPEG, WebP or PDF; the same sniffing as other
 *   uploads), never by its name or declared type alone;
 * - it is ENCRYPTED at rest (AES-256-GCM, key from DOCUMENT_ENCRYPTION_KEY, or HKDF of
 *   SESSION_SECRET outside production; the organization and document id are bound in as
 *   associated data), and stored apart from the contract: it is never merged into the contract
 *   PDF or shown with the contract;
 * - only holders of `contracts.view_signer_id` covering the contract's team can view it (Owners
 *   hold every permission); seeing, approving or exporting the contract does not include it;
 * - every upload AND every view is written to the audit log;
 * - nothing here is reachable from the AI assistants: they have no tool for it, and lint and a
 *   test keep `src/assistants` and `src/ai` from importing this service or its table;
 * - nothing is deleted: how long these documents are kept, and who may ask for deletion, is an
 *   open product decision (DECISIONS.md), not something this code decides.
 *
 * It strengthens the record of who signed. It is not an official or certified identity check,
 * and the product makes no claim that it satisfies any legal or regulatory requirement.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ID_DOCUMENT_CONTENT_TYPES,
  ID_DOCUMENT_MAX_BYTES,
  ID_DOCUMENT_ROLES,
  type IdDocumentType,
  type SignerIdDocumentDto,
  type SignerRole,
} from '@esports/shared';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { ClientMeta, TenantContext } from '../authz/context';
import { AuditService } from '../audit/audit.service';
import { AppError, Errors } from '../common/errors';
import { type Env, ENV } from '../config/env';
import { DB, type Database, type DbOrTx } from '../db/client';
import { contractSigners, signerIdDocuments, signingRounds } from '../db/schema-contracts';
import { FilesService, sniffContentType } from '../files/files.service';
import { coversRecord } from '../finance/scope';
import { sha256Hex } from '../versioning/versioning.service';
import type { LoadedContract } from './contracts.service';

export const ID_DOCUMENT_FILE_KIND = 'signer_id_document';
const VIEW_PERMISSION = 'contracts.view_signer_id';
/** Stored blob layout: MAGIC | 12-byte IV | ciphertext | 16-byte GCM tag. */
const MAGIC = Buffer.from('ESID1', 'latin1');

type DocRow = typeof signerIdDocuments.$inferSelect;

export const idDocumentRequired = (role: string) =>
  (ID_DOCUMENT_ROLES as readonly string[]).includes(role);

/** Who is uploading: the signer behind a verified signing session. */
export interface UploadingSigner {
  link: { id: string; organizationId: string; usedAt: Date | null };
  signer: { id: string; role: string; status: string };
  round: { id: string; status: string };
  contract: { id: string; number: string };
}

@Injectable()
export class SignerIdService {
  private readonly logger = new Logger('SignerId');
  private readonly key: Buffer;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) env: Env,
    private readonly files: FilesService,
    private readonly audit: AuditService,
  ) {
    this.key = Buffer.from(
      env.DOCUMENT_ENCRYPTION_KEY
        ? hkdfSync('sha256', env.DOCUMENT_ENCRYPTION_KEY, '', 'signer-id-documents/v1', 32)
        : hkdfSync('sha256', env.SESSION_SECRET, 'esports-platform', 'signer-id-documents/v1', 32),
    );
  }

  // ---------------------------------------------------------------- bytes

  /** The real type of an upload, or a refusal (empty, too large, not an accepted type). */
  validate(data: Buffer, declaredType: string | undefined): string {
    const declared = declaredType?.split(';')[0]!.trim().toLowerCase() || undefined;
    const accepted = ID_DOCUMENT_CONTENT_TYPES as readonly string[];
    const refuse = () =>
      new AppError(
        'unsupported_file_type',
        415,
        `Accepted: ${ID_DOCUMENT_CONTENT_TYPES.join(', ')}`,
      );
    // A declared type outside the list is refused outright (its body isn't even read).
    if (declared && !accepted.includes(declared)) throw refuse();
    if (!data.length) throw Errors.badRequest('validation_failed', 'Empty file');
    if (data.length > ID_DOCUMENT_MAX_BYTES)
      throw new AppError('file_too_large', 413, 'The document can be at most 8 MB');
    // The bytes decide: a renamed or mislabelled file (say an executable sent as image/png, or
    // a PDF sent as image/jpeg) is refused.
    const actual = sniffContentType(data);
    if (!actual || !accepted.includes(actual) || (declared && declared !== actual)) throw refuse();
    return actual;
  }

  private aad(organizationId: string, documentId: string) {
    return Buffer.from(`signer-id-document:${organizationId}:${documentId}`, 'utf8');
  }

  private seal(plain: Buffer, organizationId: string, documentId: string): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(this.aad(organizationId, documentId));
    const body = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([MAGIC, iv, body, c.getAuthTag()]);
  }

  private open(blob: Buffer, organizationId: string, documentId: string): Buffer {
    if (blob.length < MAGIC.length + 28 || !blob.subarray(0, MAGIC.length).equals(MAGIC))
      throw new Error('Unknown identity document format');
    const iv = blob.subarray(MAGIC.length, MAGIC.length + 12);
    const tag = blob.subarray(blob.length - 16);
    const d = createDecipheriv('aes-256-gcm', this.key, iv);
    d.setAAD(this.aad(organizationId, documentId));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(blob.subarray(MAGIC.length + 12, blob.length - 16)), d.final()]);
  }

  // ---------------------------------------------------------------- signer side

  /** The signer's current upload (the latest, not replaced). */
  async current(signerId: string, db: DbOrTx = this.db): Promise<DocRow | null> {
    const [row] = await db
      .select()
      .from(signerIdDocuments)
      .where(and(eq(signerIdDocuments.signerId, signerId), isNull(signerIdDocuments.supersededAt)));
    return row ?? null;
  }

  /** What the signing page may know about the upload: never the file itself. */
  async forSession(signer: { id: string; role: string }) {
    const doc = idDocumentRequired(signer.role) ? await this.current(signer.id) : null;
    return {
      required: idDocumentRequired(signer.role),
      uploaded: doc
        ? {
            documentType: doc.documentType as IdDocumentType,
            contentType: doc.contentType,
            sizeBytes: doc.sizeBytes,
            uploadedAt: doc.uploadedAt.toISOString(),
          }
        : null,
    };
  }

  /**
   * Stores a new upload (replacing an earlier one, which is kept but no longer current).
   * Only the recipient, before signing, while the round is open.
   */
  async upload(
    s: UploadingSigner,
    documentType: IdDocumentType,
    data: Buffer,
    declaredType: string | undefined,
    meta: ClientMeta,
  ) {
    if (!idDocumentRequired(s.signer.role))
      throw Errors.badRequest('id_document_not_needed', 'No identity document is asked of you');
    if (s.signer.status === 'signed' || s.link.usedAt)
      throw Errors.conflict('already_signed', 'This signature has already been given');
    if (s.round.status !== 'in_progress')
      throw Errors.conflict('not_signing', 'This contract is no longer out for signature');
    const contentType = this.validate(data, declaredType);
    const organizationId = s.link.organizationId;
    const id = randomUUID();
    const sha256 = sha256Hex(data);
    const sealed = this.seal(data, organizationId, id);

    const replaced = await this.db.transaction(async (tx) => {
      // One upload at a time per signer; the signer must still be pending.
      const [signer] = await tx
        .select({ status: contractSigners.status })
        .from(contractSigners)
        .where(eq(contractSigners.id, s.signer.id))
        .for('update');
      if (signer?.status !== 'pending')
        throw Errors.conflict('already_signed', 'This signature has already been given');
      const now = new Date();
      const old = await tx
        .update(signerIdDocuments)
        .set({ supersededAt: now })
        .where(
          and(eq(signerIdDocuments.signerId, s.signer.id), isNull(signerIdDocuments.supersededAt)),
        )
        .returning({ id: signerIdDocuments.id });
      const file = await this.files.put(
        tx,
        organizationId,
        null,
        ID_DOCUMENT_FILE_KIND,
        'application/octet-stream',
        sealed,
      );
      await tx.insert(signerIdDocuments).values({
        id,
        organizationId,
        roundId: s.round.id,
        signerId: s.signer.id,
        fileId: file.id,
        documentType,
        contentType,
        sizeBytes: data.length,
        sha256,
        uploadedViaLinkId: s.link.id,
        uploadedAt: now,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      await this.audit.log(
        {
          organizationId,
          actorUserId: null,
          actorType: 'anonymous',
          action: 'contract.signer_id_uploaded',
          targetType: 'contract',
          targetId: s.contract.id,
          metadata: {
            number: s.contract.number,
            roundId: s.round.id,
            signerId: s.signer.id,
            role: s.signer.role,
            linkId: s.link.id,
            documentId: id,
            documentType,
            contentType,
            sizeBytes: data.length,
            sha256,
            replaced: old.length > 0,
          },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
      return old.length > 0;
    });
    this.logger.log(
      `Identity document stored for ${s.contract.number} (${replaced ? 'replaced' : 'new'})`,
    );
  }

  // ---------------------------------------------------------------- dashboard side

  canView(ctx: TenantContext, c: LoadedContract) {
    return coversRecord(ctx.access, VIEW_PERMISSION, c.team);
  }

  /** Every upload by these signers, newest first (metadata only). */
  async list(signerIds: string[]): Promise<DocRow[]> {
    if (!signerIds.length) return [];
    return this.db
      .select()
      .from(signerIdDocuments)
      .where(inArray(signerIdDocuments.signerId, signerIds))
      .orderBy(desc(signerIdDocuments.uploadedAt));
  }

  /** The status entry for one signer; details only for holders of the view permission. */
  status(
    signer: { id: string; role: string; idDocumentId: string | null; status: string },
    docs: DocRow[],
    detailed: boolean,
  ) {
    const mine = docs.filter((d) => d.signerId === signer.id);
    const currentId =
      signer.status === 'signed'
        ? signer.idDocumentId
        : (mine.find((d) => !d.supersededAt)?.id ?? null);
    return {
      required: idDocumentRequired(signer.role as SignerRole),
      provided: !!currentId,
      details: detailed
        ? mine.map((d): SignerIdDocumentDto => ({
            id: d.id,
            documentType: d.documentType as IdDocumentType,
            contentType: d.contentType,
            sizeBytes: d.sizeBytes,
            sha256: d.sha256,
            uploadedAt: d.uploadedAt.toISOString(),
            current: d.id === currentId,
          }))
        : null,
    };
  }

  /**
   * One stored document, decrypted and checked, for a holder of `contracts.view_signer_id`.
   * Every successful view is audited BEFORE the bytes are returned.
   */
  async view(ctx: TenantContext, c: LoadedContract, documentId: string) {
    if (!this.canView(ctx, c)) throw Errors.forbidden();
    const [doc] = await this.db
      .select({ d: signerIdDocuments })
      .from(signerIdDocuments)
      .innerJoin(signingRounds, eq(signingRounds.id, signerIdDocuments.roundId))
      .where(
        and(
          eq(signerIdDocuments.id, documentId),
          eq(signerIdDocuments.organizationId, ctx.organizationId),
          eq(signingRounds.contractId, c.row.id),
        ),
      );
    if (!doc) throw Errors.notFound('Identity document');
    const d = doc.d;
    const file = await this.files.get(ctx.organizationId, d.fileId);
    if (!file || file.kind !== ID_DOCUMENT_FILE_KIND) throw Errors.notFound('Identity document');
    let plain: Buffer;
    try {
      plain = this.open(file.data, ctx.organizationId, d.id);
    } catch {
      this.logger.error(`Identity document ${d.id} could not be decrypted`);
      throw new AppError('internal_error', 500, 'The stored document could not be read');
    }
    if (sha256Hex(plain) !== d.sha256) {
      this.logger.error(`Integrity check failed for identity document ${d.id}`);
      throw new AppError('internal_error', 500, 'The stored document failed its integrity check');
    }
    await this.audit.fromCtx(
      ctx,
      'contract.signer_id_viewed',
      { type: 'contract', id: c.row.id },
      {
        number: c.row.number,
        roundId: d.roundId,
        signerId: d.signerId,
        documentId: d.id,
        documentType: d.documentType,
        sha256: d.sha256,
      },
    );
    const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[d.contentType];
    return {
      data: plain,
      contentType: d.contentType,
      sha256: d.sha256,
      filename: `${c.row.number}-id-document.${ext ?? 'pdf'}`,
    };
  }
}
