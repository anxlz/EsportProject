/** Unit tests for Phase 6 building blocks that don't need the app running. */
import { describe, expect, test } from 'bun:test';
import { backoffFor, maxAttempts } from '../src/integrations/jobs.service';
import { parseNote, renderNote, safeFileName } from '../src/integrations/obsidian-note';
import { eventToRecord, googleEventId } from '../src/integrations/providers/google-calendar';
import { pageToRecord, parseNotionId, richText } from '../src/integrations/providers/notion';
import { SecretBox } from '../src/integrations/secret-box';
import { type Snapshot, stable, threeWayMerge } from '../src/integrations/sync-engine';
import {
  assertPublicUrl,
  signWebhook,
  verifyWebhookSignature,
} from '../src/integrations/webhooks.service';
import { IntegrationError, parseRetryAfter } from '../src/integrations/errors';

const base: Snapshot = {
  title: 'Scrim review',
  description: 'Purpose',
  notes: null,
  time: { startLocal: '2026-10-21T18:00', endLocal: '2026-10-21T19:00', timeZone: 'Asia/Riyadh' },
  recurrence: null,
  exdates: [],
  status: 'scheduled',
};
const withT = (s: Partial<Snapshot>): Snapshot => ({ ...structuredClone(base), ...s });

describe('three-way merge (the documented conflict rules)', () => {
  test('provider-only change is applied locally; platform-only change is pushed', () => {
    const r = threeWayMerge(base, base, withT({ title: 'Renamed in Google' }));
    expect(r).toMatchObject({
      applyLocally: { title: 'Renamed in Google' },
      pushRemote: false,
      conflicts: [],
    });
    expect(r.merged.title).toBe('Renamed in Google');
    const p = threeWayMerge(base, withT({ notes: 'Platform' }), base);
    expect(p).toMatchObject({ applyLocally: {}, pushRemote: true, conflicts: [] });
  });

  test('the same field changed on both sides: the platform wins and it is reported', () => {
    const r = threeWayMerge(base, withT({ title: 'Platform' }), withT({ title: 'Provider' }));
    expect(r.merged.title).toBe('Platform');
    expect(r.pushRemote).toBe(true);
    expect(r.conflicts).toEqual([{ field: 'title', platform: 'Platform', provider: 'Provider' }]);
  });

  test('both changed to the same value is not a conflict; different fields merge', () => {
    expect(threeWayMerge(base, withT({ title: 'Same' }), withT({ title: 'Same' }))).toMatchObject({
      conflicts: [],
      pushRemote: false,
      applyLocally: {},
    });
    const time = {
      startLocal: '2026-10-21T20:00',
      endLocal: '2026-10-21T21:00',
      timeZone: 'Asia/Riyadh',
    };
    const r = threeWayMerge(base, withT({ time }), withT({ notes: 'From Notion' }));
    expect(r.merged).toMatchObject({ time, notes: 'From Notion' });
    expect(r).toMatchObject({
      applyLocally: { notes: 'From Notion' },
      pushRemote: true,
      conflicts: [],
    });
  });

  test('start, end and zone merge as one field (never one side’s start with the other’s end)', () => {
    const p = withT({ time: { ...base.time, startLocal: '2026-10-21T17:00' } });
    const q = withT({ time: { ...base.time, endLocal: '2026-10-21T20:00' } });
    const r = threeWayMerge(base, p, q);
    expect(r.merged.time).toEqual(p.time);
    expect(r.conflicts.map((c) => c.field)).toEqual(['time']);
  });

  test('without a common base every difference is a conflict, resolved for the platform', () => {
    const r = threeWayMerge(null, withT({ notes: 'P' }), withT({ notes: 'R', title: 'X' }));
    expect(r.merged).toMatchObject({ notes: 'P', title: 'Scrim review' });
    expect(r.conflicts.map((c) => c.field).sort()).toEqual(['notes', 'title']);
    expect(r.applyLocally).toEqual({});
  });

  test('fields outside the provider’s keys are ignored', () => {
    const r = threeWayMerge(base, base, withT({ notes: 'ignored' }), ['title', 'time']);
    expect(r).toMatchObject({ applyLocally: {}, pushRemote: false, conflicts: [] });
  });

  test('stable JSON ignores key order', () => {
    expect(stable({ b: 1, a: { d: 2, c: [1, { y: 1, x: 2 }] } })).toBe(
      stable({ a: { c: [1, { x: 2, y: 1 }], d: 2 }, b: 1 }),
    );
  });
});

