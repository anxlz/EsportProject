/**
 * Time zones and recurrence, without a date library.
 *
 * A meeting stores its first start as a wall-clock time ("2026-10-21T18:00") in an IANA time
 * zone, plus a duration. Occurrences are generated in wall-clock time and only then converted to
 * UTC, so a 18:00 weekly meeting stays at 18:00 local time across daylight-saving changes (the
 * way calendar apps behave). Conversions use the platform's Intl time-zone data.
 *
 * Rules follow RFC 5545 semantics for the subset we support (FREQ=DAILY/WEEKLY/MONTHLY with
 * INTERVAL, BYDAY for weekly, the start's day of month for monthly, and COUNT or UNTIL):
 * - a monthly rule on the 31st skips months that have no 31st;
 * - COUNT counts generated occurrences, including ones later cancelled (as EXDATE does);
 * - a wall-clock time that doesn't exist (skipped by a DST change) uses the offset before the
 *   change; an ambiguous one (repeated hour) uses its first occurrence.
 */
import { MEETING_LIMITS, type RecurrenceFrequency, type Weekday, WEEKDAYS } from './catalog';

export interface RecurrenceRule {
  freq: RecurrenceFrequency;
  interval: number;
  /** Weekly only: the days it repeats on (the start's own weekday must be one of them). */
  byWeekday?: Weekday[];
  end: { type: 'count'; count: number } | { type: 'until'; until: string };
}

export interface LocalDateTime {
  y: number;
  m: number; // 1-12
  d: number;
  h: number;
  mi: number;
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseLocal(s: string): LocalDateTime | null {
  const m = LOCAL_RE.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) || h > 23 || mi > 59) return null;
  return { y, m: mo, d, h, mi };
}

