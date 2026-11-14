import { Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { setAssignmentsSchema, suspendMemberSchema } from '@esports/shared';
import type { z } from 'zod';
import { RequirePermission, type TenantContext, TenantCtx } from '../authz/context.js';
import { UuidPipe, ZodBody } from '../common/zod.js';
import { MembersService } from './members.service.js';

@ApiTags('members')
@Controller('members')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get()
  @RequirePermission('members.view')
  list(@TenantCtx() ctx: TenantContext) {
    return this.members.list(ctx.organizationId);
  }

  @Get(':userId')
  @RequirePermission('members.view')
  get(@TenantCtx() ctx: TenantContext, @Param('userId', UuidPipe) userId: string) {
    return this.members.get(ctx.organizationId, userId);
  }

  @Put(':userId/assignments')
  @RequirePermission('members.manage')
  setAssignments(
    @TenantCtx() ctx: TenantContext,
    @Param('userId', UuidPipe) userId: string,
    @ZodBody(setAssignmentsSchema) body: z.infer<typeof setAssignmentsSchema>,
  ) {
    return this.members.setAssignments(ctx, userId, body.assignments);
  }

  @Post(':userId/suspend')
  @HttpCode(200)
  @RequirePermission('members.manage')
  suspend(
    @TenantCtx() ctx: TenantContext,
    @Param('userId', UuidPipe) userId: string,
    @ZodBody(suspendMemberSchema) body: z.infer<typeof suspendMemberSchema>,
  ) {
    return this.members.suspend(ctx, userId, body.reason);
  }

  @Post(':userId/reactivate')
  @HttpCode(200)
  @RequirePermission('members.manage')
  reactivate(@TenantCtx() ctx: TenantContext, @Param('userId', UuidPipe) userId: string) {
    return this.members.reactivate(ctx, userId);
  }

  @Post(':userId/ownership')
  @HttpCode(200)
  @RequirePermission('org.ownership.manage')
  grantOwnership(@TenantCtx() ctx: TenantContext, @Param('userId', UuidPipe) userId: string) {
    return this.members.grantOwnership(ctx, userId);
  }

  @Delete(':userId/ownership')
  @RequirePermission('org.ownership.manage')
  revokeOwnership(@TenantCtx() ctx: TenantContext, @Param('userId', UuidPipe) userId: string) {
    return this.members.revokeOwnership(ctx, userId);
  }
}