describe('secret box (AES-256-GCM, bound to the connection)', () => {
  const box = new SecretBox({ sessionSecret: 'x'.repeat(40) });
  test('round trip; another connection’s AAD, a different key or a flipped bit fail', () => {
    const sealed = box.seal({ refreshToken: 'rt-123' }, 'org:conn-1');
    expect(sealed).toStartWith('v1.');
    expect(sealed).not.toContain('rt-123');
    expect(box.open(sealed, 'org:conn-1')).toEqual({ refreshToken: 'rt-123' });
    expect(() => box.open(sealed, 'org:conn-2')).toThrow();
    expect(() =>
      new SecretBox({ sessionSecret: 'y'.repeat(40) }).open(sealed, 'org:conn-1'),
    ).toThrow();
    expect(() =>
      new SecretBox({ encryptionKey: 'k'.repeat(40), sessionSecret: 'x'.repeat(40) }).open(
        sealed,
        'org:conn-1',
      ),
    ).toThrow();
    const parts = sealed.split('.');
    const data = Buffer.from(parts[2]!, 'base64url');
    data[0]! ^= 1;
    expect(() =>
      box.open(`${parts[0]}.${parts[1]}.${data.toString('base64url')}`, 'org:conn-1'),
    ).toThrow();
    expect(box.seal({ a: 1 }, 'x')).not.toBe(box.seal({ a: 1 }, 'x')); // random IV
  });
});

describe('Standard Webhooks signatures', () => {
  // The example from the specification's reference implementation.
  const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
  const id = 'msg_p5jXN8AQM9LWM0D4loKWxJek';
  const ts = 1614265330;
  const body = '{"test": 2432232314}';
  test('matches the specification’s example signature', () => {
    expect(signWebhook(secret, id, ts, body)).toBe(
      'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
    );
  });
  test('accepts any matching signature in the header (rotation), refuses others', () => {
    const good = signWebhook(secret, id, ts, body);
    expect(verifyWebhookSignature(secret, id, ts, body, `v1,AAAA ${good}`)).toBe(true);
    expect(verifyWebhookSignature(secret, id, ts, `${body} `, good)).toBe(false);
    expect(verifyWebhookSignature(secret, id, ts + 1, body, good)).toBe(false);
    expect(verifyWebhookSignature(secret, id, ts, body, good.replace('v1,', 'v2,'))).toBe(false);
    expect(verifyWebhookSignature(secret, id, ts, body, '')).toBe(false);
  });
});

describe('outgoing webhook URLs (SSRF protection)', () => {
  test('https to public addresses only, unless explicitly allowed for development', async () => {
    const refused = async (u: string) =>
      (await assertPublicUrl(u, false).then(
        () => null,
        (e: { code: string }) => e.code,
      )) === 'url_not_allowed';
    for (const u of [
      'http://hooks.example.com/x',
      'https://localhost/x',
      'https://127.0.0.1/x',
      'https://10.1.2.3/x',
      'https://172.20.0.5/x',
      'https://192.168.1.10/x',
      'https://169.254.169.254/latest/meta-data',
      'https://100.64.0.1/x',
      'https://[::1]/x',
      'https://[fd00::1]/x',
      'https://[::ffff:10.0.0.1]/x', // normalized by URL to ::ffff:a00:1
      'https://[::ffff:7f00:1]/x',
      'https://[64:ff9b::a9fe:a9fe]/x', // NAT64 of 169.254.169.254
      'https://[2002:c0a8:101::1]/x', // 6to4 of 192.168.1.1
      'https://[fe80::1]/x',
      'https://0.0.0.0/x',
      'https://user:pass@93.184.216.34/x',
      'https://printer.local/x',
      'ftp://93.184.216.34/x',
      'not a url',
    ])
      expect({ u, refused: await refused(u) }).toEqual({ u, refused: true });
    expect((await assertPublicUrl('https://93.184.216.34/hooks', false)).host).toBe(
      '93.184.216.34',
    );
    expect((await assertPublicUrl('https://[2606:4700::6810:84e5]/hooks', false)).hostname).toBe(
      '[2606:4700::6810:84e5]',
    );
    expect((await assertPublicUrl('http://127.0.0.1:9999/hooks', true)).port).toBe('9999');
  });
});

