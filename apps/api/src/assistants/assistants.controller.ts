import { Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  type ApplyOfferInput,
  applyOfferSchema,
  type CreateConversationInput,
  createConversationSchema,
  type SendProposedEmailInput,
  sendAssistantMessageSchema,
  sendProposedEmailSchema,
  toolCallQuerySchema,
  type UpdateConversationInput,
  updateConversationSchema,
} from '@esports/shared';
import type { z } from 'zod';
import { RequireOrg, RequirePermission, type TenantContext, TenantCtx } from '../authz/context.js';
import { AiRouter } from '../ai/ai.router.js';
import { UuidPipe, ZodBody, ZodQuery } from '../common/zod.js';
import { AssistantsService, listQuerySchema } from './assistants.service.js';

@ApiTags('assistants')
@Controller('assistants')
export class AssistantsController {
  constructor(
    private readonly assistants: AssistantsService,
    private readonly aiRouter: AiRouter,
  ) {}

  /** Which assistants this user can use, and whether the AI provider is configured. */
  @Get()
  @RequireOrg()
  overview(@TenantCtx() ctx: TenantContext) {
    return this.assistants.overview(ctx);
  }

  @Get('health')
  @RequireOrg()
  localModelHealth() {
    return this.aiRouter.localHealth();
  }

  @Get('conversations')
  @RequireOrg()
  list(
    @TenantCtx() ctx: TenantContext,
    @ZodQuery(listQuerySchema) q: z.infer<typeof listQuerySchema>,
  ) {
    return this.assistants.list(ctx, q.assistant, q.archived);
  }

  @Post('conversations')
  @RequireOrg()
  create(
    @TenantCtx() ctx: TenantContext,
    @ZodBody(createConversationSchema) body: CreateConversationInput,
  ) {
    return this.assistants.create(ctx, body);
  }

  @Get('conversations/:id')
  @RequireOrg()
  get(@TenantCtx() ctx: TenantContext, @Param('id', UuidPipe) id: string) {
    return this.assistants.get(ctx, id);
  }

  @Patch('conversations/:id')
  @RequireOrg()
  update(
    @TenantCtx() ctx: TenantContext,
    @Param('id', UuidPipe) id: string,
    @ZodBody(updateConversationSchema) body: UpdateConversationInput,
  ) {
    return this.assistants.update(ctx, id, body);
  }

  /** Stores the message and starts the reply; poll the conversation until it is complete. */
  @Post('conversations/:id/messages')
  @HttpCode(202)
  @RequireOrg()
  send(
    @TenantCtx() ctx: TenantContext,
    @Param('id', UuidPipe) id: string,
    @ZodBody(sendAssistantMessageSchema) body: z.infer<typeof sendAssistantMessageSchema>,
  ) {
    return this.assistants.send(ctx, id, body.text);
  }

  /** Explicit human action: send the reviewed (possibly edited) email. */
  @Post('messages/:id/send-email')
  @HttpCode(200)
  @RequirePermission('assistants.email', 'assistants.send_email')
  sendEmail(
    @TenantCtx() ctx: TenantContext,
    @Param('id', UuidPipe) id: string,
    @ZodBody(sendProposedEmailSchema) body: SendProposedEmailInput,
  ) {
    return this.assistants.sendEmail(ctx, id, body);
  }

  /** Explicit human action: save one alternative into a draft contract as a new version. */
  @Post('messages/:id/apply-offer')
  @HttpCode(200)
  @RequirePermission('assistants.offer_optimizer')
  applyOffer(
    @TenantCtx() ctx: TenantContext,
    @Param('id', UuidPipe) id: string,
    @ZodBody(applyOfferSchema) body: ApplyOfferInput,
  ) {
    return this.assistants.applyOffer(ctx, id, body);
  }

  @Get('offer-terms/:contractId')
  @RequirePermission('assistants.offer_optimizer')
  offerTerms(@TenantCtx() ctx: TenantContext, @Param('contractId', UuidPipe) id: string) {
    return this.assistants.contractTerms(ctx, id);
  }

  /** The tool-call log (spec §8.1 guardrail 4). */
  @Get('tool-calls')
  @RequirePermission('audit.view')
  toolCalls(
    @TenantCtx() ctx: TenantContext,
    @ZodQuery(toolCallQuerySchema) q: z.infer<typeof toolCallQuerySchema>,
  ) {
    return this.assistants.toolCalls(ctx, q);
  }
}
