import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { auditLogQuerySchema } from '@esports/shared';
import type { z } from 'zod';
import { RequirePermission, type TenantContext, TenantCtx } from '../authz/context.js';
import { ZodQuery } from '../common/zod.js';
import { AuditService } from './audit.service.js';

@ApiTags('audit')
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermission('audit.view')
  list(
    @TenantCtx() ctx: TenantContext,
    @ZodQuery(auditLogQuerySchema) q: z.infer<typeof auditLogQuerySchema>,
  ) {
    return this.audit.list(ctx.organizationId, q);
  }
}
