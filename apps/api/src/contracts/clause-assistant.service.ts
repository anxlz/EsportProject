/**
 * Custom Clause Assistant (spec §7.4): understand the purpose → draft a clause → list missing or
 * ambiguous details → show the proposal → revise → accept or reject.
 *
 * Rules enforced here:
 * - Proposal only. Generating, revising or rejecting a proposal never touches the contract.
 *   Accepting is a separate, explicit request that inserts exactly that one clause as a new
 *   version; no other clause changes (tested).
 * - The model receives no personal data: no names, ID numbers, contact details or amounts. It
 *   sees the contract type, the document language, existing clause titles and the merge fields,
 *   and is told to use `{{merge fields}}` for specifics.
 * - It is told never to describe a clause as legally valid or enforceable; the UI shows a
 *   non-legal-advice caveat next to every proposal regardless.
 * - Same permissions as editing the contract, plus a per-user rate limit.
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  type AssistantStatusDto,
  type ClauseProposalDto,
  type ClauseProposalRequest,
  type ContractSnapshot,
  type ContractStatus,
  EDITABLE_STATUSES,
  MERGE_FIELDS,
} from '@esports/shared';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AI_PROVIDER, type AiProvider } from '../ai/ai.provider';
import type { TenantContext } from '../authz/context';
import { AuditService } from '../audit/audit.service';
import { AppError, Errors } from '../common/errors';
import { RateLimitService } from '../common/rate-limit';
import { DB, type Database } from '../db/client';
import { clauseProposals } from '../db/schema-contracts';
import { VersioningService } from '../versioning/versioning.service';
import { CONTRACT_ENTITY, ContractsService } from './contracts.service';

const PROPOSALS_PER_HOUR = 30;

const outputSchema = z.object({
  titleEn: z.string().trim().min(1).max(200),
  titleAr: z.string().trim().min(1).max(200),
  bodyEn: z.string().trim().min(1).max(8000),
  bodyAr: z.string().trim().min(1).max(8000),
  questions: z.array(z.string().trim().min(1).max(500)).max(10),
  notes: z.string().trim().max(1000),
});
type ProposalOutput = z.infer<typeof outputSchema>;
type ClauseText = Pick<ProposalOutput, 'titleEn' | 'titleAr' | 'bodyEn' | 'bodyAr'>;

/** Structured-output schema sent to the provider (no length constraints: validated above). */
const JSON_SCHEMA = {
  type: 'object',
  properties: {
    titleEn: { type: 'string', description: 'Short clause heading in English.' },
    titleAr: { type: 'string', description: 'The same heading in Modern Standard Arabic.' },
    bodyEn: {
      type: 'string',
      description: 'The clause text in English, plain text, paragraphs separated by blank lines.',
    },
    bodyAr: {
      type: 'string',
      description: 'The same clause in Modern Standard Arabic, equivalent in meaning to bodyEn.',
    },
    questions: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Details that are missing or ambiguous and that the user should supply or confirm, in the language of the request. Empty if none.',
    },
    notes: {
      type: 'string',
      description:
        'One or two sentences on what the draft assumes. Empty string if nothing to add.',
    },
  },
  required: ['titleEn', 'titleAr', 'bodyEn', 'bodyAr', 'questions', 'notes'],
  additionalProperties: false,
} as const;

const SYSTEM = `You draft one clause at a time for employment-style contracts used by an esports organization (players, coaches, managers, staff). The user describes what the clause should achieve; you return a draft for a human to review.

Rules:
- Draft exactly one clause, in both English and Modern Standard Arabic, with the same meaning in both.
- Use the placeholders listed under "Merge fields" (for example {{recipientName}}, {{startDate}}, {{salary}}) instead of inventing names, dates, amounts or other specifics. Never invent facts. If a needed detail has no placeholder and was not given, write a clear bracketed blank such as [number of days] / [عدد الأيام] and add a question about it.
- Do not repeat or contradict the clauses already in the contract (their titles are listed); if the request overlaps one of them, say so in a question.
- Never state or imply that the clause is legally valid, enforceable, compliant with any law or regulation, or approved by any authority. Do not cite laws or regulations. A qualified lawyer must review every clause; you may say so in notes.
- Plain text only: no Markdown, no numbering of the clause itself.
- Put anything the user must decide or confirm in "questions".`;

