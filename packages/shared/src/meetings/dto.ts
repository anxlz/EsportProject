/** Response shapes for meetings and integrations (Phase 6). */
import type {
  IncomingWebhookAction,
  IntegrationEventCode,
  IntegrationEventLevel,
  IntegrationProvider,
  IntegrationStatus,
  MeetingKind,
  MeetingStatus,
  RsvpResponse,
  SyncDirection,
  WebhookEventType,
} from './catalog';
import type { RecurrenceRule } from './recurrence';

export interface MeetingParticipantDto {
  userId: string;
  displayName: string;
  response: RsvpResponse;
  respondedAt: string | null;
  note: string | null;
  isOrganizer: boolean;
}

export interface MeetingOverrideDto {
  originalStart: string;
  status: 'cancelled' | 'moved';
  start: string | null;
  end: string | null;
}

export interface MeetingSyncLinkDto {
  connectionId: string;
  provider: IntegrationProvider;
  remoteUrl: string | null;
  lastSyncedAt: string | null;
}

export interface MeetingDto {
  id: string;
  kind: MeetingKind;
  title: string;
  description: string | null;
  notes: string | null;
  teamId: string | null;
  teamName: string | null;
  departmentId: string | null;
  departmentName: string | null;
  timeZone: string;
  /** First occurrence, wall-clock in the meeting's zone ("2026-10-21T18:00"). */
  startLocal: string;
  endLocal: string;
  /** First occurrence, ISO with offset. */
  start: string;
  end: string;
  durationMinutes: number;
  recurrence: RecurrenceRule | null;
  /** End of the last occurrence. */
  seriesEnd: string;
  status: MeetingStatus;
  cancelReason: string | null;
  organizer: { id: string; displayName: string } | null;
  participants: MeetingParticipantDto[];
  myResponse: RsvpResponse | null;
  reminderMinutes: number[];
  overrides: MeetingOverrideDto[];
  /** Upcoming occurrences (next 10 from now), cancelled ones flagged. */
  upcoming: MeetingOccurrenceDto[];
  version: number;
  canEdit: boolean;
  canRespond: boolean;
  syncLinks: MeetingSyncLinkDto[];
  source: 'platform' | 'google_calendar' | 'notion' | 'obsidian' | 'webhook';
  createdAt: string;
  updatedAt: string;
}

/** One occurrence in a calendar window. */
export interface MeetingOccurrenceDto {
  meetingId: string;
  /** The occurrence's original start (UTC ISO): its identity, even when moved. */
  key: string;
  start: string;
  end: string;
  title: string;
  kind: MeetingKind;
  teamName: string | null;
  departmentName: string | null;
  timeZone: string;
  status: MeetingStatus;
  cancelled: boolean;
  moved: boolean;
  recurring: boolean;
  myResponse: RsvpResponse | null;
  isOrganizer: boolean;
}

export interface IntegrationDto {
  id: string;
  provider: IntegrationProvider;
  name: string;
  personal: boolean;
  owner: { id: string; displayName: string } | null;
  direction: SyncDirection | null;
  status: IntegrationStatus;
  paused: boolean;
  teamId: string | null;
  teamName: string | null;
  /** Provider-specific, non-secret settings (calendar id, database title, URL…). */
  settings: {
    calendarId?: string;
    databaseTitle?: string | null;
    url?: string;
    events?: WebhookEventType[];
    actions?: IncomingWebhookAction[];
    /** Incoming webhooks / Notion: where the provider must send requests. */
    endpointUrl?: string;
    /** Notion: the subscription token waiting to be pasted into Notion's settings. */
    verificationToken?: string | null;
  };
  lastSyncAt: string | null;
  lastError: { code: string; message: string; at: string } | null;
  linkedMeetings: number;
  pendingJobs: number;
  createdAt: string;
}

export interface IntegrationEventDto {
  id: string;
  level: IntegrationEventLevel;
  code: IntegrationEventCode;
  message: string;
  meetingId: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

/** Shown once, when a secret is created or rotated. */
export interface IntegrationSecretDto {
  integration: IntegrationDto;
  /** whsec_… signing secret (webhooks) or the Obsidian vault-sync token. */
  secret: string;
}

export interface IntegrationProvidersDto {
  google: { configured: boolean };
  notion: { configured: true };
  obsidian: { configured: true };
  webhooks: { configured: true };
  /** Base URL that external services call (webhooks, push notifications). */
  publicBaseUrl: string;
}

export interface ObsidianFeedNote {
  meetingId: string;
  /** Path inside the vault folder the companion writes to. */
  path: string;
  version: number;
  deleted: boolean;
  content: string | null;
}

export interface ObsidianFeedDto {
  notes: ObsidianFeedNote[];
  cursor: string;
  direction: SyncDirection;
}

export interface ObsidianPushResultDto {
  results: {
    meetingId: string;
    outcome: 'applied' | 'unchanged' | 'conflict' | 'rejected' | 'ignored' | 'not_found';
    /** The note as the platform now has it (write this back into the vault). */
    content: string | null;
    version: number | null;
    message?: string;
  }[];
}
