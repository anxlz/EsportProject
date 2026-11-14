import { Controller, Delete, Get, Header, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type TeamCreateInput, teamCreateSchema, teamUpdateSchema } from '@esports/shared';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { RequirePermission, type TenantContext, TenantCtx } from '../authz/context.js';
import { toCsv } from '../common/csv.js';
import { UuidPipe, ZodBody } from '../common/zod.js';
import { TeamsService } from './teams.service.js';

@ApiTags('teams')
@Controller('teams')
export class TeamsController {
  constructor(
    private readonly teams: TeamsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('teams.view')
  list(@TenantCtx() ctx: TenantContext) {
    return this.teams.list(ctx);
  }

  /** Exports exactly the teams covered by the caller's `teams.export` scope. */
  @Get('export.csv')
  @RequirePermission('teams.export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="teams.csv"')
  async exportCsv(@TenantCtx() ctx: TenantContext): Promise<string> {
    const rows = await this.teams.list(ctx, 'teams.export');
    await this.audit.fromCtx(ctx, 'team.exported', null, { format: 'csv', rows: rows.length });
    return toCsv(
      ['name', 'department', 'game', 'region', 'status', 'created_at'],
      rows.map((t) => [t.name, t.departmentName, t.gameName, t.region, t.status, t.createdAt]),
    );
  }

  @Get(':id')
  @RequirePermission('teams.view')
  get(@TenantCtx() ctx: TenantContext, @Param('id', UuidPipe) id: string) {
    return this.teams.getVisible(ctx, id);
  }

  @Post()
  @RequirePermission('teams.create')
  create(@TenantCtx() ctx: TenantContext, @ZodBody(teamCreateSchema) body: TeamCreateInput) {
    return this.teams.create(ctx, body);
  }

  @Patch(':id')
  @RequirePermission('teams.edit')
  update(
    @TenantCtx() ctx: TenantContext,
    @Param('id', UuidPipe) id: string,
    @ZodBody(teamUpdateSchema) body: z.infer<typeof teamUpdateSchema>,
  ) {
    return this.teams.update(ctx, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('teams.delete')
  remove(@TenantCtx() ctx: TenantContext, @Param('id', UuidPipe) id: string) {
    return this.teams.remove(ctx, id);
  }
}
