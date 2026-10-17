import { Controller, Get, Put, Res, StreamableFile } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  DOCUMENT_LANGUAGES,
  type DocumentSettingsInput,
  documentSettingsSchema,
  type StampSettingsInput,
  stampSettingsSchema,
} from '@esports/shared';
import type { Response } from 'express';
import { z } from 'zod';
import { RequireOrg, RequirePermission, type TenantContext, TenantCtx } from '../authz/context';
import { ZodBody, ZodQuery } from '../common/zod';
import { requireAny } from './contract-types.controller';
import { ContractsService } from './contracts.service';
import { DocumentSettingsService } from './document-settings.service';
import { renderGuard, sendPreviewHtml } from './http';

const sampleQuery = z.object({
  language: z.enum(DOCUMENT_LANGUAGES).default('bilingual'),
  approved: z.enum(['0', '1']).default('0'),
});

/** Document setup and the approval stamp (Owner-only). */
@ApiTags('contracts')
@Controller('contract-settings')
export class ContractSettingsController {
  constructor(
    private readonly settings: DocumentSettingsService,
    private readonly contracts: ContractsService,
  ) {}

  @Get()
  @RequireOrg()
  get(@TenantCtx() ctx: TenantContext) {
    requireAny(ctx, ['contracts.manage_templates', 'org.settings.edit_sensitive']);
    return this.settings.get(ctx.organizationId);
  }

  @Put('document')
  @RequirePermission('contracts.manage_templates')
  update(@TenantCtx() ctx: TenantContext, @ZodBody(documentSettingsSchema) body: DocumentSettingsInput) {
    return this.settings.update(ctx, body);
  }

  /** "Owner configures the approval-stamp image via settings" (spec §7.6). */
  @Put('stamp')
  @RequirePermission('org.settings.edit_sensitive')
  stamp(@TenantCtx() ctx: TenantContext, @ZodBody(stampSettingsSchema) body: StampSettingsInput) {
    return this.settings.updateStamp(ctx, body);
  }

  /** A sample contract in the current layout (HTML for the live preview). */
  @Get('sample.html')
  @RequireOrg()
  async sampleHtml(@TenantCtx() ctx: TenantContext, @ZodQuery(sampleQuery) q: z.infer<typeof sampleQuery>, @Res() res: Response) {
    requireAny(ctx, ['contracts.manage_templates', 'org.settings.edit_sensitive']);
    sendPreviewHtml(res, await this.contracts.sampleHtml(ctx, q.language, q.approved === '1'));
  }

  @Get('sample.pdf')
  @RequireOrg()
  async samplePdf(@TenantCtx() ctx: TenantContext, @ZodQuery(sampleQuery) q: z.infer<typeof sampleQuery>) {
    requireAny(ctx, ['contracts.manage_templates', 'org.settings.edit_sensitive']);
    const pdf = await renderGuard(() => this.contracts.samplePdf(ctx, q.language, q.approved === '1'));
    return new StreamableFile(pdf, { type: 'application/pdf', disposition: 'inline; filename="sample-contract.pdf"' });
  }
}
