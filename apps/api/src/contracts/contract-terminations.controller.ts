import { Controller, Get, HttpCode, Param, Post, StreamableFile } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  contractTerminationExecuteSchema,
  contractTerminationRequestSchema,
  contractTerminationResponseSchema,
  type ContractTerminationRequestInput,
} from '@esports/shared';
import { z } from 'zod';
import { RequireOrg, TenantCtx, type TenantContext } from '../authz/context';
import { UuidPipe, ZodBody } from '../common/zod';
import { asciiFilename } from './http';
import { ContractTerminationsService } from './contract-terminations.service';

@ApiTags('contract-terminations')
@Controller('contracts/:id/termination')
export class ContractTerminationsController {
  constructor(private readonly terminations: ContractTerminationsService) {}

  @Get()
  @RequireOrg()
  view(@TenantCtx() ctx: TenantContext, @Param('id', UuidPipe) id: string) {
    return this.terminations.view(ctx, id);
  }

  @Post()
  @HttpCode(200)
  @RequireOrg()
  request(
    @TenantCtx() ctx: TenantContext,
    @Param('id', UuidPipe) id: string,
    @ZodBody(contractTerminationRequestSchema) body: ContractTerminationRequestInput,
  ) {
    return this.terminations.request(ctx, id, body);
  }

  @Post('respond')
  @HttpCode(200)
  @RequireOrg()
  respond(
    @TenantCtx() ctx: TenantContext,
    @Param('id', UuidPipe) id: string,
    @ZodBody(contractTerminationResponseSchema)
    body: z.infer<typeof contractTerminationResponseSchema>,
  ) {
    return this.terminations.respond(ctx, id, body.decision, body.note ?? null);
  }

  @Post('withdraw')
  @HttpCode(200)
  @RequireOrg()
  withdraw(@TenantCtx() ctx: TenantContext, @Param('id', UuidPipe) id: string) {
    return this.terminations.withdraw(ctx, id);
  }

  @Post('execute')
  @HttpCode(200)
  @RequireOrg()
  execute(
    @TenantCtx() ctx: TenantContext,
    @Param('id', UuidPipe) id: string,
    @ZodBody(contractTerminationExecuteSchema)
    body: z.infer<typeof contractTerminationExecuteSchema>,
  ) {
    return this.terminations.execute(ctx, id, body.settlementNotes ?? null);
  }

  @Get('notice.pdf')
  @RequireOrg()
  async notice(@TenantCtx() ctx: TenantContext, @Param('id', UuidPipe) id: string) {
    const { pdf, filename } = await this.terminations.noticePdf(ctx, id);
    return new StreamableFile(pdf, {
      type: 'application/pdf',
      disposition: `attachment; filename="${asciiFilename(filename)}"`,
    });
  }
}
