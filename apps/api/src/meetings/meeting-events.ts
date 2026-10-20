/**
 * In-process notifications of meeting changes, emitted after the change has committed.
 * Integrations listen here to queue pushes and webhook deliveries, so the meetings module
 * doesn't depend on them. A listener failing never undoes or blocks the change itself.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { RsvpResponse } from '@esports/shared';

export type MeetingChange =
  | { type: 'created' }
  | { type: 'updated'; fields: string[] }
  | { type: 'cancelled' }
  | { type: 'occurrence_cancelled'; originalStart: string }
  | { type: 'occurrence_moved'; originalStart: string }
  | { type: 'response'; userId: string; response: RsvpResponse };

export interface MeetingEvent {
  organizationId: string;
  meetingId: string;
  change: MeetingChange;
  /** The integration connection the change came from (it doesn't need it pushed back). */
  originConnectionId?: string | null;
}

type Listener = (e: MeetingEvent) => Promise<void>;

@Injectable()
export class MeetingEvents {
  private readonly logger = new Logger('MeetingEvents');
  private readonly listeners: Listener[] = [];

  on(listener: Listener) {
    this.listeners.push(listener);
  }

  async emit(e: MeetingEvent): Promise<void> {
    for (const l of this.listeners) {
      try {
        await l(e);
      } catch (err) {
        this.logger.error(
          `Listener failed for ${e.change.type} on ${e.meetingId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
