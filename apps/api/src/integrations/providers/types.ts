/** What the generic sync engine needs from a provider whose records live behind an API. */
import type { RsvpResponse } from '@esports/shared';
import type { integrationLinks } from '../../db/schema-meetings';
import type { LoadedMeeting } from '../../meetings/meetings.service';
import type { ConnectionRow } from '../connections.service';
import type { Snapshot, SnapshotKey } from '../sync-engine';

export type LinkRow = typeof integrationLinks.$inferSelect;

/** The meeting as one connection should show it. */
export interface MeetingView {
  loaded: LoadedMeeting;
  snapshot: Snapshot;
  /** Personal calendars: the owner's response (pending → tentative, accepted → confirmed). */
  ownerResponse: RsvpResponse | null;
  locale: 'ar' | 'en';
}

export interface RemoteRecord {
  id: string;
  /** Changes whenever the record's content changes (etag, or a content hash). */
  version: string;
  url: string | null;
  deleted: boolean;
  /** Our meeting id, if the record says it mirrors one (extended property / Platform ID). */
  platformMeetingId: string | null;
  /** The fields this provider can represent; null if the record can't be read as a meeting. */
  snapshot: Partial<Snapshot> | null;
  unsupported?: string;
  /** Google: a changed occurrence of a recurring event. */
  instanceOf?: {
    remoteId: string;
    originalStart: string;
    cancelled: boolean;
    startLocal?: string;
    endLocal?: string;
  };
}

export interface RemoteChanges {
  records: RemoteRecord[];
  /** The provider dropped our sync position: everything was listed again (no duplicates). */
  fullResync: boolean;
  /** Saves the new position; called after every record has been processed. */
  commit: () => Promise<void>;
}

export interface RemoteProvider {
  readonly name: 'google_calendar' | 'notion';
  /** Fields a change at the provider can update on the platform. */
  readonly inboundKeys: SnapshotKey[];
  /** Whether records created at the provider become meetings. */
  importsNew(c: ConnectionRow): boolean;
  create(c: ConnectionRow, view: MeetingView): Promise<RemoteRecord>;
  update(c: ConnectionRow, link: LinkRow, view: MeetingView): Promise<RemoteRecord>;
  remove(c: ConnectionRow, link: LinkRow): Promise<void>;
  get(c: ConnectionRow, remoteId: string): Promise<RemoteRecord | null>;
  /** Looks for a record already mirroring this meeting (recovery after an interrupted create). */
  find(c: ConnectionRow, meetingId: string): Promise<RemoteRecord | null>;
  changes(c: ConnectionRow, opts: { full: boolean; pageIds?: string[] }): Promise<RemoteChanges>;
}
