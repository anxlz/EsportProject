/**
 * Organization legal details, the contract document layout and the approval stamp (spec §7.1,
 * §7.6). One row per organization; defaults apply until the Owner saves.
 *
 * - Layout and letterhead: `contracts.manage_templates` (Owner-only).
 * - Approval stamp: `org.settings.edit_sensitive` (Owner-only) — "Owner configures the
 *   approval-stamp image via settings".
 * File ids are checked to be uploads of the right kind in the same organization.
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  type DocumentSettingsDto,
  type DocumentSettingsInput,
  documentSettingsSchema,
  type StampSettingsInput,
  stampSettingsSchema,
} from '@esports/shared';
import { eq } from 'drizzle-orm';
import type { TenantContext } from '../authz/context';
import { AuditService } from '../audit/audit.service';
import { Errors } from '../common/errors';
import { DB, type Database, type DbOrTx } from '../db/client';
import { organizations } from '../db/schema';
import { documentSettings } from '../db/schema-contracts';
import { FilesService } from '../files/files.service';
import type { DocumentAssets } from './contract-document';

const LAYOUT_DEFAULTS = documentSettingsSchema.parse({});
const STAMP_DEFAULTS = stampSettingsSchema.parse({});

@Injectable()
export class DocumentSettingsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly files: FilesService,
    private readonly audit: AuditService,
  ) {}

  async get(organizationId: string, db: DbOrTx = this.db): Promise<DocumentSettingsDto> {
    const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, organizationId));
    if (!org) throw Errors.notFound('Organization');
    const [row] = await db.select().from(documentSettings).where(eq(documentSettings.organizationId, organizationId));
    const base: DocumentSettingsDto = {
      organizationName: org.name,
      legalNameEn: null,
      legalNameAr: null,
      commercialRegistration: null,
      taxNumber: null,
      addressEn: null,
      addressAr: null,
      email: null,
      phone: null,
      website: null,
      headerTextEn: null,
      headerTextAr: null,
      footerTextEn: null,
      footerTextAr: null,
      logoFileId: null,
      logoPosition: LAYOUT_DEFAULTS.logoPosition,
      backgroundKind: LAYOUT_DEFAULTS.backgroundKind,
      backgroundFileId: null,
      marginTopMm: LAYOUT_DEFAULTS.marginTopMm,
      marginBottomMm: LAYOUT_DEFAULTS.marginBottomMm,
      marginStartMm: LAYOUT_DEFAULTS.marginStartMm,
      marginEndMm: LAYOUT_DEFAULTS.marginEndMm,
      pageBorder: LAYOUT_DEFAULTS.pageBorder,
      fontSizePt: LAYOUT_DEFAULTS.fontSizePt,
      lineHeight: LAYOUT_DEFAULTS.lineHeight,
      defaultLanguage: LAYOUT_DEFAULTS.defaultLanguage,
      stampFileId: null,
      stampPosition: STAMP_DEFAULTS.stampPosition,
      stampWidthMm: STAMP_DEFAULTS.stampWidthMm,
    };
    if (!row) return base;
    const { organizationId: _o, updatedAt: _u, updatedByUserId: _b, ...rest } = row;
    return { ...base, ...(rest as Omit<DocumentSettingsDto, 'organizationName'>), organizationName: org.name };
  }

  /** Saves the layout and letterhead. A file must be an upload of the matching kind. */
  async update(ctx: TenantContext, input: DocumentSettingsInput): Promise<DocumentSettingsDto> {
    const before = await this.get(ctx.organizationId);
    if (input.logoFileId) await this.files.requireOfKind(this.db, ctx.organizationId, input.logoFileId, ['logo']);
    if (input.backgroundKind === 'none') input.backgroundFileId = null;
    else {
      if (!input.backgroundFileId) throw Errors.badRequest('validation_failed', 'Choose a background file');
      const f = await this.files.requireOfKind(this.db, ctx.organizationId, input.backgroundFileId, ['background']);
      const isPdf = f.contentType === 'application/pdf';
      if ((input.backgroundKind === 'pdf') !== isPdf) {
        throw Errors.badRequest('validation_failed', 'The background file does not match the background type');
      }
    }
    const values = {
      legalNameEn: input.legalNameEn ?? null,
      legalNameAr: input.legalNameAr ?? null,
      commercialRegistration: input.commercialRegistration ?? null,
      taxNumber: input.taxNumber ?? null,
      addressEn: input.addressEn ?? null,
      addressAr: input.addressAr ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      website: input.website ?? null,
      headerTextEn: input.headerTextEn ?? null,
      headerTextAr: input.headerTextAr ?? null,
      footerTextEn: input.footerTextEn ?? null,
      footerTextAr: input.footerTextAr ?? null,
      logoFileId: input.logoFileId ?? null,
      logoPosition: input.logoPosition,
      backgroundKind: input.backgroundKind,
      backgroundFileId: input.backgroundFileId ?? null,
      marginTopMm: input.marginTopMm,
      marginBottomMm: input.marginBottomMm,
      marginStartMm: input.marginStartMm,
      marginEndMm: input.marginEndMm,
      pageBorder: input.pageBorder,
      fontSizePt: input.fontSizePt,
      lineHeight: input.lineHeight,
      defaultLanguage: input.defaultLanguage,
      updatedByUserId: ctx.user.id,
      updatedAt: new Date(),
    };
    await this.db.transaction(async (tx) => {
      await tx
        .insert(documentSettings)
        .values({ organizationId: ctx.organizationId, ...values })
        .onConflictDoUpdate({ target: documentSettings.organizationId, set: values });
      await this.audit.fromCtx(ctx, 'document_settings.updated', { type: 'organization', id: ctx.organizationId }, {
        changes: diff(before, { ...before, ...values }),
      }, tx);
    });
    return this.get(ctx.organizationId);
  }

  async updateStamp(ctx: TenantContext, input: StampSettingsInput): Promise<DocumentSettingsDto> {
    const before = await this.get(ctx.organizationId);
    if (input.stampFileId) await this.files.requireOfKind(this.db, ctx.organizationId, input.stampFileId, ['stamp']);
    const values = {
      stampFileId: input.stampFileId ?? null,
      stampPosition: input.stampPosition,
      stampWidthMm: input.stampWidthMm,
      updatedByUserId: ctx.user.id,
      updatedAt: new Date(),
    };
    await this.db.transaction(async (tx) => {
      await tx
        .insert(documentSettings)
        .values({ organizationId: ctx.organizationId, ...values })
        .onConflictDoUpdate({ target: documentSettings.organizationId, set: values });
      await this.audit.fromCtx(ctx, 'approval_stamp.updated', { type: 'organization', id: ctx.organizationId }, {
        changes: diff(before, { ...before, ...values }),
      }, tx);
    });
    return this.get(ctx.organizationId);
  }

  /** Logo and stamp bytes for rendering, plus the background for the PDF underlay. */
  async assets(organizationId: string, s: DocumentSettingsDto, db: DbOrTx = this.db) {
    const load = async (id: string | null) => {
      if (!id) return null;
      const f = await this.files.get(organizationId, id, db);
      return f ? { data: f.data, contentType: f.contentType } : null;
    };
    const [logo, stamp, background] = await Promise.all([
      load(s.logoFileId),
      load(s.stampFileId),
      s.backgroundKind === 'none' ? Promise.resolve(null) : load(s.backgroundFileId),
    ]);
    return { assets: { logo, stamp } satisfies DocumentAssets, background };
  }
}

/** Changed keys with before/after values (file ids, not contents). */
function diff(before: DocumentSettingsDto, after: Record<string, unknown>) {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const [k, v] of Object.entries(after)) {
    if (k === 'updatedAt' || k === 'updatedByUserId' || k === 'organizationName') continue;
    const was = (before as unknown as Record<string, unknown>)[k];
    if (was !== v) out[k] = { from: was ?? null, to: v ?? null };
  }
  return out;
}
