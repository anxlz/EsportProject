/** Request schemas for meetings and integrations (Phase 6). Enforced by the API; reused by the web app. */
import { z } from 'zod';
import {
  INCOMING_WEBHOOK_ACTIONS,
  MEETING_KINDS,
  MEETING_LIMITS,
  RECURRENCE_FREQUENCIES,
  REMINDER_OPTIONS,
  SYNC_DIRECTIONS,
  WEBHOOK_EVENT_TYPES,
  WEEKDAYS,
} from './catalog.js';
import {
  isValidTimeZone,
  localToUtc,
  parseDate,
  parseLocal,
  type RecurrenceRule,
  ruleProblem,
} from './recurrence.js';

const text = (max: number) => z.string().trim().max(max);
const optText = (max: number) => text(max).nullable().optional();
const uuid = z.uuid();

/** Wall-clock date and time in the meeting's time zone: "2026-10-21T18:00". */
export const localDateTimeSchema = z
  .string()
  .refine((s) => parseLocal(s) !== null, 'local_datetime_format');
export const dateOnlySchema = z.string().refine((s) => parseDate(s) !== null, 'date_format');
export const timeZoneSchema = z.string().refine(isValidTimeZone, 'time_zone_invalid');

export const recurrenceRuleSchema = z
  .object({
    freq: z.enum(RECURRENCE_FREQUENCIES),
    interval: z.number().int().min(1).max(MEETING_LIMITS.intervalMax).default(1),
    byWeekday: z.array(z.enum(WEEKDAYS)).max(7).optional(),
    end: z.discriminatedUnion('type', [
      z.object({
        type: z.literal('count'),
        count: z.number().int().min(1).max(MEETING_LIMITS.countMax),
      }),
      z.object({ type: z.literal('until'), until: dateOnlySchema }),
    ]),
  })
  .transform((rule): RecurrenceRule => {
    if (!rule.end) throw new Error('Validated recurrence rule must include an end condition');
    return {
      freq: rule.freq,
      interval: rule.interval,
      byWeekday: rule.byWeekday,
      end: rule.end,
    };
  });

const reminders = z
  .array(
    z
      .number()
      .int()
      .refine((n) => (REMINDER_OPTIONS as readonly number[]).includes(n), 'reminder_option'),
  )
  .max(MEETING_LIMITS.remindersMax);

const timing = {
  start: localDateTimeSchema,
  end: localDateTimeSchema,
  timeZone: timeZoneSchema,
  recurrence: recurrenceRuleSchema.nullable().optional(),
};

/** Shared checks: the end follows the start within a day, the rule fits the start. */
function checkTiming(
  v: {
    start?: string;
    end?: string;
    timeZone?: string;
    recurrence?: z.output<typeof recurrenceRuleSchema> | null;
  },
  ctx: z.core.$RefinementCtx,
) {
  if (!v.start || !v.end || !v.timeZone) return;
  const s = parseLocal(v.start);
  const e = parseLocal(v.end);
  if (!s || !e || !isValidTimeZone(v.timeZone)) return;
  const minutes = (localToUtc(e, v.timeZone) - localToUtc(s, v.timeZone)) / 60000;
  if (minutes < MEETING_LIMITS.durationMinMinutes || minutes > MEETING_LIMITS.durationMaxMinutes)
    ctx.addIssue({ code: 'custom', path: ['end'], message: 'duration_range' });
  if (v.recurrence) {
    const problem = ruleProblem(v.recurrence, v.start);
    if (problem) ctx.addIssue({ code: 'custom', path: ['recurrence'], message: problem });
  }
}

export const meetingCreateSchema = z
  .object({
    kind: z.enum(MEETING_KINDS).default('standard'),
    title: text(MEETING_LIMITS.titleMax).min(1),
    description: optText(MEETING_LIMITS.descriptionMax),
    notes: optText(MEETING_LIMITS.notesMax),
    teamId: uuid.nullable().optional(),
    departmentId: uuid.nullable().optional(),
    ...timing,
    participantUserIds: z.array(uuid).max(MEETING_LIMITS.participantsMax).default([]),
    reminderMinutes: reminders.default([15]),
  })
  .superRefine((v, ctx) => {
    if (v.teamId && v.departmentId)
      ctx.addIssue({ code: 'custom', path: ['departmentId'], message: 'team_or_department' });
    if (v.kind === 'administrative' && (v.teamId || v.departmentId))
      ctx.addIssue({ code: 'custom', path: ['teamId'], message: 'administrative_is_org_wide' });
    checkTiming(v, ctx);
  });
