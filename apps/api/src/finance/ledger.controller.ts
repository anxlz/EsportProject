import { Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  type ExpenseInput,
  expenseInputSchema,
  ledgerQuerySchema,
  type RevenueInput,
  revenueInputSchema,
} from '@esports/shared';
import { RequirePermission, type TenantContext, TenantCtx } from '../authz/context.js';
import { UuidPipe, ZodBody, ZodQuery } from '../common/zod.js';
import { type LedgerQuery, LedgerService } from './ledger.service.js';

/**
 * Costs and revenue. The decorators require the permission at some scope; the service then
 * checks that the scope covers the specific record's team (or organization level).
 * PATCH takes the full record (the form always sends every field).
 */
@ApiTags('finance')
@Controller('finance')
export class LedgerController {
  constructor(private readonly ledger: LedgerService) {}

  @Get('expenses')
  @RequirePermission('finance.view')
  listExpenses(@TenantCtx() ctx: TenantContext, @ZodQuery(ledgerQuerySchema) q: LedgerQuery) {
    return this.ledger.list(ctx, 'expense', q);
  }

  @Get('expenses/:id')
  @RequirePermission('finance.view')
  async getExpense(@TenantCtx() ctx: TenantContext, @Param('id', UuidPipe) id: string) {
    return (await this.ledger.getVisible(ctx, 'expense', id)).dto;
  }

  @Post('expenses')
  @RequirePermission('finance.create')
  createExpense(@TenantCtx() ctx: TenantContext, @ZodBody(expenseInputSchema) body: ExpenseInput) {
    return this.ledger.create(ctx, { ...body, kind: 'expense' });
  }

  @Patch('expenses/:id')
  @RequirePermission('finance.edit')
  updateExpense(
    @TenantCtx() ctx: TenantContext,
    @Param('id', UuidPipe) id: string,
    @ZodBody(expenseInputSchema) body: ExpenseInput,
  ) {
    return this.ledger.update(ctx, id, { ...body, kind: 'expense' });
  }

  @Delete('expenses/:id')
  @HttpCode(204)
  @RequirePermission('finance.delete')
  removeExpense(@TenantCtx() ctx: TenantContext, @Param('id', UuidPipe) id: string) {
    return this.ledger.remove(ctx, 'expense', id);
  }

  @Get('revenue')
  @RequirePermission('finance.view')
  listRevenue(@TenantCtx() ctx: TenantContext, @ZodQuery(ledgerQuerySchema) q: LedgerQuery) {
    return this.ledger.list(ctx, 'revenue', q);
  }

  @Get('revenue/:id')
  @RequirePermission('finance.view')
  async getRevenue(@TenantCtx() ctx: TenantContext, @Param('id', UuidPipe) id: string) {
    return (await this.ledger.getVisible(ctx, 'revenue', id)).dto;
  }

  @Post('revenue')
  @RequirePermission('finance.create')
  createRevenue(@TenantCtx() ctx: TenantContext, @ZodBody(revenueInputSchema) body: RevenueInput) {
    return this.ledger.create(ctx, { ...body, kind: 'revenue' });
  }

  @Patch('revenue/:id')
  @RequirePermission('finance.edit')
  updateRevenue(
    @TenantCtx() ctx: TenantContext,
    @Param('id', UuidPipe) id: string,
    @ZodBody(revenueInputSchema) body: RevenueInput,
  ) {
    return this.ledger.update(ctx, id, { ...body, kind: 'revenue' });
  }

  @Delete('revenue/:id')
  @HttpCode(204)
  @RequirePermission('finance.delete')
  removeRevenue(@TenantCtx() ctx: TenantContext, @Param('id', UuidPipe) id: string) {
    return this.ledger.remove(ctx, 'revenue', id);
  }
}
