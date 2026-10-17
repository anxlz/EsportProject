/**
 * Shared notification service: one table, many trigger points (budget alerts in Phase 2,
 * contract approvals in Phase 3, meeting invites/reminders in Phase 6).
 *
 * Notifications store a `type` and structured `data`, never rendered text, so the web app
 * renders them in the reader's current language (Arabic or English).
 *
 * Delivery today is in-app (the web app polls the unread count). Email/real-time channels can be
 * added behind `notify()` without changing callers.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { NotificationDto, NotificationType, PermissionKey } from '@esports/shared';
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { AccessService } from '../authz/access.service';
import type { TeamRef } from '../authz/access';
import { Errors } from '../common/errors';
import { DB, type Database, type DbOrTx } from '../db/client';
import { notifications } from '../db/schema';

export interface NotifyInput {
  organizationId: string;
  recipientUserIds: string[];
  type: NotificationType;
  data?: Record<string, unknown>;
  link?: string | null;
}

@Injectable()
export class NotificationService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly access: AccessService,
  ) {}

  async notify(input: NotifyInput, tx: DbOrTx = this.db): Promise<number> {
    const recipients = [...new Set(input.recipientUserIds)];
    if (!recipients.length) return 0;
    await tx.insert(notifications).values(
      recipients.map((recipientUserId) => ({
        organizationId: input.organizationId,
        recipientUserId,
        type: input.type,
        data: input.data ?? {},
        link: input.link ?? null,
      })),
    );
    return recipients.length;
  }

  /** Notify everyone who holds `perm` (covering `team`, if given). */
  async notifyPermissionHolders(
    input: Omit<NotifyInput, 'recipientUserIds'> & {
      permission: PermissionKey;
      team?: TeamRef | 'organization';
      excludeUserIds?: string[];
    },
  ): Promise<number> {
    const holders = await this.access.usersWithPermission(
      input.organizationId,
      input.permission,
      input.team,
    );
    const exclude = new Set(input.excludeUserIds ?? []);
    return this.notify({ ...input, recipientUserIds: holders.filter((id) => !exclude.has(id)) });
  }

  async list(
    organizationId: string,
    userId: string,
    q: { unreadOnly: boolean; limit: number },
  ): Promise<NotificationDto[]> {
    const rows = await this.db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.organizationId, organizationId),
          eq(notifications.recipientUserId, userId),
          q.unreadOnly ? isNull(notifications.readAt) : undefined,
        ),
      )
      .orderBy(desc(notifications.createdAt))
      .limit(q.limit);
    return rows.map((n) => ({
      id: n.id,
      type: n.type as NotificationType,
      data: n.data,
      link: n.link,
      readAt: n.readAt?.toISOString() ?? null,
      createdAt: n.createdAt.toISOString(),
    }));
  }

  async unreadCount(organizationId: string, userId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(notifications)
      .where(
        and(
          eq(notifications.organizationId, organizationId),
          eq(notifications.recipientUserId, userId),
          isNull(notifications.readAt),
        ),
      );
    return row?.n ?? 0;
  }

  async markRead(organizationId: string, userId: string, id: string): Promise<void> {
    const updated = await this.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.id, id),
          eq(notifications.organizationId, organizationId),
          eq(notifications.recipientUserId, userId),
        ),
      )
      .returning({ id: notifications.id });
    if (!updated.length) throw Errors.notFound('Notification');
  }

  async markAllRead(organizationId: string, userId: string): Promise<void> {
    await this.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.organizationId, organizationId),
          eq(notifications.recipientUserId, userId),
          isNull(notifications.readAt),
        ),
      );
  }
}