export function parseDate(s: string): { y: number; m: number; d: number } | null {
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const [y, mo, d] = m.slice(1).map(Number) as [number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  return { y, m: mo, d };
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
export const formatLocal = (l: LocalDateTime) =>
  `${pad(l.y, 4)}-${pad(l.m)}-${pad(l.d)}T${pad(l.h)}:${pad(l.mi)}`;
export const localDate = (l: { y: number; m: number; d: number }) =>
  `${pad(l.y, 4)}-${pad(l.m)}-${pad(l.d)}`;

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Monday = 0 … Sunday = 6. */
export function weekdayIndex(y: number, m: number, d: number): number {
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

function addDays(l: LocalDateTime, days: number): LocalDateTime {
  const t = new Date(Date.UTC(l.y, l.m - 1, l.d + days));
  return { ...l, y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

// ---------------------------------------------------------------- time zones

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64 || !/^[A-Za-z_+\-/0-9]+$/.test(tz)) return false;
  try {
    dtf(tz);
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock fields of a UTC instant in a time zone. */
export function utcToLocal(utcMs: number, tz: string): LocalDateTime & { s: number } {
  const parts = dtf(tz).formatToParts(new Date(utcMs));
  const get = (t: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === t)?.value ?? 0);
  return {
    y: get('year'),
    m: get('month'),
    d: get('day'),
    h: get('hour'),
    mi: get('minute'),
    s: get('second'),
  };
}

/** UTC offset (minutes east of UTC) in effect at a UTC instant. */
export function offsetMinutes(utcMs: number, tz: string): number {
  const floored = Math.floor(utcMs / 1000) * 1000;
  const l = utcToLocal(floored, tz);
  return Math.round((Date.UTC(l.y, l.m - 1, l.d, l.h, l.mi, l.s) - floored) / 60000);
}

/** UTC instant of a wall-clock time in a time zone (see the DST rules at the top). */
export function localToUtc(l: LocalDateTime, tz: string): number {
  const guess = Date.UTC(l.y, l.m - 1, l.d, l.h, l.mi);
  const before = offsetMinutes(guess - 86_400_000, tz);
  const after = offsetMinutes(guess + 86_400_000, tz);
  const valid = [...new Set([before, after])]
    .map((off) => guess - off * 60_000)
    .filter((utc) => {
      const back = utcToLocal(utc, tz);
      return (
        back.y === l.y && back.m === l.m && back.d === l.d && back.h === l.h && back.mi === l.mi
      );
    })
    .sort((a, b) => a - b);
  // Two valid instants: the repeated hour, take the first. None: the skipped hour.
  return valid[0] ?? guess - before * 60_000;
}

/** "2026-10-21T18:00:00+03:00" for a UTC instant, with the zone's offset at that moment. */
export function isoWithOffset(utcMs: number, tz: string): string {
  const l = utcToLocal(utcMs, tz);
  const off = offsetMinutes(utcMs, tz);
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  return `${formatLocal(l)}:${pad(l.s)}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

// ---------------------------------------------------------------- rules

/** Why a rule can't be used with this start (null = fine). */
export function ruleProblem(rule: RecurrenceRule, startLocal: string): string | null {
  const start = parseLocal(startLocal);
  if (!start) return 'invalid_start';
  if (
    !Number.isInteger(rule.interval) ||
    rule.interval < 1 ||
    rule.interval > MEETING_LIMITS.intervalMax
  )
    return 'invalid_interval';
  if (rule.freq === 'weekly') {
    const days = rule.byWeekday?.length ? rule.byWeekday : null;
    if (days && !days.includes(WEEKDAYS[weekdayIndex(start.y, start.m, start.d)]!))
      return 'start_not_on_weekday';
  } else if (rule.byWeekday?.length) return 'weekday_only_for_weekly';
  if (rule.end.type === 'count') {
    if (
      !Number.isInteger(rule.end.count) ||
      rule.end.count < 1 ||
      rule.end.count > MEETING_LIMITS.countMax
    )
      return 'invalid_count';
  } else {
    const u = parseDate(rule.end.until);
    if (!u) return 'invalid_until';
    const startDate = localDate(start);
    if (rule.end.until < startDate) return 'until_before_start';
    const max = { ...start, y: start.y + MEETING_LIMITS.untilMaxYears };
    if (rule.end.until > localDate(max)) return 'until_too_far';
  }
  // Whatever the end condition, a series stays within the same horizon.
  const starts = seriesStarts(startLocal, rule);
  const last = starts[starts.length - 1];
  const limit = localDate({ ...start, y: start.y + MEETING_LIMITS.untilMaxYears });
  if (!last || localDate(last) > limit) return 'series_too_long';
  if (rule.end.type === 'count' && starts.length < rule.end.count) return 'series_too_long';
  return null;
}

/** Normalized copy: weekly rules always list their days, sorted Monday first. */
export function normalizeRule(rule: RecurrenceRule, startLocal: string): RecurrenceRule {
  const start = parseLocal(startLocal)!;
  const out: RecurrenceRule = { freq: rule.freq, interval: rule.interval, end: { ...rule.end } };
  if (rule.freq === 'weekly') {
    const days = rule.byWeekday?.length
      ? rule.byWeekday
      : [WEEKDAYS[weekdayIndex(start.y, start.m, start.d)]!];
    out.byWeekday = [...new Set(days)].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b));
  }
  return out;
}

/**
 * Wall-clock start times of a series, in order (at most COUNT, or up to UNTIL inclusive).
 * A single meeting (no rule) has exactly its start.
 */
export function seriesStarts(startLocal: string, rule: RecurrenceRule | null): LocalDateTime[] {
  const start = parseLocal(startLocal);
  if (!start) return [];
  if (!rule) return [start];
  const r = normalizeRule(rule, startLocal);
  const out: LocalDateTime[] = [];
  const maxCount = r.end.type === 'count' ? r.end.count : MEETING_LIMITS.countMax * 31;
  const until = r.end.type === 'until' ? r.end.until : null;
  const done = (l: LocalDateTime) =>
    (until !== null && localDate(l) > until) || out.length >= maxCount;
  const startDate = localDate(start);

  if (r.freq === 'daily') {
    for (let k = 0; ; k++) {
      const l = addDays(start, k * r.interval);
      if (done(l)) break;
      out.push(l);
    }
  } else if (r.freq === 'weekly') {
    const weekStart = addDays(start, -weekdayIndex(start.y, start.m, start.d));
    const offsets = r.byWeekday!.map((w) => WEEKDAYS.indexOf(w));
    outer: for (let w = 0; ; w++) {
      for (const off of offsets) {
        const l = addDays(weekStart, w * 7 * r.interval + off);
        if (localDate(l) < startDate) continue;
        if (done(l)) break outer;
        out.push(l);
      }
    }
  } else {
    // Monthly on the start's day of month; months without that day are skipped (RFC 5545).
    for (let k = 0; k < 12 * 40; k++) {
      const months = start.m - 1 + k * r.interval;
      const y = start.y + Math.floor(months / 12);
      const m = (months % 12) + 1;
      if (start.d > daysInMonth(y, m)) continue;
      const l = { ...start, y, m };
      if (done(l)) break;
      out.push(l);
    }
  }
  return out;
}

export interface Occurrence {
  /** Identifies the occurrence even if it is moved: its original start in UTC (ISO). */
  key: string;
  startUtc: number;
  endUtc: number;
}

export interface OccurrenceOverride {
  originalStart: string;
  status: 'cancelled' | 'moved';
  start: string | null;
  end: string | null;
}

/** Every occurrence of a series in UTC, before per-occurrence changes. */
export function seriesOccurrences(
  startLocal: string,
  durationMinutes: number,
  tz: string,
  rule: RecurrenceRule | null,
): Occurrence[] {
  return seriesStarts(startLocal, rule).map((l) => {
    const startUtc = localToUtc(l, tz);
    return {
      key: new Date(startUtc).toISOString(),
      startUtc,
      endUtc: startUtc + durationMinutes * 60_000,
    };
  });
}

/**
 * Occurrences overlapping [fromUtc, toUtc), with cancellations and moves applied. Cancelled
 * occurrences are returned flagged (calendars show them struck through), moved ones at their
 * new time.
 */
export function occurrencesBetween(
  series: {
    startLocal: string;
    durationMinutes: number;
    timeZone: string;
    recurrence: RecurrenceRule | null;
  },
  overrides: OccurrenceOverride[],
  fromUtc: number,
  toUtc: number,
): (Occurrence & { cancelled: boolean; moved: boolean })[] {
  const byKey = new Map(overrides.map((o) => [new Date(o.originalStart).toISOString(), o]));
  const out: (Occurrence & { cancelled: boolean; moved: boolean })[] = [];
  for (const o of seriesOccurrences(
    series.startLocal,
    series.durationMinutes,
    series.timeZone,
    series.recurrence,
  )) {
    const ov = byKey.get(o.key);
    const moved = ov?.status === 'moved' && ov.start && ov.end;
    const startUtc = moved ? Date.parse(ov.start!) : o.startUtc;
    const endUtc = moved ? Date.parse(ov.end!) : o.endUtc;
    if (endUtc <= fromUtc || startUtc >= toUtc) continue;
    out.push({
      key: o.key,
      startUtc,
      endUtc,
      cancelled: ov?.status === 'cancelled',
      moved: !!moved,
    });
  }
  return out.sort((a, b) => a.startUtc - b.startUtc);
}

/** End of the last occurrence (used to index which series are still running). */
export function seriesEndUtc(
  startLocal: string,
  durationMinutes: number,
  tz: string,
  rule: RecurrenceRule | null,
): number {
  const all = seriesOccurrences(startLocal, durationMinutes, tz, rule);
  return all.length ? all[all.length - 1]!.endUtc : localToUtc(parseLocal(startLocal)!, tz);
}

// ---------------------------------------------------------------- iCalendar RRULE

/** RRULE line for calendar providers. UNTIL is in UTC (required with a TZID start). */
export function toRRule(rule: RecurrenceRule, startLocal: string, tz: string): string {
  const r = normalizeRule(rule, startLocal);
  const parts = [`FREQ=${r.freq.toUpperCase()}`];
  if (r.interval > 1) parts.push(`INTERVAL=${r.interval}`);
  if (r.freq === 'weekly') parts.push(`BYDAY=${r.byWeekday!.join(',')}`);
  if (r.end.type === 'count') parts.push(`COUNT=${r.end.count}`);
  else {
    // The last moment of the UNTIL day in the meeting's zone, as UTC.
    const u = parseDate(r.end.until)!;
    const endOfDay = localToUtc({ ...u, h: 23, mi: 59 }, tz) + 59_000;
    const d = new Date(endOfDay);
    parts.push(
      `UNTIL=${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`,
    );
  }
  return `RRULE:${parts.join(';')}`;
}

export type ParsedRecurrence =
  { ok: true; rule: RecurrenceRule; exdates: string[] } | { ok: false; reason: string };

/**
 * Reads a provider's recurrence lines back. Only what this platform can represent is accepted;
 * anything else is reported (and such events are not imported or changed — see DECISIONS.md).
 */
export function fromRRule(lines: string[], startLocal: string, tz: string): ParsedRecurrence {
  let rule: RecurrenceRule | null = null;
  const exdates: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('EXDATE')) {
      const [head, value] = splitOnce(line, ':');
      const tzid = /TZID=([^;:]+)/.exec(head)?.[1];
      for (const v of (value ?? '').split(',')) {
        const utc = icalDateTimeToUtc(v.trim(), tzid ?? tz);
        if (utc === null) return { ok: false, reason: 'unsupported_exdate' };
        exdates.push(new Date(utc).toISOString());
      }
      continue;
    }
    if (!line.startsWith('RRULE:')) return { ok: false, reason: 'unsupported_line' };
    if (rule) return { ok: false, reason: 'multiple_rules' };
    const kv = new Map<string, string>();
    for (const p of line.slice(6).split(';')) {
      const [k, v] = splitOnce(p, '=');
      if (k && v !== undefined) kv.set(k.toUpperCase(), v);
    }
    const freq = kv.get('FREQ');
    if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY')
      return { ok: false, reason: 'unsupported_frequency' };
    const known = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'COUNT', 'UNTIL', 'WKST']);
    for (const k of kv.keys())
      if (!known.has(k)) return { ok: false, reason: `unsupported_${k.toLowerCase()}` };
    if (kv.has('WKST') && kv.get('WKST') !== 'MO') return { ok: false, reason: 'unsupported_wkst' };
    const interval = kv.has('INTERVAL') ? Number(kv.get('INTERVAL')) : 1;
    const start = parseLocal(startLocal);
    if (!start) return { ok: false, reason: 'invalid_start' };
    let byWeekday: Weekday[] | undefined;
    if (kv.has('BYDAY')) {
      if (freq !== 'WEEKLY') return { ok: false, reason: 'unsupported_byday' };
      const days = kv.get('BYDAY')!.split(',');
      if (!days.every((d): d is Weekday => (WEEKDAYS as readonly string[]).includes(d)))
        return { ok: false, reason: 'unsupported_byday' };
      byWeekday = days;
    }
    if (kv.has('BYMONTHDAY')) {
      if (freq !== 'MONTHLY' || Number(kv.get('BYMONTHDAY')) !== start.d)
        return { ok: false, reason: 'unsupported_bymonthday' };
    }
    let end: RecurrenceRule['end'];
    if (kv.has('COUNT')) end = { type: 'count', count: Number(kv.get('COUNT')) };
    else if (kv.has('UNTIL')) {
      const utc = icalDateTimeToUtc(kv.get('UNTIL')!, 'UTC');
      if (utc === null) return { ok: false, reason: 'invalid_until' };
      end = { type: 'until', until: localDate(utcToLocal(utc, tz)) };
    } else return { ok: false, reason: 'no_end' };
    rule = {
      freq: freq.toLowerCase() as RecurrenceFrequency,
      interval,
      ...(byWeekday ? { byWeekday } : {}),
      end,
    };
    const problem = ruleProblem(rule, startLocal);
    if (problem) return { ok: false, reason: problem };
  }
  if (!rule) return { ok: false, reason: 'no_rule' };
  return { ok: true, rule: normalizeRule(rule, startLocal), exdates };
}

function splitOnce(s: string, sep: string): [string, string | undefined] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, undefined] : [s.slice(0, i), s.slice(i + 1)];
}

/** "20261231T235959Z", "20261231T180000" (in tz) or "20261231" → UTC ms. */
function icalDateTimeToUtc(v: string, tz: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const h = Number(m[4] ?? 0);
  const mi = Number(m[5] ?? 0);
  const s = Number(m[6] ?? 0);
  if (m[7] === 'Z' || tz === 'UTC') return Date.UTC(y, mo - 1, d, h, mi, s);
  return localToUtc({ y, m: mo, d, h, mi }, tz) + s * 1000;
}
