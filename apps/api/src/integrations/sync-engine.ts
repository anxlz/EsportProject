/**
 * The two-way sync rules, as pure functions (unit-tested in test/integrations-unit.test.ts).
 *
 * Every link between a meeting and a remote record keeps a snapshot of the synced fields as
 * both sides last agreed on them. When either side changes, the three versions (that base, the
 * platform's current values, the provider's current values) are merged field by field:
 *
 *   changed only on the platform  → the platform's value is pushed to the provider;
 *   changed only at the provider  → the provider's value is applied to the meeting (if the
 *                                   connection's owner may change the meeting; otherwise the
 *                                   change is rejected and the platform's value pushed back);
 *   changed on both, to the same value → nothing to do;
 *   changed on both, differently  → CONFLICT: the platform's value wins, the provider is
 *                                   overwritten, and the conflict is logged with both values
 *                                   and the connection's owner is notified.
 *
 * The platform wins conflicts because it's the system of record: its changes are
 * permission-checked and audited, while a provider-side edit may come from anyone with access
 * to that calendar or database. Start, end and time zone merge as one field ("time") so a
 * merge can never combine one side's start with the other side's end. On a personal calendar
 * the owner's own response is merged the same way (whichever side changed it; both → platform).
 */
import {
  MEETING_STATUSES,
  RSVP_RESPONSES,
  recurrenceRuleSchema,
  type RecurrenceRule,
  type RsvpResponse,
} from '@esports/shared';
import { z } from 'zod';

export interface Snapshot {
  title: string;
  description: string | null;
  notes: string | null;
  time: { startLocal: string; endLocal: string; timeZone: string };
  recurrence: RecurrenceRule | null;
  /** Cancelled occurrences (original starts, UTC ISO), sorted. */
  exdates: string[];
  status: 'scheduled' | 'cancelled';
  /** Personal calendars: the connection owner's own response. */
  response?: RsvpResponse | null;
}

const snapshotSchema: z.ZodType<Snapshot> = z
  .object({
    title: z.string(),
    description: z.string().nullable(),
    notes: z.string().nullable(),
    time: z.object({
      startLocal: z.string(),
      endLocal: z.string(),
      timeZone: z.string(),
    }),
    recurrence: recurrenceRuleSchema.nullable(),
    exdates: z.array(z.string()),
    status: z.enum(MEETING_STATUSES),
    response: z.enum(RSVP_RESPONSES).nullable().optional(),
  })
  .transform((snapshot): Snapshot => ({
    title: snapshot.title!,
    description: snapshot.description!,
    notes: snapshot.notes!,
    time: {
      startLocal: snapshot.time!.startLocal!,
      endLocal: snapshot.time!.endLocal!,
      timeZone: snapshot.time!.timeZone!,
    },
    recurrence: snapshot.recurrence ?? null,
    exdates: snapshot.exdates!,
    status: snapshot.status!,
    ...(snapshot.response === undefined ? {} : { response: snapshot.response }),
  }));

/** Validate JSON read from the database before using it as a merge baseline. */
export function parseSnapshot(value: unknown): Snapshot | null {
  return value === null ? null : snapshotSchema.parse(value);
}

export type SnapshotKey = keyof Snapshot;
export const ALL_KEYS: SnapshotKey[] = [
  'title',
  'description',
  'notes',
  'time',
  'recurrence',
  'exdates',
  'status',
  'response',
];

/** JSON with sorted object keys, so equal values compare equal. */
export function stable(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  return `{${Object.keys(v as object)
    .sort()
    .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

export const same = (a: unknown, b: unknown) => stable(a) === stable(b);

export function changedKeys(
  base: Snapshot | null,
  next: Snapshot,
  keys: SnapshotKey[] = ALL_KEYS,
): SnapshotKey[] {
  if (!base) return keys.filter((k) => next[k] !== undefined);
  return keys.filter((k) => !same(base[k], next[k]));
}

export interface Conflict {
  field: SnapshotKey;
  platform: unknown;
  provider: unknown;
}

export interface MergeResult {
  /** The values both sides should end up with. */
  merged: Snapshot;
  /** Fields to change on the platform (provider-only changes). */
  applyLocally: Partial<Snapshot>;
  /** Whether the provider needs the merged values written to it. */
  pushRemote: boolean;
  conflicts: Conflict[];
}

/**
 * Three-way merge. `keys` limits it to the fields the provider can represent; the others keep
 * the platform's values and never count as provider changes.
 */
export function threeWayMerge(
  base: Snapshot | null,
  platform: Snapshot,
  provider: Snapshot,
  keys: SnapshotKey[] = ALL_KEYS,
): MergeResult {
  const merged: Snapshot = structuredClone(platform);
  const applyLocally: Partial<Snapshot> = {};
  const conflicts: Conflict[] = [];
  let pushRemote = false;
  for (const k of keys) {
    const p = platform[k];
    const r = provider[k];
    if (same(p, r)) continue;
    const b = base ? base[k] : undefined;
    // Without a common base there's no telling who changed what: a difference is a conflict.
    const platformChanged = !base || !same(b, p);
    const providerChanged = !base || !same(b, r);
    if (providerChanged && !platformChanged) {
      (merged as unknown as Record<string, unknown>)[k] = structuredClone(r);
      (applyLocally as Record<string, unknown>)[k] = structuredClone(r);
    } else if (platformChanged && !providerChanged) {
      pushRemote = true;
    } else {
      // Both changed (or no common base): the platform wins, the provider is overwritten.
      conflicts.push({ field: k, platform: p, provider: r });
      pushRemote = true;
    }
  }
  return { merged, applyLocally, pushRemote, conflicts };
}
