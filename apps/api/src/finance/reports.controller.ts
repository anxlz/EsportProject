import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
  Post,
  Put,
  StreamableFile,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  type ReportExportInput,
  reportExportSchema,
  type ReportQuery,
  reportQuerySchema,
  saveScenariosSchema,
} from '@esports/shared';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { RequirePermission, type TenantContext, TenantCtx } from '../authz/context';
import { AppError } from '../common/errors';
import { ZodBody, ZodQuery } from '../common/zod';
import { renderReport } from './exports';
import { PdfRenderer } from './exports/render-pdf';
import { ReportsService } from './reports.service';

const scopeRefSchema = z
  .object({
    scope: z.enum(['organization', 'team', 'tournament', 'season']),
    scopeId: z.uuid().optional(),
  })
  .refine((q) => (q.scope === 'organization' ? !q.scopeId : !!q.scopeId), 'scope_id_mismatch');

const slug = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 40) || 'report';

@ApiTags('finance')
@Controller('finance')
export class ReportsController {
  private readonly log = new Logger(ReportsController.name);

  constructor(
    private readonly reports: ReportsService,
    private readonly pdf: PdfRenderer,
    private readonly audit: AuditService,
  ) {}

  @Get('reports/scopes')
  @RequirePermission('finance.view')
  scopes(@TenantCtx() ctx: TenantContext) {
    return this.reports.scopes(ctx);
  }

  @Get('reports')
  @RequirePermission('finance.view')
  report(@TenantCtx() ctx: TenantContext, @ZodQuery(reportQuerySchema) q: ReportQuery) {
    return this.reports.build(ctx, q);
  }

  @Put('scenarios')
  @HttpCode(204)
  @RequirePermission('finance.view', 'finance.edit')
  async saveScenarios(
    @TenantCtx() ctx: TenantContext,
    @ZodBody(saveScenariosSchema) body: z.infer<typeof saveScenariosSchema>,
  ) {
    await this.reports.saveScenarios(ctx, body.scope, body.scopeId ?? null, body.scenarios);
  }

  /** Back to the values calculated from data. */
  @Delete('scenarios')
  @HttpCode(204)
  @RequirePermission('finance.view', 'finance.edit')
  async resetScenarios(
    @TenantCtx() ctx: TenantContext,
    @ZodQuery(scopeRefSchema) q: z.infer<typeof scopeRefSchema>,
  ) {
    await this.reports.saveScenarios(ctx, q.scope, q.scopeId ?? null, null);
  }

  /**
   * Download the report. The body carries the scenario inputs on screen (possibly unsaved
   * edits) so the file matches what the user is looking at.
   */
  @Post('reports/export')
  @HttpCode(200)
  @RequirePermission('finance.view', 'finance.export')
  async export(
    @TenantCtx() ctx: TenantContext,
    @ZodBody(reportExportSchema) body: ReportExportInput,
  ) {
    await this.reports.resolveScope(ctx, body.query.scope, body.query.scopeId, 'finance.export');
    const report = await this.reports.build(ctx, body.query, body.scenarios);
    let file;
    try {
      file = await renderReport(body.format, report, body.locale, this.pdf);
    } catch (err) {
      this.log.error(
        `Report export (${body.format}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new AppError(
        'export_failed',
        500,
        'The file could not be generated. Please try again.',
      );
    }
    await this.audit.fromCtx(
      ctx,
      'finance.report_exported',
      { type: `report_${report.scope.kind}`, id: report.scope.id ?? ctx.organizationId },
      {
        format: body.format,
        locale: body.locale,
        rateMode: report.rateMode,
        period: report.period,
        scenariosCustomized: report.scenariosCustomized,
      },
    );
    const name = `financial-report-${report.scope.kind}-${slug(report.scope.name)}-${report.asOf}.${file.extension}`;
    return new StreamableFile(file.body, {
      type: file.contentType,
      disposition: `attachment; filename="${name}"`,
      length: file.body.length,
    });
  }
}