export type MeetingCreateInput = z.infer<typeof meetingCreateSchema>;

/** Changes the whole series. Single occurrences are cancelled or moved separately. */
export const meetingUpdateSchema = z
  .object({
    title: text(MEETING_LIMITS.titleMax).min(1).optional(),
    description: optText(MEETING_LIMITS.descriptionMax),
    notes: optText(MEETING_LIMITS.notesMax),
    teamId: uuid.nullable().optional(),
    departmentId: uuid.nullable().optional(),
    start: localDateTimeSchema.optional(),
    end: localDateTimeSchema.optional(),
    timeZone: timeZoneSchema.optional(),
    recurrence: recurrenceRuleSchema.nullable().optional(),
    participantUserIds: z.array(uuid).max(MEETING_LIMITS.participantsMax).optional(),
    reminderMinutes: reminders.optional(),
    /** Optimistic concurrency: the version the editor started from. */
    expectedVersion: z.number().int().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.teamId && v.departmentId)
      ctx.addIssue({ code: 'custom', path: ['departmentId'], message: 'team_or_department' });
    if ((v.start === undefined) !== (v.end === undefined))
      ctx.addIssue({ code: 'custom', path: ['end'], message: 'start_and_end_together' });
  });
export type MeetingUpdateInput = z.infer<typeof meetingUpdateSchema>;

export const meetingCancelSchema = z.object({ reason: optText(500) });
export type MeetingCancelInput = z.infer<typeof meetingCancelSchema>;

export const meetingRespondSchema = z.object({
  response: z.enum(['accepted', 'declined']),
  note: optText(500),
});
export type MeetingRespondInput = z.infer<typeof meetingRespondSchema>;

export const occurrenceCancelSchema = z.object({ originalStart: z.iso.datetime({ offset: true }) });
export type OccurrenceCancelInput = z.infer<typeof occurrenceCancelSchema>;

export const occurrenceMoveSchema = z.object({
  originalStart: z.iso.datetime({ offset: true }),
  start: localDateTimeSchema,
  end: localDateTimeSchema,
});
export type OccurrenceMoveInput = z.infer<typeof occurrenceMoveSchema>;

export const meetingListQuerySchema = z
  .object({
    from: dateOnlySchema,
    to: dateOnlySchema,
    teamId: uuid.optional(),
    mine: z.enum(['true', 'false']).optional(),
  })
  .refine((q) => q.to >= q.from, { path: ['to'], message: 'to_before_from' })
  .refine(
    (q) =>
      (Date.parse(`${q.to}T00:00:00Z`) - Date.parse(`${q.from}T00:00:00Z`)) / 86_400_000 <=
      MEETING_LIMITS.listWindowDays,
    { path: ['to'], message: 'window_too_wide' },
  );
export type MeetingListQuery = z.infer<typeof meetingListQuerySchema>;

// ---------------------------------------------------------------- integrations

export const integrationUpdateSchema = z.object({
  name: text(120).min(1).optional(),
  direction: z.enum(SYNC_DIRECTIONS).optional(),
  /** Only meetings of this team (null: every meeting the owner can see). */
  teamId: uuid.nullable().optional(),
  /** Google Calendar: which calendar to sync with ("primary" by default). */
  calendarId: text(256).min(1).optional(),
  /** Outgoing webhooks: which events to send. */
  events: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1).optional(),
  /** Incoming webhooks: which actions to accept. */
  actions: z.array(z.enum(INCOMING_WEBHOOK_ACTIONS)).min(1).optional(),
  paused: z.boolean().optional(),
});
export type IntegrationUpdateInput = z.infer<typeof integrationUpdateSchema>;

