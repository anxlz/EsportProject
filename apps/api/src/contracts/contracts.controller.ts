import { Controller, Get, HttpCode, Param, Post, Put, Res, StreamableFile } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  approvalDecisionSchema,
  type ClauseProposalRequest,
  clauseProposalAcceptSchema,
  clauseProposalRequestSchema,
  type ContractCreateInput,
  contractCreateSchema,
  contractListQuerySchema,
  type ContractSaveInput,
  contractSaveSchema,
  contractSubmitSchema,
  rejectionSchema,
} from '@esports/shared';
import type { Response } from 'express';
import { z } from 'zod';
import { RequireOrg, RequirePermission, type TenantContext, TenantCtx } from '../authz/context';
import { UuidPipe, ZodBody, ZodQuery } from '../common/zod';
import { ClauseAssistantService } from './clause-assistant.service';
import { READ_ANY, requireAny } from './contract-types.controller';
import { ContractsService } from './contracts.service';
import { asciiFilename, renderGuard, sendPreviewHtml } from './http';

const versionQuery = z.object({ version: z.coerce.number().int().min(1).optional() });
const SEE: Parameters<typeof requireAny>[1] = ['contracts.view', 'contracts.approve'];

@ApiTags('contracts')
@Controller('contracts')
export class ContractsController {
  constructor(
    private readonly contracts: ContractsService,
    private readonly assistant: ClauseAssistantService,
  ) {}

  // Static routes first so they never reach the :id routes.
  @Get('assistant-status')
  @RequireOrg()
  assistantStatus(@TenantCtx() ctx: TenantContext) {
    requireAny(ctx, READ_ANY);
    return this.assistant.status();
  }

  /** Views: all, drafts, approvals (pending), approved, signed (Phase 4). */
  @Get()
  @RequireOrg()
  list(
    @TenantCtx() ctx: TenantContext,
    @ZodQuery(contractListQuerySchema) q: z.infer<typeof contractListQuerySchema>,
  ) {
    requireAny(ctx, SEE);
    return this.contracts.list(ctx, q);
  }

  @Post()
  @RequirePermission('contracts.create')
  create(
    @TenantCtx() ctx: TenantContext,
    @ZodBody(contractCreateSchema) body: ContractCreateInput,
  ) {
    return this.contracts.create(ctx, body);
  }

  @Get(':id')
  @RequireOrg()
  get(@TenantCtx() ctx: TenantContext, @Param('id', UuidPipe) id: string) {
    requireAny(ctx, SEE);
    return this.contracts.get(ctx, id);
  }

  /** Saves the draft as a new version (no new version when nothing changed). */
  @Put(':id')
  @RequireOrg()
  save(
    @TenantCtx() ctx: TenantContext,
    @Param('id', UuidPipe) id: string,
    @ZodBody(contractSaveSchema) body: ContractSaveInput,
  ) {
    requireAny(ctx, ['contracts.create', 'contracts.edit']);
    return this.contracts.save(ctx, id, body);
  }

  @Get(':id/versions/:version')
  @RequireOrg()
  version(
    @TenantCtx() ctx: TenantContext,
    @Param('id', UuidPipe) id: string,
    @Param('version') version: string,
  ) {
    requireAny(ctx, SEE);
    return this.contracts.version(ctx, id, z.coerce.number().int().min(1).parse(version));
  }

  @Get(':id/preview')
  @RequireOrg()
  async preview(
    @TenantCtx() ctx: TenantContext,
    @Param('id', UuidPipe) id: string,
    @ZodQuery(versionQuery) q: z.infer<typeof versionQuery>,
    @Res() res: Response,
  ) {
    requireAny(ctx, SEE);
    sendPreviewHtml(res, await this.contracts.previewHtml(ctx, id, q.version));
  }

  /** PDF of the current (or given) version; drafts carry a "not approved" watermark. */
  @Get(':id/document.pdf')
  @RequirePermission('contracts.export')
  async document(
    @TenantCtx() ctx: TenantContext,
    @Param('id', UuidPipe) id: string,
    @ZodQuery(versionQuery) q: z.infer<typeof versionQuery>,
  ) {
    const { pdf, filename } = await renderGuard(() =>
      this.contracts.documentPdf(ctx, id, q.version),
    );
    return new StreamableFile(pdf, {
      type: 'application/pdf',
      disposition: `attachment; filename="${asciiFilename(filename)}"`,
    });
  }

