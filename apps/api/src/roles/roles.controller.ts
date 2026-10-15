import { Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type RoleInput, roleInputSchema } from '@esports/shared';
import { RequirePermission, type TenantContext, TenantCtx } from '../authz/context';
import { UuidPipe, ZodBody } from '../common/zod';
import { RolesService } from './roles.service';

@ApiTags('roles')
@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @RequirePermission('roles.view')
  list(@TenantCtx() ctx: TenantContext) {
    return this.roles.list(ctx.organizationId);
  }

  @Get(':id')
  @RequirePermission('roles.view')
  get(@TenantCtx() ctx: TenantContext, @Param('id', UuidPipe) id: string) {
    return this.roles.get(ctx.organizationId, id);
  }

  @Post()
  @RequirePermission('roles.manage')
  create(@TenantCtx() ctx: TenantContext, @ZodBody(roleInputSchema) body: RoleInput) {
    return this.roles.create(ctx, body);
  }

  @Put(':id')
  @RequirePermission('roles.manage')
  update(
    @TenantCtx() ctx: TenantContext,
    @Param('id', UuidPipe) id: string,
    @ZodBody(roleInputSchema) body: RoleInput,
  ) {
    return this.roles.update(ctx, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('roles.manage')
  remove(@TenantCtx() ctx: TenantContext, @Param('id', UuidPipe) id: string) {
    return this.roles.remove(ctx, id);
  }
}