export const notionConnectSchema = z.object({
  name: text(120).min(1).default('Notion'),
  /** An internal integration secret from notion.so/my-integrations. */
  token: z.string().trim().min(20).max(300),
  /** The database (or its URL) the meetings go into. */
  database: z.string().trim().min(32).max(500),
  teamId: uuid.nullable().optional(),
  direction: z.enum(SYNC_DIRECTIONS).default('two_way'),
  /** Used to read dates written in Notion without a time zone. */
  timeZone: timeZoneSchema.default('UTC'),
});
export type NotionConnectInput = z.infer<typeof notionConnectSchema>;

export const googleConnectSchema = z.object({
  direction: z.enum(SYNC_DIRECTIONS).default('two_way'),
  calendarId: text(256).min(1).default('primary'),
  teamId: uuid.nullable().optional(),
});
export type GoogleConnectInput = z.infer<typeof googleConnectSchema>;

export const obsidianConnectSchema = z.object({
  direction: z.enum(SYNC_DIRECTIONS).default('two_way'),
  teamId: uuid.nullable().optional(),
});
export type ObsidianConnectInput = z.infer<typeof obsidianConnectSchema>;

export const outgoingWebhookCreateSchema = z.object({
  name: text(120).min(1),
  url: z.url().max(2000),
  events: z
    .array(z.enum(WEBHOOK_EVENT_TYPES))
    .min(1)
    .default([...WEBHOOK_EVENT_TYPES]),
  teamId: uuid.nullable().optional(),
});
export type OutgoingWebhookCreateInput = z.infer<typeof outgoingWebhookCreateSchema>;

export const incomingWebhookCreateSchema = z.object({
  name: text(120).min(1),
  actions: z.array(z.enum(INCOMING_WEBHOOK_ACTIONS)).min(1).default(['meeting.create']),
  /** Team used for meetings created through this webhook when the payload names none. */
  teamId: uuid.nullable().optional(),
});
export type IncomingWebhookCreateInput = z.infer<typeof incomingWebhookCreateSchema>;

/** A meeting as an external system sends it (create; update takes any subset). */
const externalRef = {
  /** The sender's own id for the meeting; repeating a create with it returns the same meeting. */
  externalId: text(200).min(1).optional(),
  meetingId: uuid.optional(),
};

export const incomingWebhookPayloadSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('meeting.create'),
    data: z
      .object({
        externalId: text(200).min(1),
        title: text(MEETING_LIMITS.titleMax).min(1),
        description: optText(MEETING_LIMITS.descriptionMax),
        notes: optText(MEETING_LIMITS.notesMax),
        teamId: uuid.nullable().optional(),
        ...timing,
        participantEmails: z
          .array(z.email().max(254))
          .max(MEETING_LIMITS.participantsMax)
          .default([]),
        reminderMinutes: reminders.optional(),
      })
      .superRefine(checkTiming),
  }),
  z.object({
    type: z.literal('meeting.update'),
    data: z.object({
      ...externalRef,
      title: text(MEETING_LIMITS.titleMax).min(1).optional(),
      description: optText(MEETING_LIMITS.descriptionMax),
      notes: optText(MEETING_LIMITS.notesMax),
      start: localDateTimeSchema.optional(),
      end: localDateTimeSchema.optional(),
      timeZone: timeZoneSchema.optional(),
    }),
  }),
  z.object({
    type: z.literal('meeting.cancel'),
    data: z.object({ ...externalRef, reason: optText(500) }),
  }),
]);
export type IncomingWebhookPayload = z.infer<typeof incomingWebhookPayloadSchema>;

/** Notes the Obsidian companion sends back (two-way mode). */
export const obsidianPushSchema = z.object({
  notes: z
    .array(
      z.object({
        meetingId: uuid,
        /** platform_version from the note's properties when it was written. */
        baseVersion: z.number().int().min(1),
        content: z.string().max(80_000),
      }),
    )
    .max(50),
});
export type ObsidianPushInput = z.infer<typeof obsidianPushSchema>;

export const obsidianFeedQuerySchema = z.object({
  /** Cursor from the previous feed response (opaque). */
  since: z.string().max(200).optional(),
});
