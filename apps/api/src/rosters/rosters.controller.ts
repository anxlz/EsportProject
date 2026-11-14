import {
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  fl,
  rosterMemberCreateSchema,
  type RosterMemberCreateInput,
  rosterMemberUpdateSchema,
  type RosterMemberUpdateInput,
} from '@esports/shared';
import { AuditService } from '../audit/audit.service.js';
import { RequireOrg, RequirePermission, type TenantContext, TenantCtx } from '../authz/context.js';
import { toCsv } from '../common/csv.js';
import { UuidPipe, ZodBody } from '../common/zod.js';
import { RostersService } from './rosters.service.js';

@ApiTags('rosters')
@Controller()
export class RostersController {
  constructor(
    private readonly rosters: RostersService,
    private readonly audit: AuditService,
  ) {}

  /** rosters.view OR finance.view on the team (checked in the service). */
  @Get('teams/:teamId/roster')
  @RequireOrg()
  list(@TenantCtx() ctx: TenantContext, @Param('teamId', UuidPipe) teamId: string) {
    return this.rosters.list(ctx, teamId);
  }

  @Get('teams/:teamId/roster/export.csv')
  @RequirePermission('rosters.export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="roster.csv"')
  async exportCsv(
    @TenantCtx() ctx: TenantContext,
    @Param('teamId', UuidPipe) teamId: string,
    @Query('locale') locale?: string,
  ): Promise<string> {
    const team = await this.rosters.teamForExport(ctx, teamId);
    const rows = await this.rosters.list(ctx, teamId);
    const { showPay } = this.rosters.exportVisibility(ctx, team);
    const L = fl(locale === 'ar' ? 'ar' : 'en');
    await this.audit.fromCtx(
      ctx,
      'roster.exported',
      { type: 'team', id: teamId },
      { rows: rows.length, includesPay: showPay },
    );
    const header = [
      'full_name',
      'handle',
      'role',
      'position',
      'nationality',
      'active',
      'joined_on',
      'left_on',
    ];
    const payHeader = [
      'pay_currency',
      'pay_amount',
      'off_season_amount',
      'pay_frequency',
      'contract_start',
      'contract_end',
    ];
    return toCsv(
      showPay ? [...header, ...payHeader] : header,
      rows.map((r) => {
        const base = [
          r.fullName,
          r.handle,
          L.rosterRole[r.role] ?? r.role,
          r.position,
          r.nationality,
          r.active ? 'yes' : 'no',
          r.joinedOn,
          r.leftOn,
        ];
        if (!showPay) return base;
        const c = r.compensation;
        return [
          ...base,
          c?.currency,
          c?.amount,
          c?.offSeasonAmount,
          c ? L.payFrequency[c.frequency] : null,
          c?.contractStart,
          c?.contractEnd,
        ];
      }),
    );
  }

  @Get('roster-members/:id')
  @RequireOrg()
  get(@TenantCtx() ctx: TenantContext, @Param('id', UuidPipe) id: string) {
    return this.rosters.get(ctx, id);
  }

  @Post('roster-members')
  @RequirePermission('rosters.create')
  create(
    @TenantCtx() ctx: TenantContext,
    @ZodBody(rosterMemberCreateSchema) body: RosterMemberCreateInput,
  ) {
    return this.rosters.create(ctx, body);
  }

  @Patch('roster-members/:id')
  @RequirePermission('rosters.edit')
  update(
    @TenantCtx() ctx: TenantContext,
    @Param('id', UuidPipe) id: string,
    @ZodBody(rosterMemberUpdateSchema) body: RosterMemberUpdateInput,
  ) {
    return this.rosters.update(ctx, id, body);
  }

  @Delete('roster-members/:id')
  @HttpCode(204)
  @RequirePermission('rosters.delete')
  remove(@TenantCtx() ctx: TenantContext, @Param('id', UuidPipe) id: string) {
    return this.rosters.remove(ctx, id);
  }
}
