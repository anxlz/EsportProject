import { describe, expect, test } from 'bun:test';
import {
  fromRRule,
  isoWithOffset,
  isValidTimeZone,
  localToUtc,
  occurrencesBetween,
  parseLocal,
  type RecurrenceRule,
  ruleProblem,
  seriesOccurrences,
  seriesStarts,
  toRRule,
  utcToLocal,
} from './recurrence';
import { incomingWebhookPayloadSchema, meetingCreateSchema, meetingListQuerySchema } from './schemas';
import { DEFAULT_ROLE_TEMPLATES, GRANTABLE_PERMISSION_KEYS } from '../permissions';

const iso = (ms: number) => new Date(ms).toISOString();
const local = (s: string) => parseLocal(s)!;
const starts = (start: string, rule: RecurrenceRule | null) =>
  seriesStarts(start, rule).map((l) => `${l.y}-${String(l.m).padStart(2, '0')}-${String(l.d).padStart(2, '0')}`);

describe('time zones', () => {
  test('Riyadh has a fixed +03:00 offset', () => {
    expect(iso(localToUtc(local('2026-10-21T18:00'), 'Asia/Riyadh'))).toBe('2026-10-21T15:00:00.000Z');
    expect(isoWithOffset(Date.parse('2026-10-21T15:00:00Z'), 'Asia/Riyadh')).toBe(
      '2026-10-21T18:00:00+03:00',
    );
  });

  test('a skipped wall-clock time (spring forward) uses the offset before the change', () => {
    // 2026-03-08 02:30 does not exist in New York; RFC 5545 reads it with the EST offset.
    expect(iso(localToUtc(local('2026-03-08T02:30'), 'America/New_York'))).toBe(
      '2026-03-08T07:30:00.000Z',
    );
  });

  test('a repeated wall-clock time (fall back) uses its first occurrence', () => {
    expect(iso(localToUtc(local('2026-11-01T01:30'), 'America/New_York'))).toBe(
      '2026-11-01T05:30:00.000Z',
    );
    expect(iso(localToUtc(local('2026-10-25T02:30'), 'Europe/Berlin'))).toBe(
      '2026-10-25T00:30:00.000Z',
    );
  });

  test('round trip and validation', () => {
    const utc = localToUtc(local('2026-07-01T09:15'), 'Europe/London');
    expect(utcToLocal(utc, 'Europe/London')).toMatchObject({ y: 2026, m: 7, d: 1, h: 9, mi: 15 });
    expect(isValidTimeZone('Asia/Riyadh')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});

describe('recurrence', () => {
  test('weekly on two days, by count, keeps the wall-clock time across a DST change', () => {
    const rule: RecurrenceRule = { freq: 'weekly', interval: 1, byWeekday: ['TU', 'TH'], end: { type: 'count', count: 6 } };
    // Tuesday 27 Oct 2026, 18:00 in New York (DST ends 1 Nov).
    const occ = seriesOccurrences('2026-10-27T18:00', 60, 'America/New_York', rule);
    expect(occ.map((o) => isoWithOffset(o.startUtc, 'America/New_York'))).toEqual([
      '2026-10-27T18:00:00-04:00',
      '2026-10-29T18:00:00-04:00',
      '2026-11-03T18:00:00-05:00',
      '2026-11-05T18:00:00-05:00',
      '2026-11-10T18:00:00-05:00',
      '2026-11-12T18:00:00-05:00',
    ]);
    expect(occ.every((o) => o.endUtc - o.startUtc === 3_600_000)).toBe(true);
  });

  test('every second week until a date (inclusive)', () => {
    const rule: RecurrenceRule = { freq: 'weekly', interval: 2, end: { type: 'until', until: '2026-12-01' } };
    expect(starts('2026-10-20T10:00', rule)).toEqual([
      '2026-10-20',
      '2026-11-03',
      '2026-11-17',
      '2026-12-01',
    ]);
  });

  test('daily with an interval', () => {
    expect(
      starts('2026-10-30T09:00', { freq: 'daily', interval: 3, end: { type: 'count', count: 4 } }),
    ).toEqual(['2026-10-30', '2026-11-02', '2026-11-05', '2026-11-08']);
  });

  test('monthly on the 31st skips shorter months (RFC 5545)', () => {
    expect(
      starts('2026-01-31T12:00', { freq: 'monthly', interval: 1, end: { type: 'count', count: 4 } }),
    ).toEqual(['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31']);
  });

  test('rule problems are reported, not guessed around', () => {
    // 20 Oct 2026 is a Tuesday.
    expect(
      ruleProblem({ freq: 'weekly', interval: 1, byWeekday: ['MO'], end: { type: 'count', count: 3 } }, '2026-10-20T10:00'),
    ).toBe('start_not_on_weekday');
    expect(
      ruleProblem({ freq: 'daily', interval: 1, end: { type: 'until', until: '2026-10-19' } }, '2026-10-20T10:00'),
    ).toBe('until_before_start');
    expect(
      ruleProblem({ freq: 'daily', interval: 1, end: { type: 'until', until: '2030-01-01' } }, '2026-10-20T10:00'),
    ).toBe('until_too_far');
    expect(
      ruleProblem({ freq: 'monthly', interval: 6, end: { type: 'count', count: 12 } }, '2026-10-20T10:00'),
    ).toBe('series_too_long');
    expect(
      ruleProblem({ freq: 'weekly', interval: 1, end: { type: 'count', count: 10 } }, '2026-10-20T10:00'),
    ).toBeNull();
  });

  test('occurrences in a window, with a cancelled and a moved occurrence', () => {
    const series = {
      startLocal: '2026-10-20T18:00',
      durationMinutes: 90,
      timeZone: 'Asia/Riyadh',
      recurrence: { freq: 'weekly', interval: 1, end: { type: 'count', count: 5 } } as RecurrenceRule,
    };
    const all = seriesOccurrences(series.startLocal, 90, series.timeZone, series.recurrence);
    const out = occurrencesBetween(
      series,
      [
        { originalStart: all[1]!.key, status: 'cancelled', start: null, end: null },
        {
          originalStart: all[2]!.key,
          status: 'moved',
          start: '2026-11-04T16:00:00.000Z',
          end: '2026-11-04T17:00:00.000Z',
        },
      ],
      Date.parse('2026-10-25T00:00:00Z'),
      Date.parse('2026-11-10T00:00:00Z'),
    );
    // 27 Oct is cancelled (still listed, flagged); 3 Nov moved to 4 Nov (no longer at 3 Nov).
    expect(out.map((o) => [iso(o.startUtc), o.cancelled, o.moved])).toEqual([
      ['2026-10-27T15:00:00.000Z', true, false],
      ['2026-11-04T16:00:00.000Z', false, true],
    ]);
    // The moved occurrence keeps its original identity.
    expect(out[1]!.key).toBe(all[2]!.key);
  });
});

describe('RRULE round trip (Google Calendar format)', () => {
  test('count and until rules', () => {
    const weekly: RecurrenceRule = { freq: 'weekly', interval: 2, byWeekday: ['TU', 'TH'], end: { type: 'count', count: 10 } };
    expect(toRRule(weekly, '2026-10-20T18:00', 'Asia/Riyadh')).toBe(
      'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;COUNT=10',
    );
    const until: RecurrenceRule = { freq: 'daily', interval: 1, end: { type: 'until', until: '2026-12-31' } };
    const line = toRRule(until, '2026-10-20T18:00', 'Asia/Riyadh');
    expect(line).toBe('RRULE:FREQ=DAILY;UNTIL=20261231T205959Z');
    expect(fromRRule([line], '2026-10-20T18:00', 'Asia/Riyadh')).toEqual({ ok: true, rule: until, exdates: [] });
    expect(fromRRule([toRRule(weekly, '2026-10-20T18:00', 'Asia/Riyadh')], '2026-10-20T18:00', 'Asia/Riyadh')).toEqual({
      ok: true,
      rule: weekly,
      exdates: [],
    });
  });

  test('EXDATE lines become cancelled occurrences', () => {
    const r = fromRRule(
      ['RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=4', 'EXDATE;TZID=Asia/Riyadh:20261027T180000'],
      '2026-10-20T18:00',
      'Asia/Riyadh',
    );
    expect(r).toEqual({
      ok: true,
      rule: { freq: 'weekly', interval: 1, byWeekday: ['TU'], end: { type: 'count', count: 4 } },
      exdates: ['2026-10-27T15:00:00.000Z'],
    });
  });

  test('rules the platform cannot represent are refused with a reason', () => {
    const at = (lines: string[]) => fromRRule(lines, '2026-10-20T18:00', 'Asia/Riyadh');
    expect(at(['RRULE:FREQ=YEARLY;COUNT=3'])).toEqual({ ok: false, reason: 'unsupported_frequency' });
    expect(at(['RRULE:FREQ=MONTHLY;BYDAY=3TU;COUNT=3'])).toEqual({ ok: false, reason: 'unsupported_byday' });
    expect(at(['RRULE:FREQ=WEEKLY;BYSETPOS=1;COUNT=3'])).toEqual({ ok: false, reason: 'unsupported_bysetpos' });
    expect(at(['RRULE:FREQ=WEEKLY'])).toEqual({ ok: false, reason: 'no_end' });
    expect(at(['RDATE:20261101T100000Z'])).toEqual({ ok: false, reason: 'unsupported_line' });
  });
});

describe('meeting request schemas', () => {
  const base = {
    title: 'Scrim review',
    start: '2026-10-20T18:00',
    end: '2026-10-20T19:00',
    timeZone: 'Asia/Riyadh',
  };
  test('a valid recurring meeting', () => {
    const r = meetingCreateSchema.safeParse({
      ...base,
      recurrence: { freq: 'weekly', byWeekday: ['TU'], end: { type: 'count', count: 8 } },
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.reminderMinutes).toEqual([15]);
  });
  test('end before start, both team and department, and administrative with a team fail', () => {
    const fail = (v: Record<string, unknown>) =>
      meetingCreateSchema.safeParse({ ...base, ...v }).error?.issues.map((i) => i.message);
    expect(fail({ end: '2026-10-20T17:00' })).toContain('duration_range');
    expect(
      fail({ teamId: crypto.randomUUID(), departmentId: crypto.randomUUID() }),
    ).toContain('team_or_department');
    expect(fail({ kind: 'administrative', teamId: crypto.randomUUID() })).toContain(
      'administrative_is_org_wide',
    );
    expect(fail({ timeZone: 'Nowhere/City' })).toContain('time_zone_invalid');
    expect(fail({ reminderMinutes: [7] })).toContain('reminder_option');
  });
  test('the list window is bounded', () => {
    expect(meetingListQuerySchema.safeParse({ from: '2026-01-01', to: '2026-12-31' }).success).toBe(false);
    expect(meetingListQuerySchema.safeParse({ from: '2026-10-01', to: '2026-11-30' }).success).toBe(true);
  });
  test('incoming webhook payloads need an external id to create', () => {
    expect(
      incomingWebhookPayloadSchema.safeParse({ type: 'meeting.create', data: base }).success,
    ).toBe(false);
    expect(
      incomingWebhookPayloadSchema.safeParse({ type: 'meeting.create', data: { ...base, externalId: 'ext-1' } })
        .success,
    ).toBe(true);
    expect(incomingWebhookPayloadSchema.safeParse({ type: 'meeting.delete', data: {} }).success).toBe(false);
  });
});

describe('Phase 6 permissions', () => {
  test('administrative meetings are owner-only; managers get meetings in their templates', () => {
    expect(GRANTABLE_PERMISSION_KEYS).not.toContain('meetings.administrative');
    expect(GRANTABLE_PERMISSION_KEYS).toContain('integrations.manage');
    const manager = DEFAULT_ROLE_TEMPLATES.find((t) => t.templateKey === 'esports_manager')!;
    expect(manager.permissions).toEqual(expect.arrayContaining(['meetings.view', 'meetings.create', 'meetings.manage']));
    for (const t of DEFAULT_ROLE_TEMPLATES) expect(t.permissions).not.toContain('integrations.manage');
  });
});
