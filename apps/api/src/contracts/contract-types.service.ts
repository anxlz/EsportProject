/**
 * Contract types and their clause templates (spec §7.2, §7.3).
 *
 * - Four system types (player, coach, manager, staff) are seeded for every organization — at
 *   signup for new ones, and on first use for organizations created before Phase 3. They can be
 *   renamed and their templates edited, but not archived.
 * - Owners can add custom types. A custom type used by a contract is archived, not deleted.
 * - Template editing is Owner-only (`contracts.manage_templates`). Editing a template affects
 *   future contracts only: every contract keeps its own copy of the clauses.
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  type ContractTypeDto,
  type ContractTypeInput,
  DEFAULT_CONTRACT_TYPES,
  type TemplateClauseDto,
  type TemplateClausesInput,
} from '@esports/shared';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import type { TenantContext } from '../authz/context';
import { AuditService } from '../audit/audit.service';
import { Errors } from '../common/errors';
import { DB, type Database, type DbOrTx } from '../db/client';
import { contracts, contractTypes, templateClauses } from '../db/schema-contracts';

/** Seeds the system contract types with their default templates (idempotent). */
export async function seedContractTypes(tx: DbOrTx, organizationId: string, userId: string | null) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`contract-types:${organizationId}`}))`);
  const existing = await tx
    .select({ key: contractTypes.key })
    .from(contractTypes)
    .where(and(eq(contractTypes.organizationId, organizationId), eq(contractTypes.isSystem, true)));
  const have = new Set(existing.map((e) => e.key));
  for (const t of DEFAULT_CONTRACT_TYPES) {
    if (have.has(t.key)) continue;
    const [row] = await tx
      .insert(contractTypes)
      .values({ organizationId, key: t.key, isSystem: true, nameEn: t.nameEn, nameAr: t.nameAr, createdByUserId: userId })
      .returning({ id: contractTypes.id });
    await tx.insert(templateClauses).values(
      t.clauses.map((c, i) => ({
        organizationId,
        contractTypeId: row!.id,
        position: i,
        required: c.required,
        titleEn: c.titleEn,
        titleAr: c.titleAr,
        bodyEn: c.bodyEn,
        bodyAr: c.bodyAr,
      })),
    );
  }
}

@Injectable()
export class ContractTypesService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  /** Organizations created before Phase 3 get the defaults the first time they open contracts. */
  async ensureDefaults(ctx: TenantContext) {
    const [row] = await this.db
      .select({ n: count() })
      .from(contractTypes)
      .where(and(eq(contractTypes.organizationId, ctx.organizationId), eq(contractTypes.isSystem, true)));
    if ((row?.n ?? 0) >= DEFAULT_CONTRACT_TYPES.length) return;
    await this.db.transaction((tx) => seedContractTypes(tx, ctx.organizationId, null));
  }

  async list(ctx: TenantContext): Promise<ContractTypeDto[]> {
    await this.ensureDefaults(ctx);
    const rows = await this.db
      .select()
      .from(contractTypes)
      .where(eq(contractTypes.organizationId, ctx.organizationId))
      .orderBy(sql`${contractTypes.isSystem} desc`, asc(contractTypes.createdAt));
    const counts = await this.db
      .select({ typeId: templateClauses.contractTypeId, n: count() })
      .from(templateClauses)
      .where(eq(templateClauses.organizationId, ctx.organizationId))
      .groupBy(templateClauses.contractTypeId);
    const countOf = new Map(counts.map((c) => [c.typeId, c.n]));
    const order = DEFAULT_CONTRACT_TYPES.map((d) => d.key as string);
    return rows
      .map((t) => this.toDto(t, countOf.get(t.id) ?? 0))
      .sort((a, b) => (a.isSystem && b.isSystem ? order.indexOf(a.key!) - order.indexOf(b.key!) : 0));
  }

  private toDto(t: typeof contractTypes.$inferSelect, clauseCount: number): ContractTypeDto {
    return {
      id: t.id,
      key: t.key,
      isSystem: t.isSystem,
      nameEn: t.nameEn,
      nameAr: t.nameAr,
      descriptionEn: t.descriptionEn,
      descriptionAr: t.descriptionAr,
      clauseCount,
      archived: !!t.archivedAt,
    };
  }

  async load(db: DbOrTx, organizationId: string, id: string) {
    const [t] = await db
      .select()
      .from(contractTypes)
      .where(and(eq(contractTypes.id, id), eq(contractTypes.organizationId, organizationId)));
    if (!t) throw Errors.notFound('Contract type');
    return t;
  }

  async clauses(organizationId: string, contractTypeId: string, db: DbOrTx = this.db): Promise<TemplateClauseDto[]> {
    const rows = await db
      .select()
      .from(templateClauses)
      .where(and(eq(templateClauses.organizationId, organizationId), eq(templateClauses.contractTypeId, contractTypeId)))
      .orderBy(asc(templateClauses.position));
    return rows.map((c) => ({
      id: c.id,
      position: c.position,
      required: c.required,
      titleEn: c.titleEn,
      titleAr: c.titleAr,
      bodyEn: c.bodyEn,
      bodyAr: c.bodyAr,
    }));
  }

  /** A type's template clauses (404 for another organization's type). */
  async template(ctx: TenantContext, id: string): Promise<TemplateClauseDto[]> {
    await this.load(this.db, ctx.organizationId, id);
    return this.clauses(ctx.organizationId, id);
  }

  async create(ctx: TenantContext, input: ContractTypeInput): Promise<ContractTypeDto> {
    const row = await this.db.transaction(async (tx) => {
      const [t] = await tx
        .insert(contractTypes)
        .values({ organizationId: ctx.organizationId, ...this.values(input), createdByUserId: ctx.user.id })
        .returning();
      await this.audit.fromCtx(ctx, 'contract_type.created', { type: 'contract_type', id: t!.id }, { ...input }, tx);
      return t!;
    });
    return this.toDto(row, 0);
  }

  private values(input: ContractTypeInput) {
    return {
      nameEn: input.nameEn,
      nameAr: input.nameAr,
      descriptionEn: input.descriptionEn ?? null,
      descriptionAr: input.descriptionAr ?? null,
    };
  }

  async update(ctx: TenantContext, id: string, input: ContractTypeInput): Promise<ContractTypeDto> {
    const before = await this.load(this.db, ctx.organizationId, id);
    await this.db.transaction(async (tx) => {
      await tx.update(contractTypes).set({ ...this.values(input), updatedAt: new Date() }).where(eq(contractTypes.id, id));
      await this.audit.fromCtx(ctx, 'contract_type.updated', { type: 'contract_type', id }, {
        before: { nameEn: before.nameEn, nameAr: before.nameAr },
        after: { nameEn: input.nameEn, nameAr: input.nameAr },
      }, tx);
    });
    return (await this.list(ctx)).find((t) => t.id === id)!;
  }

  /** Custom types only. Removed outright when unused; otherwise archived so history stays intact. */
  async remove(ctx: TenantContext, id: string): Promise<{ archived: boolean }> {
    const t = await this.load(this.db, ctx.organizationId, id);
    if (t.isSystem) throw Errors.badRequest('validation_failed', 'The default contract types cannot be removed');
    return this.db.transaction(async (tx) => {
      const [used] = await tx.select({ n: count() }).from(contracts).where(eq(contracts.contractTypeId, id));
      if ((used?.n ?? 0) > 0) {
        await tx.update(contractTypes).set({ archivedAt: new Date(), updatedAt: new Date() }).where(eq(contractTypes.id, id));
        await this.audit.fromCtx(ctx, 'contract_type.archived', { type: 'contract_type', id }, { nameEn: t.nameEn }, tx);
        return { archived: true };
      }
      await tx.delete(contractTypes).where(eq(contractTypes.id, id));
      await this.audit.fromCtx(ctx, 'contract_type.deleted', { type: 'contract_type', id }, { nameEn: t.nameEn }, tx);
      return { archived: false };
    });
  }

  async restore(ctx: TenantContext, id: string) {
    await this.load(this.db, ctx.organizationId, id);
    await this.db.update(contractTypes).set({ archivedAt: null, updatedAt: new Date() }).where(eq(contractTypes.id, id));
    await this.audit.fromCtx(ctx, 'contract_type.restored', { type: 'contract_type', id });
  }

  /**
   * Replaces the template's ordered clause list. Existing clause ids are kept (so contracts can
   * tell which template clause they came from); new ones get fresh ids; missing ones are removed.
   */
  async replaceClauses(ctx: TenantContext, id: string, input: TemplateClausesInput): Promise<TemplateClauseDto[]> {
    await this.load(this.db, ctx.organizationId, id);
    const before = await this.clauses(ctx.organizationId, id);
    await this.db.transaction(async (tx) => {
      const keep = new Set(input.clauses.map((c) => c.id).filter((x): x is string => !!x));
      for (const old of before) if (!keep.has(old.id)) await tx.delete(templateClauses).where(eq(templateClauses.id, old.id));
      for (const [i, c] of input.clauses.entries()) {
        const values = { position: i, required: c.required, titleEn: c.titleEn, titleAr: c.titleAr, bodyEn: c.bodyEn, bodyAr: c.bodyAr };
        if (c.id && before.some((b) => b.id === c.id)) {
          await tx.update(templateClauses).set({ ...values, updatedAt: new Date() }).where(eq(templateClauses.id, c.id));
        } else {
          await tx.insert(templateClauses).values({ organizationId: ctx.organizationId, contractTypeId: id, ...values });
        }
      }
      await this.audit.fromCtx(ctx, 'contract_type.template_updated', { type: 'contract_type', id }, {
        before: before.map((c) => ({ id: c.id, required: c.required, titleEn: c.titleEn })),
        after: input.clauses.map((c) => ({ id: c.id ?? null, required: c.required, titleEn: c.titleEn })),
      }, tx);
    });
    return this.clauses(ctx.organizationId, id);
  }
}
