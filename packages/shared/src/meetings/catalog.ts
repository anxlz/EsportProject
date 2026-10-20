/**
 * Meetings, calendar and integrations (Phase 6, spec §14). Keys are stored in the database and
 * mirrored by CHECK constraints in migration 0011; labels live in the web app's message catalogs.
 */

/**
 * `standard` meetings belong to a team, a department or (with an organization-wide grant) the
 * whole organization. `administrative` meetings are organization-wide meetings the Owner calls.
 */
export const MEETING_KINDS = ['standard', 'administrative'] as const;
export type MeetingKind = (typeof MEETING_KINDS)[number];

export const MEETING_STATUSES = ['scheduled', 'cancelled'] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

/** Calendar-invite model: invitees confirm or decline; nothing needs approval. */
export const RSVP_RESPONSES = ['pending', 'accepted', 'declined'] as const;
export type RsvpResponse = (typeof RSVP_RESPONSES)[number];

export const RECURRENCE_FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

/** ISO weekday order (Monday first), using iCalendar's two-letter codes. */
export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** Reminder offsets a meeting can use (minutes before each occurrence). */
export const REMINDER_OPTIONS = [5, 15, 30, 60, 120, 1440, 2880] as const;
export const DEFAULT_REMINDERS = [15];

export const MEETING_LIMITS = {
  titleMax: 200,
  descriptionMax: 5000,
  notesMax: 20000,
  participantsMax: 200,
  remindersMax: 3,
  /** Longest single occurrence. */
  durationMaxMinutes: 24 * 60,
  durationMinMinutes: 5,
  /** A series must end (spec: "frequency + end condition"). */
  countMax: 365,
  untilMaxYears: 3,
  intervalMax: 30,
  /** Widest window the calendar list endpoint expands at once. */
  listWindowDays: 100,
} as const;

// ---------- Integrations ----------

export const INTEGRATION_PROVIDERS = [
  'google_calendar',
  'notion',
  'obsidian',
  'webhook_outgoing',
  'webhook_incoming',
] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

/** Personal integrations belong to one member; the others are managed for the organization. */
export const PERSONAL_PROVIDERS: readonly IntegrationProvider[] = ['google_calendar', 'obsidian'];

/** Two-way is the default; push-only never reads changes back from the provider. */
export const SYNC_DIRECTIONS = ['two_way', 'push_only'] as const;
export type SyncDirection = (typeof SYNC_DIRECTIONS)[number];

/** Which providers sync meetings both ways (webhooks are one-way by nature). */
export const TWO_WAY_PROVIDERS: readonly IntegrationProvider[] = [
  'google_calendar',
  'notion',
  'obsidian',
];

export const INTEGRATION_STATUSES = [
  'active',
  /** Needs attention (credentials rejected, endpoint gone…); syncing is paused. */
  'error',
  'disconnected',
] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

/** Events an outgoing webhook can subscribe to. */
export const WEBHOOK_EVENT_TYPES = [
  'meeting.created',
  'meeting.updated',
  'meeting.cancelled',
  'meeting.response',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** What an incoming webhook may ask for (always as its owner, with their permissions). */
export const INCOMING_WEBHOOK_ACTIONS = [
  'meeting.create',
  'meeting.update',
  'meeting.cancel',
] as const;
export type IncomingWebhookAction = (typeof INCOMING_WEBHOOK_ACTIONS)[number];

/** Integration log entries (shown to the integration's owner, labels translated). */
export const INTEGRATION_EVENT_CODES = [
  'connected',
  'settings_changed',
  'disconnected',
  'synced',
  'pushed',
  'pulled',
  'imported',
  'conflict_resolved',
  'remote_change_rejected',
  'remote_change_ignored',
  'import_skipped',
  'unsupported_recurrence',
  'full_resync',
  'rate_limited',
  'retry_scheduled',
  'failed',
  'auth_failed',
  'channel_renewed',
  'verification_received',
  'signature_rejected',
  'delivered',
  'delivery_failed',
  'endpoint_disabled',
  'webhook_received',
  'webhook_rejected',
] as const;
export type IntegrationEventCode = (typeof INTEGRATION_EVENT_CODES)[number];

export const INTEGRATION_EVENT_LEVELS = ['info', 'warn', 'error'] as const;
export type IntegrationEventLevel = (typeof INTEGRATION_EVENT_LEVELS)[number];

/**
 * Meeting fields that integrations carry, and so the fields the three-way merge works on.
 * Participants' responses are synced separately (each person owns their own response).
 */
export const SYNCED_FIELDS = [
  'title',
  'description',
  'notes',
  'startLocal',
  'endLocal',
  'timeZone',
  'recurrence',
  'status',
] as const;
export type SyncedField = (typeof SYNCED_FIELDS)[number];
