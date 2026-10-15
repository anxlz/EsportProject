import { Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type DepartmentDto, departmentInputSchema } from '@esports/shared';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { AccessService } from '../authz/access.service';
import { RequirePermission, type TenantContext, TenantCtx } from '../authz/context';
import { Errors } from '../common/errors';
import { UuidPipe, ZodBody } from '../common/zod';
import { DB, type Database } from '../db/client';
import { departments, teams } from '../db/schema';

type DepartmentInput = z.infer<typeof departmentInputSchema>;

/** Departments are organization structure; their permissions are organization-level. */
@ApiTags('departments')
@Controller('departments')
export class DepartmentsController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly access: AccessService,
  ) {}

  private async listFor(organizationId: string, id?: string): Promise<DepartmentDto[]> {
    const rows = await this.db
      .select({ d: departments, teamCount: count(teams.id) })
      .from(departments)
      .leftJoin(teams, eq(teams.departmentId, departments.id))
      .where(and(eq(departments.organizationId, organizationId), id ? eq(departments.id, id) : undefined))
      .groupBy(departments.id)
      .orderBy(asc(departments.name));
    return rows.map(({ d, teamCount }) => ({
      id: d.id,
      name: d.name,
      description: d.description,
      teamCount,
      createdAt: d.createdAt.toISOString(),
    }));
  }

  private async getOne(organizationId: string, id: string): Promise<DepartmentDto> {
    const [d] = await this.listFor(organizationId, id);
    if (!d) throw Errors.notFound('Department');
    return d;
  }

  private async assertNameFree(organizationId: string, name: string, exceptId?: string) {
    const [clash] = await this.db
      .select({ id: departments.id })
      .from(departments)
      .where(and(eq(departments.organizationId, organizationId), sql`lower(${departments.name}) = lower(${name})`));
    if (clash && clash.id !== exceptId) throw Errors.conflict('conflict', 'A department with this name exists');
  }

  @Get()
  @RequirePermission('departments.view')
  list(@TenantCtx() ctx: TenantContext) {
    return this.listFor(ctx.organizationId);
  }

  @Post()
  @RequirePermission('departments.create')
  async create(@TenantCtx() ctx: TenantContext, @ZodBody(departmentInputSchema) body: DepartmentInput) {
    await this.assertNameFree(ctx.organizationId, body.name);
    const id = await this.db.transaction(async (tx) => {
      const [d] = await tx
        .insert(departments)
        .values({ organizationId: ctx.organizationId, name: body.name, description: body.description ?? null })
        .returning({ id: departments.id });
      await this.audit.fromCtx(ctx, 'department.created', { type: 'department', id: d!.id }, { name: body.name }, tx);
      return d!.id;
    });
    return this.getOne(ctx.organizationId, id);
  }

  @Patch(':id')
  @RequirePermission('departments.edit')
  async update(
    @TenantCtx() ctx: TenantContext,
    @Param('id', UuidPipe) id: string,
    @ZodBody(departmentInputSchema) body: DepartmentInput,
  ) {
    const before = await this.getOne(ctx.organizationId, id);
    await this.assertNameFree(ctx.organizationId, body.name, id);
    await this.db.transaction(async (tx) => {
      await tx
        .update(departments)
        .set({ name: body.name, description: body.description ?? null, updatedAt: new Date() })
        .where(and(eq(departments.id, id), eq(departments.organizationId, ctx.organizationId)));
      await this.audit.fromCtx(ctx, 'department.updated', { type: 'department', id }, {
        before: { name: before.name },
        after: { name: body.name },
      }, tx);
    });
    return this.getOne(ctx.organizationId, id);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('departments.delete')
  async remove(@TenantCtx() ctx: TenantContext, @Param('id', UuidPipe) id: string) {
    const d = await this.getOne(ctx.organizationId, id);
    if (d.teamCount > 0) throw Errors.conflict('department_not_empty', 'Move or delete its teams first');
    await this.db.transaction(async (tx) => {
      // Department-scoped role assignments cascade away with it (FK on delete cascade).
      await tx.delete(departments).where(and(eq(departments.id, id), eq(departments.organizationId, ctx.organizationId)));
      await this.audit.fromCtx(ctx, 'department.deleted', { type: 'department', id }, { name: d.name }, tx);
    });
    await this.access.invalidate(ctx.organizationId);
  }
}
