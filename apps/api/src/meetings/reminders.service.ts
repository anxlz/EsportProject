/**
 * Meeting reminders through the shared NotificationService (no separate mechanism).
 *
 * Every scheduler tick sends the reminders that fell due since the previous ticks: for each
 * scheduled meeting, each reminder offset and each occurrence whose `start - offset` lies in
 * (now − 15 min, now]. A row in meeting_reminder_deliveries (primary key: meeting, occurrence
 * start, offset) is inserted in the same transaction as the notifications, so a reminder goes
 * out exactly once even with several API instances, and a reminder more than 15 minutes late
 * (e.g. after downtime) is skipped rather than sent stale. Declined invitees get none.
 */
import { Inject, Injectable } from '@nestjs/common';
import { occurrencesBetween, REMINDER_OPTIONS } from '@esports/shared';
import { and, eq, gt, lt } from 'drizzle-orm';
import { NOW, type Now } from '../common/now';
import { DB, type Database } from '../db/client';
import {
  meetingOverrides,
  meetingParticipants,
  meetingReminderDeliveries,
  meetings,
} from '../db/schema-meetings';
import { NotificationService } from '../notifications/notification.service';

export const REMINDER_LATENESS_MS = 15 * 60_000;
const MAX_OFFSET_MS = Math.max(...REMINDER_OPTIONS) * 60_000;

@Injectable()
export class RemindersService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(NOW) private readonly now: Now,
    private readonly notifications: NotificationService,
  ) {}

  /** Sends what is due at `at` (default: now). Returns the number of reminders sent. */
  async tick(at: number = this.now()): Promise<number> {
    const candidates = await this.db
      .select()
      .from(meetings)
      .where(
        and(
          eq(meetings.status, 'scheduled'),
          gt(meetings.seriesEndsAt, new Date(at - REMINDER_LATENESS_MS)),
          lt(meetings.startsAt, new Date(at + MAX_OFFSET_MS + 60_000)),
        ),
      );
    let sent = 0;
    for (const m of candidates) {
      if (!m.reminderMinutes.length) continue;
      const overrides = await this.db
        .select()
        .from(meetingOverrides)
        .where(eq(meetingOverrides.meetingId, m.id));
      for (const offset of m.reminderMinutes) {
        const ms = offset * 60_000;
        const due = occurrencesBetween(
          {
            startLocal: m.startLocal,
            durationMinutes: m.durationMinutes,
            timeZone: m.timeZone,
            recurrence: m.recurrence,
          },
          overrides.map((o) => ({
            originalStart: o.originalStart.toISOString(),
            status: o.status as 'cancelled' | 'moved',
            start: o.startAt?.toISOString() ?? null,
            end: o.endAt?.toISOString() ?? null,
          })),
          at - REMINDER_LATENESS_MS + ms - 1,
          at + ms + 1,
        ).filter(
          (o) =>
            !o.cancelled && o.startUtc - ms > at - REMINDER_LATENESS_MS && o.startUtc - ms <= at,
        );
        for (const o of due) {
          sent += await this.db.transaction(async (tx) => {
            const [claimed] = await tx
              .insert(meetingReminderDeliveries)
              .values({
                organizationId: m.organizationId,
                meetingId: m.id,
                occurrenceStart: new Date(o.startUtc),
                offsetMinutes: offset,
              })
              .onConflictDoNothing()
              .returning({ meetingId: meetingReminderDeliveries.meetingId });
            if (!claimed) return 0;
            const people = await tx
              .select({
                userId: meetingParticipants.userId,
                response: meetingParticipants.response,
              })
              .from(meetingParticipants)
              .where(eq(meetingParticipants.meetingId, m.id));
            const recipients = people.filter((p) => p.response !== 'declined').map((p) => p.userId);
            const n = await this.notifications.notify(
              {
                organizationId: m.organizationId,
                recipientUserIds: recipients,
                type: 'meeting.reminder',
                data: {
                  meetingId: m.id,
                  title: m.title,
                  start: new Date(o.startUtc).toISOString(),
                  timeZone: m.timeZone,
                  minutes: offset,
                },
                link: `/dashboard/meetings/${m.id}`,
              },
              tx,
            );
            await tx
              .update(meetingReminderDeliveries)
              .set({ recipients: n })
              .where(
                and(
                  eq(meetingReminderDeliveries.meetingId, m.id),
                  eq(meetingReminderDeliveries.occurrenceStart, new Date(o.startUtc)),
                  eq(meetingReminderDeliveries.offsetMinutes, offset),
                ),
              );
            return 1;
          });
        }
      }
    }
    return sent;
  }
}
