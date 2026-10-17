import { Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  type ContractTypeInput,
  contractTypeInputSchema,
  type PermissionKey,
  type TemplateClausesInput,
  templateClausesSchema,
} from '@esports/shared';
import { RequireOrg, RequirePermission, type TenantContext, TenantCtx } from '../authz/context';
import { Errors } from '../common/errors';
import { UuidPipe, ZodBody } from '../common/zod';
import { ContractTypesService } from './contract-types.service';

/** Anyone working with contracts can read the types and templates they draft from. */
const READ_ANY: PermissionKey[] = [
  'contracts.view',
  'contracts.create',
  'contracts.edit',
  'contracts.approve',
  'contracts.manage_templates',
];
const requireAny = (ctx: TenantContext, perms: PermissionKey[]) => {
  if (!perms.some((p) => ctx.access.has(p))) throw Errors.forbidden();
};

@ApiTags('contracts')
@Controller('contract-types')
export class ContractTypesController {
  constructor(private readonly types: ContractTypesService) {}

  @Get()
  @RequireOrg()
  list(@TenantCtx() ctx: TenantContext) {
    requireAny(ctx, READ_ANY);
    return this.types.list(ctx);
  }

  /** Template editing is Owner-only (spec §7.3). */
  @Post()
  @RequirePermission('contracts.manage_templates')
  create(
    @TenantCtx() ctx: TenantContext,
    @ZodBody(contractTypeInputSchema) body: ContractTypeInput,
  ) {
    return this.types.create(ctx, body);
  }

  @Patch(':id')
  @RequirePermission('contracts.manage_templates')
  update(
    @TenantCtx() ctx: TenantContext,
    @Param('id', UuidPipe) id: string,
    @ZodBody(contractTypeInputSchema) body: ContractTypeInput,
  ) {
    return this.types.update(ctx, id, body);
  }

  @Delete(':id')
  @RequirePermission('contracts.manage_templates')
  remove(@TenantCtx() ctx: TenantContext, @Param('id', UuidPipe) id: string) {
    return this.types.remove(ctx, id);
  }

  @Post(':id/restore')
  @HttpCode(204)
  @RequirePermission('contracts.manage_templates')
  async restore(@TenantCtx() ctx: TenantContext, @Param('id', UuidPipe) id: string) {
    await this.types.restore(ctx, id);
  }

  @Get(':id/clauses')
  @RequireOrg()
  clauses(@TenantCtx() ctx: TenantContext, @Param('id', UuidPipe) id: string) {
    requireAny(ctx, READ_ANY);
    return this.types.template(ctx, id);
  }

  @Put(':id/clauses')
  @RequirePermission('contracts.manage_templates')
  replaceClauses(
    @TenantCtx() ctx: TenantContext,
    @Param('id', UuidPipe) id: string,
    @ZodBody(templateClausesSchema) body: TemplateClausesInput,
  ) {
    return this.types.replaceClauses(ctx, id, body);
  }
}

export { requireAny, READ_ANY };