describe('provider mapping', () => {
  test('Google: event ids are deterministic and use the allowed alphabet', () => {
    const a = googleEventId('conn', 'meeting');
    expect(a).toMatch(/^[0-9a-v]{32}$/);
    expect(googleEventId('conn', 'meeting')).toBe(a);
    expect(googleEventId('conn2', 'meeting')).not.toBe(a);
  });

  test('Google: events read as meetings; what can’t be represented is reported', () => {
    const r = eventToRecord(
      {
        id: 'e1',
        etag: '"1"',
        summary: 'Scrim',
        start: { dateTime: '2026-10-21T18:00:00+03:00', timeZone: 'Asia/Riyadh' },
        end: { dateTime: '2026-10-21T19:30:00+03:00', timeZone: 'Asia/Riyadh' },
        recurrence: [
          'RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=3',
          'EXDATE;TZID=Asia/Riyadh:20261028T180000',
        ],
        extendedProperties: { private: { platformMeetingId: 'm1' } },
      },
      'UTC',
    );
    expect(r).toMatchObject({
      platformMeetingId: 'm1',
      deleted: false,
      snapshot: {
        title: 'Scrim',
        time: {
          startLocal: '2026-10-21T18:00',
          endLocal: '2026-10-21T19:30',
          timeZone: 'Asia/Riyadh',
        },
        recurrence: {
          freq: 'weekly',
          interval: 1,
          byWeekday: ['WE'],
          end: { type: 'count', count: 3 },
        },
        exdates: ['2026-10-28T15:00:00.000Z'],
      },
    });
    expect(
      eventToRecord(
        { id: 'e2', start: { date: '2026-10-21' }, end: { date: '2026-10-22' } },
        'UTC',
      ),
    ).toMatchObject({ snapshot: null, unsupported: 'all_day' });
    expect(
      eventToRecord(
        {
          id: 'e3',
          start: { dateTime: '2026-10-21T18:00:00Z' },
          end: { dateTime: '2026-10-21T19:00:00Z' },
          recurrence: ['RRULE:FREQ=YEARLY;COUNT=2'],
        },
        'UTC',
      ),
    ).toMatchObject({
      snapshot: null,
      unsupported: 'recurrence:unsupported_frequency',
    });
    expect(eventToRecord({ id: 'e4', status: 'cancelled' }, 'UTC')).toMatchObject({
      deleted: true,
    });
    expect(
      eventToRecord(
        {
          id: 'e1_20261028T150000Z',
          status: 'cancelled',
          recurringEventId: 'e1',
          originalStartTime: { dateTime: '2026-10-28T18:00:00+03:00', timeZone: 'Asia/Riyadh' },
        },
        'UTC',
      ),
    ).toMatchObject({
      deleted: false,
      instanceOf: { remoteId: 'e1', originalStart: '2026-10-28T15:00:00.000Z', cancelled: true },
    });
  });

  test('Notion: ids from links, rich text chunks of 2,000, dates with or without a time zone', () => {
    expect(
      parseNotionId(
        'https://www.notion.so/acme/Team-meetings-1a2b3c4d5e6f47a8b9c0d1e2f3a4b5c6?v=0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f',
      ),
    ).toBe('1a2b3c4d-5e6f-47a8-b9c0-d1e2f3a4b5c6');
    expect(parseNotionId('1a2b3c4d-5e6f-47a8-b9c0-d1e2f3a4b5c6')).toBe(
      '1a2b3c4d-5e6f-47a8-b9c0-d1e2f3a4b5c6',
    );
    expect(parseNotionId('nope')).toBeNull();
    const chunks = richText('a'.repeat(4500));
    expect(chunks.map((c) => c.text.content.length)).toEqual([2000, 2000, 500]);
    expect(richText(null)).toEqual([]);
    const cfg = { titleProperty: 'Name', timeZone: 'Asia/Riyadh' };
    const page = (date: unknown) => ({
      id: 'p',
      properties: { Name: { title: [{ plain_text: 'X' }] }, When: { date } },
    });
    expect(
      pageToRecord(
        page({
          start: '2026-10-21T18:00:00.000',
          end: '2026-10-21T19:00:00.000',
          time_zone: 'Europe/Berlin',
        }) as never,
        cfg,
      ).snapshot!.time,
    ).toEqual({
      startLocal: '2026-10-21T18:00',
      endLocal: '2026-10-21T19:00',
      timeZone: 'Europe/Berlin',
    });
    expect(
      pageToRecord(
        page({
          start: '2026-10-21T15:00:00.000+00:00',
          end: '2026-10-21T16:00:00.000+00:00',
          time_zone: null,
        }) as never,
        cfg,
      ).snapshot!.time,
    ).toEqual({
      startLocal: '2026-10-21T18:00',
      endLocal: '2026-10-21T19:00',
      timeZone: 'Asia/Riyadh',
    });
    expect(pageToRecord(page({ start: '2026-10-21' }) as never, cfg)).toMatchObject({
      snapshot: null,
      unsupported: 'all_day',
    });
    // A trashed page never looks unchanged.
    const live = pageToRecord(
      page({
        start: '2026-10-21T18:00:00.000',
        end: '2026-10-21T19:00:00.000',
        time_zone: 'Asia/Riyadh',
      }) as never,
      cfg,
    );
    const trashed = pageToRecord(
      {
        ...page({
          start: '2026-10-21T18:00:00.000',
          end: '2026-10-21T19:00:00.000',
          time_zone: 'Asia/Riyadh',
        }),
        in_trash: true,
      } as never,
      cfg,
    );
    expect(trashed.version).not.toBe(live.version);
  });

  test('Obsidian: notes round-trip; edits from the Properties editor and missing sections are handled', () => {
    const l = {
      row: {
        id: '5e0aee61-418c-474a-9070-05207cfffb48',
        version: 3,
        title: 'Scrim "review"',
        description: 'Purpose text',
        notes: null,
        startLocal: '2026-10-21T18:00',
        startsAt: new Date('2026-10-21T15:00:00Z'),
        durationMinutes: 60,
        timeZone: 'Asia/Riyadh',
        recurrence: null,
        status: 'scheduled',
        organizerUserId: 'u1',
      },
      team: { id: 't', departmentId: null, name: 'Team A' },
      departmentName: null,
      participants: [{ userId: 'u1', displayName: 'Sara', response: 'accepted' }],
      overrides: [],
    } as never;
    const note = renderNote(l, {
      locale: 'en',
      upcoming: [{ start: Date.parse('2026-10-21T15:00:00Z'), cancelled: false }],
    });
    expect(parseNote(note)).toEqual({
      meetingId: '5e0aee61-418c-474a-9070-05207cfffb48',
      version: 3,
      title: 'Scrim "review"',
      description: 'Purpose text',
      notes: null,
    });
    // Obsidian's Properties editor may rewrite the title without quotes.
    const edited = note
      .replace('title: "Scrim \\"review\\""', 'title: Scrim review v2')
      .replace('<!-- platform:notes:start -->\n', '<!-- platform:notes:start -->\nNew notes');
    expect(parseNote(edited)).toMatchObject({ title: 'Scrim review v2', notes: 'New notes' });
    // A deleted section means "unchanged", never "empty".
    expect(
      parseNote(
        note.replace(/<!-- platform:purpose:start -->[\s\S]*<!-- platform:purpose:end -->/, ''),
      ).description,
    ).toBeUndefined();
    expect(renderNote(l, { locale: 'ar', upcoming: [] })).toContain('## الملاحظات');
    expect(safeFileName('a/b:c*?"<>|#^[]  d')).toBe('a b c d');
    expect(safeFileName('   ')).toBe('Meeting');
  });
});