@Injectable()
export class ClauseAssistantService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(AI_PROVIDER) private readonly ai: AiProvider,
    private readonly contracts: ContractsService,
    private readonly versions: VersioningService,
    private readonly audit: AuditService,
    private readonly rateLimit: RateLimitService,
  ) {}

  status(): AssistantStatusDto {
    return {
      configured: this.ai.configured,
      provider: this.ai.configured ? this.ai.name : null,
      model: this.ai.model,
    };
  }

  private async editableContract(ctx: TenantContext, contractId: string) {
    const c = await this.contracts.loadVisible(ctx, contractId);
    if (!this.contracts.canEdit(ctx, c)) throw Errors.forbidden();
    if (!EDITABLE_STATUSES.includes(c.row.status as ContractStatus))
      throw Errors.conflict('contract_not_editable');
    return c;
  }

  private toDto(p: typeof clauseProposals.$inferSelect): ClauseProposalDto {
    return {
      id: p.id,
      contractId: p.contractId,
      purpose: p.purpose,
      feedback: p.feedback,
      revisionOf: p.revisionOf,
      status: p.status as ClauseProposalDto['status'],
      titleEn: p.output.titleEn,
      titleAr: p.output.titleAr,
      bodyEn: p.output.bodyEn,
      bodyAr: p.output.bodyAr,
      questions: p.output.questions,
      notes: p.output.notes,
      model: p.model,
      createdAt: p.createdAt.toISOString(),
    };
  }

  private async loadProposal(ctx: TenantContext, contractId: string, id: string) {
    const [p] = await this.db
      .select()
      .from(clauseProposals)
      .where(
        and(
          eq(clauseProposals.id, id),
          eq(clauseProposals.organizationId, ctx.organizationId),
          eq(clauseProposals.contractId, contractId),
        ),
      );
    if (!p) throw Errors.notFound('Proposal');
    return p;
  }

  async list(ctx: TenantContext, contractId: string): Promise<ClauseProposalDto[]> {
    await this.contracts.loadVisible(ctx, contractId);
    const rows = await this.db
      .select()
      .from(clauseProposals)
      .where(
        and(
          eq(clauseProposals.organizationId, ctx.organizationId),
          eq(clauseProposals.contractId, contractId),
        ),
      )
      .orderBy(desc(clauseProposals.createdAt))
      .limit(50);
    return rows.map((r) => this.toDto(r));
  }

  /** Builds the prompt from non-personal context only. */
  buildPrompt(
    snapshot: ContractSnapshot,
    input: ClauseProposalRequest,
    previous: ClauseText | null,
  ): string {
    const existing = snapshot.clauses
      .filter((c) => c.included)
      .map((c, i) => `${i + 1}. ${c.titleEn || '—'} / ${c.titleAr || '—'}`)
      .join('\n');
    const lines = [
      `Contract type: ${snapshot.typeNameEn} / ${snapshot.typeNameAr}`,
      `Recipient category: ${snapshot.details.recipient.kind}`,
      `Document language setting: ${snapshot.details.language}`,
      '',
      'Clauses already in the contract:',
      existing || '(none)',
      '',
      `Merge fields: ${MERGE_FIELDS.map((f) => `{{${f}}}`).join(', ')}`,
      '',
      'What the new clause should achieve (from the user):',
      input.purpose,
    ];
    if (previous) {
      lines.push(
        '',
        'Your previous draft (revise it):',
        JSON.stringify({
          titleEn: previous.titleEn,
          titleAr: previous.titleAr,
          bodyEn: previous.bodyEn,
          bodyAr: previous.bodyAr,
        }),
        '',
        "The user's feedback on that draft:",
        input.feedback || '(no specific feedback: improve clarity and fill gaps)',
      );
    }
    return lines.join('\n');
  }

  async propose(
    ctx: TenantContext,
    contractId: string,
    input: ClauseProposalRequest,
  ): Promise<ClauseProposalDto> {
    if (!this.ai.configured)
      throw new AppError(
        'ai_not_configured',
        503,
        'The AI assistant is not configured (ANTHROPIC_API_KEY is not set).',
      );
    await this.editableContract(ctx, contractId);
    let previous: ClauseText | null = null;
    if (input.revisionOf)
      previous = (await this.loadProposal(ctx, contractId, input.revisionOf)).output;
    const wait = await this.rateLimit.consume(
      `ai-clause:${ctx.organizationId}:${ctx.user.id}`,
      PROPOSALS_PER_HOUR,
      3600,
    );
    if (wait)
      throw new AppError(
        'rate_limited',
        429,
        `Too many assistant requests. Try again in ${Math.ceil(wait / 60)} minutes.`,
      );

    const latest = await this.versions.get<ContractSnapshot>(
      ctx.organizationId,
      CONTRACT_ENTITY,
      contractId,
    );
    const result = await this.ai.generateJson({
      system: SYSTEM,
      prompt: this.buildPrompt(latest!.snapshot, input, previous),
      schema: JSON_SCHEMA,
      maxTokens: 16000,
    });
    const parsed = outputSchema.safeParse(result.data);
    if (!parsed.success)
      throw new AppError(
        'ai_unavailable',
        502,
        'The assistant returned an incomplete proposal. Try again.',
      );

    const [row] = await this.db
      .insert(clauseProposals)
      .values({
        organizationId: ctx.organizationId,
        contractId,
        requestedByUserId: ctx.user.id,
        purpose: input.purpose,
        feedback: input.feedback ?? null,
        revisionOf: input.revisionOf ?? null,
        status: 'proposed',
        output: { ...parsed.data, notes: parsed.data.notes || null },
        provider: this.ai.name,
        model: result.model,
      })
      .returning();
    await this.audit.fromCtx(
      ctx,
      'contract.clause_proposed',
      { type: 'contract', id: contractId },
      {
        proposalId: row!.id,
        revisionOf: input.revisionOf ?? null,
        provider: this.ai.name,
        model: result.model,
      },
    );
    return this.toDto(row!);
  }

  /** The explicit acceptance step: inserts that one clause as a new contract version. */
  async accept(
    ctx: TenantContext,
    contractId: string,
    proposalId: string,
    beforeClauseId: string | null | undefined,
  ) {
    await this.editableContract(ctx, contractId);
    const result = await this.db.transaction(async (tx) => {
      const [p] = await tx
        .select()
        .from(clauseProposals)
        .where(
          and(
            eq(clauseProposals.id, proposalId),
            eq(clauseProposals.organizationId, ctx.organizationId),
            eq(clauseProposals.contractId, contractId),
          ),
        )
        .for('update');
      if (!p) throw Errors.notFound('Proposal');
      if (p.status !== 'proposed')
        throw Errors.conflict('contract_invalid_transition', 'This proposal was already decided');
      const added = await this.contracts.insertClause(
        ctx,
        tx,
        contractId,
        {
          source: 'assistant',
          titleEn: p.output.titleEn,
          titleAr: p.output.titleAr,
          bodyEn: p.output.bodyEn,
          bodyAr: p.output.bodyAr,
        },
        beforeClauseId,
        'Added a clause drafted with the assistant',
      );
      await tx
        .update(clauseProposals)
        .set({ status: 'accepted', decidedByUserId: ctx.user.id, decidedAt: new Date() })
        .where(eq(clauseProposals.id, p.id));
      await this.audit.fromCtx(
        ctx,
        'contract.clause_accepted',
        { type: 'contract', id: contractId },
        {
          number: added.number,
          proposalId: p.id,
          clauseId: added.clauseId,
          version: added.version,
          versionSha256: added.sha256,
        },
        tx,
      );
      return added;
    });
    return { clauseId: result.clauseId, contract: await this.contracts.get(ctx, contractId) };
  }

  async reject(
    ctx: TenantContext,
    contractId: string,
    proposalId: string,
  ): Promise<ClauseProposalDto> {
    await this.contracts.loadVisible(ctx, contractId);
    const p = await this.loadProposal(ctx, contractId, proposalId);
    if (p.requestedByUserId !== ctx.user.id) {
      const c = await this.contracts.loadVisible(ctx, contractId);
      if (!this.contracts.canEdit(ctx, c)) throw Errors.forbidden();
    }
    if (p.status !== 'proposed')
      throw Errors.conflict('contract_invalid_transition', 'This proposal was already decided');
    const [row] = await this.db
      .update(clauseProposals)
      .set({ status: 'rejected', decidedByUserId: ctx.user.id, decidedAt: new Date() })
      .where(eq(clauseProposals.id, p.id))
      .returning();
    await this.audit.fromCtx(
      ctx,
      'contract.clause_proposal_rejected',
      { type: 'contract', id: contractId },
      { proposalId: p.id },
    );
    return this.toDto(row!);
  }
}