  /** The stamped document exactly as stored at approval. */
  @Get(':id/approved.pdf')
  @RequirePermission('contracts.export')
  async approved(
    @TenantCtx() ctx: TenantContext,
    @Param('id', UuidPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { pdf, filename, sha256 } = await this.contracts.approvedPdf(ctx, id);
    res.set('X-Document-SHA256', sha256);
    return new StreamableFile(pdf, {
      type: 'application/pdf',
      disposition: `attachment; filename="${asciiFilename(filename)}"`,
    });
  }

  @Post(':id/submit')
  @HttpCode(200)
  @RequireOrg()
  submit(
    @TenantCtx() ctx: TenantContext,
    @Param('id', UuidPipe) id: string,
    @ZodBody(contractSubmitSchema) body: z.infer<typeof contractSubmitSchema>,
  ) {
    requireAny(ctx, ['contracts.create', 'contracts.edit']);
    return this.contracts.submit(ctx, id, body.note);
  }

  @Post(':id/withdraw')
  @HttpCode(200)
  @RequireOrg()
  withdraw(@TenantCtx() ctx: TenantContext, @Param('id', UuidPipe) id: string) {
    requireAny(ctx, ['contracts.create', 'contracts.edit']);
    return this.contracts.withdraw(ctx, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequireOrg()
  cancel(@TenantCtx() ctx: TenantContext, @Param('id', UuidPipe) id: string) {
    requireAny(ctx, ['contracts.create', 'contracts.edit']);
    return this.contracts.cancel(ctx, id);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermission('contracts.approve')
  approve(
    @TenantCtx() ctx: TenantContext,
    @Param('id', UuidPipe) id: string,
    @ZodBody(approvalDecisionSchema) body: z.infer<typeof approvalDecisionSchema>,
  ) {
    return this.contracts.approve(ctx, id, body.comment);
  }

  /** Rejection requires a reason (spec §7.6). */
  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermission('contracts.approve')
  reject(
    @TenantCtx() ctx: TenantContext,
    @Param('id', UuidPipe) id: string,
    @ZodBody(rejectionSchema) body: z.infer<typeof rejectionSchema>,
  ) {
    return this.contracts.reject(ctx, id, body.reason);
  }

  // ---------- Custom Clause Assistant

  @Get(':id/proposals')
  @RequireOrg()
  proposals(@TenantCtx() ctx: TenantContext, @Param('id', UuidPipe) id: string) {
    requireAny(ctx, SEE);
    return this.assistant.list(ctx, id);
  }

  /** Drafts (or revises) a clause. Proposal only: the contract is not changed. */
  @Post(':id/proposals')
  @RequireOrg()
  propose(
    @TenantCtx() ctx: TenantContext,
    @Param('id', UuidPipe) id: string,
    @ZodBody(clauseProposalRequestSchema) body: ClauseProposalRequest,
  ) {
    requireAny(ctx, ['contracts.create', 'contracts.edit']);
    return this.assistant.propose(ctx, id, body);
  }

  /** The explicit acceptance step that adds the clause (as a new version). */
  @Post(':id/proposals/:proposalId/accept')
  @HttpCode(200)
  @RequireOrg()
  accept(
    @TenantCtx() ctx: TenantContext,
    @Param('id', UuidPipe) id: string,
    @Param('proposalId', UuidPipe) proposalId: string,
    @ZodBody(clauseProposalAcceptSchema) body: z.infer<typeof clauseProposalAcceptSchema>,
  ) {
    requireAny(ctx, ['contracts.create', 'contracts.edit']);
    return this.assistant.accept(ctx, id, proposalId, body.beforeClauseId);
  }

  @Post(':id/proposals/:proposalId/reject')
  @HttpCode(200)
  @RequireOrg()
  rejectProposal(
    @TenantCtx() ctx: TenantContext,
    @Param('id', UuidPipe) id: string,
    @Param('proposalId', UuidPipe) proposalId: string,
  ) {
    requireAny(ctx, ['contracts.create', 'contracts.edit']);
    return this.assistant.reject(ctx, id, proposalId);
  }
}
