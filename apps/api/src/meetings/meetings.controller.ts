import { Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  type MeetingCancelInput,
  meetingCancelSchema,
  type MeetingCreateInput,
  meetingCreateSchema,
  type MeetingListQuery,
  meetingListQuerySchema,
  type MeetingRespondInput,
  meetingRespondSchema,
  type MeetingUpdateInput,
  meetingUpdateSchema,
  type OccurrenceCancelInput,
  occurrenceCancelSchema,
  type OccurrenceMoveInput,
  occurrenceMoveSchema,
} from '@esports/shared';
import { and, asc, eq } from 'drizzle-orm';
import { Inject } from '@nestjs/common';
import { RequireOrg, type TenantContext, TenantCtx } from '../authz/context.js';
import { Errors } from '../common/errors.js';
import { UuidPipe, ZodBody, ZodQuery } from '../common/zod.js';
import { DB, type Database } from '../db/client.js';
import { organizationMembers, users } from '../db/schema.js';
import { MeetingsService } from './meetings.service.js';

/**
 * Every member reaches these routes (anyone can be invited); what each person may see, create,
 * change or answer is decided per meeting in MeetingsService (meeting-access.ts).
 */
@ApiTags('meetings')
@Controller('meetings')
export class MeetingsController {
  constructor(
    private readonly meetings: MeetingsService,
    @Inject(DB) private readonly db: Database,
  ) {}

  @Get()
  @RequireOrg()
  list(@TenantCtx() ctx: TenantContext, @ZodQuery(meetingListQuerySchema) q: MeetingListQuery) {
    return this.meetings.list(ctx, q);
  }

  /** People who can be invited: active members, names only (for the participant picker). */
  @Get('invitees')
  @RequireOrg()
  async invitees(@TenantCtx() ctx: TenantContext) {
    if (
      !ctx.access.has('meetings.create') &&
      !ctx.access.has('meetings.manage') &&
      !ctx.access.has('meetings.administrative')
    )
      throw Errors.forbidden();
    return this.db
      .select({ userId: users.id, displayName: users.displayName })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(
        and(
          eq(organizationMembers.organizationId, ctx.organizationId),
          eq(organizationMembers.status, 'active'),
        ),
      )
      .orderBy(asc(users.displayName));
  }

  @Get(':id')
  @RequireOrg()
  get(@TenantCtx() ctx: TenantContext, @Param('id', UuidPipe) id: string) {
    return this.meetings.get(ctx, id);
  }

  @Post()
  @RequireOrg()
  create(@TenantCtx() ctx: TenantContext, @ZodBody(meetingCreateSchema) body: MeetingCreateInput) {
    return this.meetings.create(ctx, body);
  }

  @Patch(':id')
  @RequireOrg()
  update(
    @TenantCtx() ctx: TenantContext,
    @Param('id', UuidPipe) id: string,
    @ZodBody(meetingUpdateSchema) body: MeetingUpdateInput,
  ) {
    return this.meetings.update(ctx, id, body);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequireOrg()
  cancel(
    @TenantCtx() ctx: TenantContext,
    @Param('id', UuidPipe) id: string,
    @ZodBody(meetingCancelSchema) body: MeetingCancelInput,
  ) {
    return this.meetings.cancel(ctx, id, body.reason);
  }

  @Post(':id/occurrences/cancel')
  @HttpCode(200)
  @RequireOrg()
  cancelOccurrence(
    @TenantCtx() ctx: TenantContext,
    @Param('id', UuidPipe) id: string,
    @ZodBody(occurrenceCancelSchema) body: OccurrenceCancelInput,
  ) {
    return this.meetings.cancelOccurrence(ctx, id, body.originalStart);
  }

  @Post(':id/occurrences/move')
  @HttpCode(200)
  @RequireOrg()
  moveOccurrence(
    @TenantCtx() ctx: TenantContext,
    @Param('id', UuidPipe) id: string,
    @ZodBody(occurrenceMoveSchema) body: OccurrenceMoveInput,
  ) {
    return this.meetings.moveOccurrence(ctx, id, body);
  }

  @Post(':id/respond')
  @HttpCode(200)
  @RequireOrg()
  respond(
    @TenantCtx() ctx: TenantContext,
    @Param('id', UuidPipe) id: string,
    @ZodBody(meetingRespondSchema) body: MeetingRespondInput,
  ) {
    return this.meetings.respond(ctx, id, body);
  }
}