describe('retries and provider errors', () => {
  test('backoff schedules (sync and Standard Webhooks), with jitter within ±10%', () => {
    const near = (kind: string, n: number, want: number) => {
      const v = backoffFor(kind, n)!;
      expect(Math.abs(v - want) <= want * 0.1).toBe(true);
    };
    [30_000, 120_000, 600_000, 1_800_000, 7_200_000, 21_600_000].forEach((w, i) =>
      near('push_meeting', i + 1, w),
    );
    expect(backoffFor('push_meeting', 7)).toBeNull();
    expect(maxAttempts('push_meeting')).toBe(7);
    [
      5_000, 300_000, 1_800_000, 7_200_000, 18_000_000, 36_000_000, 50_400_000, 72_000_000,
      86_400_000,
    ].forEach((w, i) => near('deliver_webhook', i + 1, w));
    expect(backoffFor('deliver_webhook', 10)).toBeNull();
  });

  test('HTTP statuses map to how a job is handled; Retry-After is honoured', () => {
    expect(IntegrationError.fromStatus('X', 401, null).kind).toBe('auth');
    expect(IntegrationError.fromStatus('X', 429, '12')).toMatchObject({
      kind: 'rate_limited',
      retryAfterMs: 12_000,
    });
    expect(IntegrationError.fromStatus('X', 503, null).kind).toBe('retryable');
    expect(IntegrationError.fromStatus('X', 400, null).kind).toBe('permanent');
    expect(parseRetryAfter('99999')).toBe(3_600_000);
    expect(parseRetryAfter(null)).toBeNull();
  });
});
