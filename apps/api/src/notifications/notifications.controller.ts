import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { notificationsQuerySchema } from '@esports/shared';
import type { z } from 'zod';
import { RequireOrg, type TenantContext, TenantCtx } from '../authz/context';
import { UuidPipe, ZodQuery } from '../common/zod';
import { NotificationService } from './notification.service';

/** A user's own notifications in their active organization. No permission beyond membership. */
@ApiTags('notifications')
@Controller('notifications')
@RequireOrg()
export class NotificationsController {
  constructor(private readonly notifications: NotificationService) {}

  @Get()
  list(
    @TenantCtx() ctx: TenantContext,
    @ZodQuery(notificationsQuerySchema) q: z.infer<typeof notificationsQuerySchema>,
  ) {
    return this.notifications.list(ctx.organizationId, ctx.user.id, {
      ...q,
      unreadOnly: q.unreadOnly ?? false,
    });
  }

  @Get('unread-count')
  async unreadCount(@TenantCtx() ctx: TenantContext) {
    return { count: await this.notifications.unreadCount(ctx.organizationId, ctx.user.id) };
  }

  @Post(':id/read')
  @HttpCode(204)
  markRead(@TenantCtx() ctx: TenantContext, @Param('id', UuidPipe) id: string) {
    return this.notifications.markRead(ctx.organizationId, ctx.user.id, id);
  }

  @Post('read-all')
  @HttpCode(204)
  markAllRead(@TenantCtx() ctx: TenantContext) {
    return this.notifications.markAllRead(ctx.organizationId, ctx.user.id);
  }
}
