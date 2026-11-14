/**
 * Phase 6 schema: meetings (series with recurrence, per-occurrence changes, invitations and
 * responses, reminder bookkeeping) and integrations (connections, the meeting ↔ remote record
 * map that prevents duplicates, a durable job queue with retries, an append-only event log, and
 * replay protection for incoming webhooks). Same rules as before: `app` schema, RLS on,
 * composite (organization_id, id) foreign keys.
 */
import type { RecurrenceRule } from '@esports/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { appSchema, departments, organizationMembers, organizations, teams, users } from './schema.js';

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => tstz('created_at').notNull().defaultNow();
const updatedAt = () => tstz('updated_at').notNull().defaultNow();

// ---------------------------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------------------------

/**
 * A meeting series (a one-off meeting is a series of one). The first start is stored as a
 * wall-clock time in its time zone; occurrences are generated from it (packages/shared
 * meetings/recurrence.ts). `starts_at` / `series_ends_at` are derived, for indexing.
 */
export const meetings = appSchema.table(
  'meetings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().default('standard'),
    title: text('title').notNull(),
    description: text('description'),
    notes: text('notes'),
    teamId: uuid('team_id'),
    departmentId: uuid('department_id'),
    timeZone: text('time_zone').notNull(),
    startLocal: text('start_local').notNull(),
    durationMinutes: integer('duration_minutes').notNull(),
    recurrence: jsonb('recurrence').$type<RecurrenceRule>(),
    startsAt: tstz('starts_at').notNull(),
    seriesEndsAt: tstz('series_ends_at').notNull(),
    status: text('status').notNull().default('scheduled'),
    cancelReason: text('cancel_reason'),
    cancelledAt: tstz('cancelled_at'),
    organizerUserId: uuid('organizer_user_id').references(() => users.id),
    reminderMinutes: integer('reminder_minutes')
      .array()
      .notNull()
      .default(sql`'{15}'::integer[]`),
    /** Bumped on every change; integrations compare it to what they last synced. */
    version: integer('version').notNull().default(1),
    /** Where the meeting was first created. */
    source: text('source').notNull().default('platform'),
    sourceConnectionId: uuid('source_connection_id'),
    /** An external system's id (incoming webhooks), unique per connection. */
    externalId: text('external_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('meetings_org_id_unique').on(t.organizationId, t.id),
    index('meetings_org_window_idx').on(t.organizationId, t.seriesEndsAt, t.startsAt),
    index('meetings_team_idx').on(t.organizationId, t.teamId),
    uniqueIndex('meetings_external_id_unique')
      .on(t.sourceConnectionId, t.externalId)
      .where(sql`${t.externalId} is not null`),
    check('meetings_duration_range', sql`${t.durationMinutes} between 5 and 1440`),
    check('meetings_team_or_department', sql`${t.teamId} is null or ${t.departmentId} is null`),
    check(
      'meetings_administrative_org_wide',
      sql`${t.kind} <> 'administrative' or (${t.teamId} is null and ${t.departmentId} is null)`,
    ),
    check('meetings_series_order', sql`${t.seriesEndsAt} > ${t.startsAt}`),
    check(
      'meetings_cancelled_at',
      sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null)`,
    ),
    foreignKey({
      name: 'meetings_team_fk',
      columns: [t.organizationId, t.teamId],
      foreignColumns: [teams.organizationId, teams.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'meetings_department_fk',
      columns: [t.organizationId, t.departmentId],
      foreignColumns: [departments.organizationId, departments.id],
    }).onDelete('restrict'),
  ],
);

/** Invitees and their responses (the organizer is a participant who has accepted). */
export const meetingParticipants = appSchema.table(
  'meeting_participants',
  {
    organizationId: uuid('organization_id').notNull(),
    meetingId: uuid('meeting_id').notNull(),
    userId: uuid('user_id').notNull(),
    response: text('response').notNull().default('pending'),
    respondedAt: tstz('responded_at'),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: 'meeting_participants_pk', columns: [t.meetingId, t.userId] }),
    index('meeting_participants_user_idx').on(t.organizationId, t.userId),
    foreignKey({
      name: 'meeting_participants_meeting_fk',
      columns: [t.organizationId, t.meetingId],
      foreignColumns: [meetings.organizationId, meetings.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'meeting_participants_member_fk',
      columns: [t.organizationId, t.userId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.userId],
    }).onDelete('cascade'),
  ],
);

/** A single occurrence of a series that was cancelled or moved (iCalendar EXDATE / exception). */
export const meetingOverrides = appSchema.table(
  'meeting_overrides',
  {
    organizationId: uuid('organization_id').notNull(),
    meetingId: uuid('meeting_id').notNull(),
    originalStart: tstz('original_start').notNull(),
    status: text('status').notNull(),
    startAt: tstz('start_at'),
    endAt: tstz('end_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: 'meeting_overrides_pk', columns: [t.meetingId, t.originalStart] }),
    check(
      'meeting_overrides_moved_times',
      sql`${t.status} <> 'moved' or (${t.startAt} is not null and ${t.endAt} > ${t.startAt})`,
    ),
    foreignKey({
      name: 'meeting_overrides_meeting_fk',
      columns: [t.organizationId, t.meetingId],
      foreignColumns: [meetings.organizationId, meetings.id],
    }).onDelete('cascade'),
  ],
);

/** One row per reminder actually sent, so a reminder goes out once even across instances. */
export const meetingReminderDeliveries = appSchema.table(
  'meeting_reminder_deliveries',
  {
    organizationId: uuid('organization_id').notNull(),
    meetingId: uuid('meeting_id').notNull(),
    occurrenceStart: tstz('occurrence_start').notNull(),
    offsetMinutes: integer('offset_minutes').notNull(),
    recipients: integer('recipients').notNull().default(0),
    sentAt: createdAt(),
  },
  (t) => [
    primaryKey({
      name: 'meeting_reminder_deliveries_pk',
      columns: [t.meetingId, t.occurrenceStart, t.offsetMinutes],
    }),
    foreignKey({
      name: 'meeting_reminder_deliveries_meeting_fk',
      columns: [t.organizationId, t.meetingId],
      foreignColumns: [meetings.organizationId, meetings.id],
    }).onDelete('cascade'),
  ],
);

// ---------------------------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------------------------

/**
 * One connection to an outside service. Secrets (OAuth tokens, API tokens, signing secrets) are
 * stored encrypted (AES-256-GCM, integrations/secret-box.ts); `token_hash` holds the SHA-256 of
 * a bearer token we issued (Obsidian vault sync), for lookup without storing the token.
 */
export const integrationConnections = appSchema.table(
  'integration_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    name: text('name').notNull(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id),
    personal: boolean('personal').notNull(),
    direction: text('direction'),
    status: text('status').notNull().default('active'),
    paused: boolean('paused').notNull().default(false),
    teamId: uuid('team_id'),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    secrets: text('secrets'),
    tokenHash: text('token_hash'),
    cursor: jsonb('cursor').$type<Record<string, unknown>>().notNull().default({}),
    channel: jsonb('channel').$type<Record<string, unknown>>(),
    lastSyncAt: tstz('last_sync_at'),
    lastErrorCode: text('last_error_code'),
    lastErrorMessage: text('last_error_message'),
    lastErrorAt: tstz('last_error_at'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    failureNotifiedAt: tstz('failure_notified_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    disconnectedAt: tstz('disconnected_at'),
  },
  (t) => [
    unique('integration_connections_org_id_unique').on(t.organizationId, t.id),
    uniqueIndex('integration_connections_token_hash_unique')
      .on(t.tokenHash)
      .where(sql`${t.tokenHash} is not null`),
    // One live personal connection per member and provider.
    uniqueIndex('integration_connections_one_personal')
      .on(t.organizationId, t.ownerUserId, t.provider)
      .where(sql`${t.personal} and ${t.status} <> 'disconnected'`),
    index('integration_connections_org_idx').on(t.organizationId, t.provider),
    foreignKey({
      name: 'integration_connections_team_fk',
      columns: [t.organizationId, t.teamId],
      foreignColumns: [teams.organizationId, teams.id],
    }).onDelete('restrict'),
  ],
);

/**
 * Which remote record mirrors which meeting, per connection — the duplicate-prevention map.
 * `synced_snapshot` is the meeting's synced fields as both sides last agreed on them: the base
 * of the three-way merge (integrations/sync-engine.ts).
 */
export const integrationLinks = appSchema.table(
  'integration_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    meetingId: uuid('meeting_id').notNull(),
    remoteId: text('remote_id'),
    remoteVersion: text('remote_version'),
    remoteUrl: text('remote_url'),
    syncedSnapshot: jsonb('synced_snapshot').$type<Record<string, unknown>>(),
    localVersion: integer('local_version'),
    state: text('state').notNull().default('active'),
    lastSyncedAt: tstz('last_synced_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('integration_links_connection_meeting_unique').on(t.connectionId, t.meetingId),
    uniqueIndex('integration_links_connection_remote_unique')
      .on(t.connectionId, t.remoteId)
      .where(sql`${t.remoteId} is not null`),
    index('integration_links_meeting_idx').on(t.organizationId, t.meetingId),
    foreignKey({
      name: 'integration_links_connection_fk',
      columns: [t.organizationId, t.connectionId],
      foreignColumns: [integrationConnections.organizationId, integrationConnections.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'integration_links_meeting_fk',
      columns: [t.organizationId, t.meetingId],
      foreignColumns: [meetings.organizationId, meetings.id],
    }).onDelete('cascade'),
  ],
);

/**
 * Durable work queue (pushes, pulls, webhook deliveries, channel renewals). Claimed with
 * FOR UPDATE SKIP LOCKED so several API instances can share it; a pending job with the same
 * dedupe key is coalesced instead of queued twice.
 */
export const integrationJobs = appSchema.table(
  'integration_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    kind: text('kind').notNull(),
    meetingId: uuid('meeting_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: tstz('next_attempt_at').notNull().defaultNow(),
    lockedUntil: tstz('locked_until'),
    lastError: text('last_error'),
    dedupeKey: text('dedupe_key'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    finishedAt: tstz('finished_at'),
  },
  (t) => [
    index('integration_jobs_due_idx').on(t.status, t.nextAttemptAt),
    index('integration_jobs_connection_idx').on(t.connectionId, t.status),
    uniqueIndex('integration_jobs_pending_dedupe')
      .on(t.connectionId, t.dedupeKey)
      .where(sql`${t.status} = 'pending' and ${t.dedupeKey} is not null`),
    foreignKey({
      name: 'integration_jobs_connection_fk',
      columns: [t.organizationId, t.connectionId],
      foreignColumns: [integrationConnections.organizationId, integrationConnections.id],
    }).onDelete('cascade'),
  ],
);

/** What happened on a connection: syncs, conflicts, failures, deliveries. Append-only. */
export const integrationEvents = appSchema.table(
  'integration_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    level: text('level').notNull(),
    code: text('code').notNull(),
    message: text('message').notNull(),
    meetingId: uuid('meeting_id'),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index('integration_events_connection_idx').on(t.connectionId, t.createdAt),
    foreignKey({
      name: 'integration_events_connection_fk',
      columns: [t.organizationId, t.connectionId],
      foreignColumns: [integrationConnections.organizationId, integrationConnections.id],
    }).onDelete('restrict'),
  ],
);

/** Message ids of accepted incoming webhooks (replay protection). Pruned after a day. */
export const webhookReceipts = appSchema.table(
  'webhook_receipts',
  {
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => integrationConnections.id, { onDelete: 'cascade' }),
    messageId: text('message_id').notNull(),
    receivedAt: createdAt(),
  },
  (t) => [primaryKey({ name: 'webhook_receipts_pk', columns: [t.connectionId, t.messageId] })],
);
