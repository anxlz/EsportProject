/**
 * Platform-admin (super-admin) endpoints: cross-tenant, read-only in Phase 1. Every access is
 * audited against the organization being looked at, so tenants can later be shown who from the
 * platform viewed their data.
 */
import { Controller, Get, Inject, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { auditLogQuerySchema, type PlatformOrganizationDto } from '@esports/shared';
import { eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { type AuthContext, Ctx, PlatformAdminOnly } from '../authz/context';
import { Errors } from '../common/errors';
import { UuidPipe, ZodQuery } from '../common/zod';
import { DB, type Database } from '../db/client';
import { organizations } from '../db/schema';
import { MembersService } from '../members/members.service';

@ApiTags('platform')
@Controller('platform')
@PlatformAdminOnly()
export class PlatformController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly members: MembersService,
  ) {}

  @Get('organizations')
  async list(): Promise<PlatformOrganizationDto[]> {
    const rows = await this.db.execute<{
      id: string;
      name: string;
      slug: string;
      created_at: Date;
      member_count: number;
      active_member_count: number;
      owner_emails: string[] | null;
    }>(sql`
      select o.id, o.name, o.slug, o.created_at,
        (select count(*)::int from app.organization_members m where m.organization_id = o.id) as member_count,
        (select count(*)::int from app.organization_members m where m.organization_id = o.id and m.status = 'active') as active_member_count,
        (select array_agg(u.email order by u.email) from app.user_role_assignments a
           join app.roles r on r.id = a.role_id and r.grants_all
           join app.users u on u.id = a.user_id
          where a.organization_id = o.id) as owner_emails
      from app.organizations o
      order by o.created_at asc
    `);
    return [...rows].map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      createdAt: new Date(r.created_at).toISOString(),
      memberCount: r.member_count,
      activeMemberCount: r.active_member_count,
      ownerEmails: r.owner_emails ?? [],
    }));
  }

  @Get('organizations/:id/members')
  async listMembers(@Ctx() ctx: AuthContext, @Param('id', UuidPipe) id: string) {
    const [org] = await this.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, id));
    if (!org) throw Errors.notFound('Organization');
    await this.audit.log({
      organizationId: id,
      actorUserId: ctx.user.id,
      actorType: 'platform_admin',
      action: 'platform.members_viewed',
      targetType: 'organization',
      targetId: id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return this.members.list(id);
  }

  @Get('organizations/:id/audit-logs')
  async auditLogs(
    @Ctx() ctx: AuthContext,
    @Param('id', UuidPipe) id: string,
    @ZodQuery(auditLogQuerySchema) q: z.infer<typeof auditLogQuerySchema>,
  ) {
    const [org] = await this.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, id));
    if (!org) throw Errors.notFound('Organization');
    await this.audit.log({
      organizationId: id,
      actorUserId: ctx.user.id,
      actorType: 'platform_admin',
      action: 'platform.audit_viewed',
      targetType: 'organization',
      targetId: id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return this.audit.list(id, q);
  }
}

