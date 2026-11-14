import { Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type BudgetInput, budgetInputSchema } from '@esports/shared';
import { RequirePermission, type TenantContext, TenantCtx } from '../authz/context.js';
import { UuidPipe, ZodBody } from '../common/zod.js';
import { BudgetsService } from './budgets.service.js';

@ApiTags('finance')
@Controller('finance/budgets')
export class BudgetsController {
  constructor(private readonly budgets: BudgetsService) {}

  @Get()
  @RequirePermission('finance.view')
  list(@TenantCtx() ctx: TenantContext) {
    return this.budgets.list(ctx);
  }

  @Get(':id')
  @RequirePermission('finance.view')
  get(@TenantCtx() ctx: TenantContext, @Param('id', UuidPipe) id: string) {
    return this.budgets.get(ctx, id);
  }

  @Post()
  @RequirePermission('budgets.manage')
  create(@TenantCtx() ctx: TenantContext, @ZodBody(budgetInputSchema) body: BudgetInput) {
    return this.budgets.create(ctx, body);
  }

  @Patch(':id')
  @RequirePermission('budgets.manage')
  update(
    @TenantCtx() ctx: TenantContext,
    @Param('id', UuidPipe) id: string,
    @ZodBody(budgetInputSchema) body: BudgetInput,
  ) {
    return this.budgets.update(ctx, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('budgets.manage')
  remove(@TenantCtx() ctx: TenantContext, @Param('id', UuidPipe) id: string) {
    return this.budgets.remove(ctx, id);
  }
}
