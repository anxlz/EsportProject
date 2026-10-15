import { Controller, Get, Inject, Patch } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { updateOrganizationSchema } from '@esports/shared';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { RequirePermission, type TenantContext, TenantCtx } from '../authz/context';
import { Errors } from '../common/errors';
import { ZodBody } from '../common/zod';
import { DB, type Database } from '../db/client';
import { organizations } from '../db/schema';

/** The active organization's general settings. Sensitive settings arrive in Phase 3. */
@ApiTags('organization')
@Controller('organization')
export class OrganizationController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  private async load(id: string) {
    const [org] = await this.db.select().from(organizations).where(eq(organizations.id, id));
    if (!org) throw Errors.notFound('Organization');
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      defaultLocale: org.defaultLocale,
      createdAt: org.createdAt.toISOString(),
    };
  }

  @Get()
  @RequirePermission('org.settings.view')
  get(@TenantCtx() ctx: TenantContext) {
    return this.load(ctx.organizationId);
  }

  @Patch()
  @RequirePermission('org.settings.edit')
  async update(
    @TenantCtx() ctx: TenantContext,
    @ZodBody(updateOrganizationSchema) body: z.infer<typeof updateOrganizationSchema>,
  ) {
    const before = await this.load(ctx.organizationId);
    await this.db.transaction(async (tx) => {
      await tx
        .update(organizations)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(organizations.id, ctx.organizationId));
      await this.audit.fromCtx(ctx, 'organization.updated', { type: 'organization', id: ctx.organizationId }, {
        before: { name: before.name, defaultLocale: before.defaultLocale },
        after: body,
      }, tx);
    });
    return this.load(ctx.organizationId);
  }
}
