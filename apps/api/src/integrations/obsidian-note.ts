/**
 * Obsidian has no server API: a vault is a folder of Markdown files on the member's computer,
 * synced (if at all) by Obsidian Sync, iCloud, git… (see DECISIONS.md, "Obsidian"). So the
 * integration works with files: the platform renders each meeting as a note — YAML front
 * matter as Obsidian "Properties" (queryable with Bases), then the text — and a small companion
 * script on the member's computer writes the notes into the vault and sends edited notes back.
 *
 * Two-way fields: the `title` property, and the Purpose and Notes sections (between marker
 * comments, which Obsidian hides in reading view). Everything else is written by the platform.
 */
import { isoWithOffset, toRRule } from '@esports/shared';
import type { LoadedMeeting } from '../meetings/meetings.service';

const MARK = (name: string, edge: 'start' | 'end') => `<!-- platform:${name}:${edge} -->`;

const L = {
  en: {
    banner:
      'Synced with the club platform. Edit the title property and the Purpose and Notes sections; other changes are replaced on the next sync.',
    purpose: 'Purpose',
    notes: 'Notes',
    upcoming: 'Upcoming',
    cancelled: 'cancelled',
    responses: { pending: 'not answered', accepted: 'accepted', declined: 'declined' } as Record<
      string,
      string
    >,
  },
  ar: {
    banner:
      'متزامن مع منصة النادي. عدّل خاصية العنوان وقسمي الغرض والملاحظات؛ أي تغيير آخر يُستبدل في المزامنة التالية.',
    purpose: 'الغرض',
    notes: 'الملاحظات',
    upcoming: 'المواعيد القادمة',
    cancelled: 'ملغى',
    responses: { pending: 'لم يرد', accepted: 'قبل', declined: 'اعتذر' } as Record<string, string>,
  },
};

/** A file name Obsidian and every OS accept. */
export function safeFileName(s: string): string {
  const cleaned = s
    .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .trim();
  return cleaned || 'Meeting';
}

export function notePath(l: LoadedMeeting): string {
  return `Meetings/${l.row.startLocal.slice(0, 10)} ${safeFileName(l.row.title)} (${l.row.id.slice(0, 6)}).md`;
}

const q = (s: string) => JSON.stringify(s);

export function renderNote(
  l: LoadedMeeting,
  opts: { locale: 'ar' | 'en'; upcoming: { start: number; cancelled: boolean }[] },
): string {
  const m = l.row;
  const t = L[opts.locale];
  const tz = m.timeZone;
  const startUtc = m.startsAt.getTime();
  const fm = [
    '---',
    `platform_meeting_id: ${q(m.id)}`,
    `platform_version: ${m.version}`,
    `title: ${q(m.title)}`,
    `start: ${q(isoWithOffset(startUtc, tz))}`,
    `end: ${q(isoWithOffset(startUtc + m.durationMinutes * 60000, tz))}`,
    `time_zone: ${q(tz)}`,
    ...(m.recurrence ? [`repeats: ${q(toRRule(m.recurrence, m.startLocal, tz).slice(6))}`] : []),
    `status: ${q(m.status)}`,
    ...(l.team
      ? [`team: ${q(l.team.name)}`]
      : l.departmentName
        ? [`department: ${q(l.departmentName)}`]
        : []),
    ...(l.participants.length
      ? [
          'participants:',
          ...l.participants.map(
            (p) => `  - ${q(`${p.displayName} (${t.responses[p.response] ?? p.response})`)}`,
          ),
        ]
      : []),
    'tags:',
    '  - meeting',
    '---',
  ];
  const fmt = new Intl.DateTimeFormat(opts.locale === 'ar' ? 'ar-u-ca-gregory-nu-latn' : 'en-GB', {
    timeZone: tz,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const body = [
    '',
    `# ${m.title}`,
    '',
    `> [!info] ${t.banner}`,
    '',
    `## ${t.purpose}`,
    MARK('purpose', 'start'),
    m.description ?? '',
    MARK('purpose', 'end'),
    '',
    `## ${t.notes}`,
    MARK('notes', 'start'),
    m.notes ?? '',
    MARK('notes', 'end'),
    '',
    `## ${t.upcoming}`,
    ...opts.upcoming.map(
      (o) => `- ${fmt.format(new Date(o.start))}${o.cancelled ? ` (${t.cancelled})` : ''}`,
    ),
    '',
  ];
  return [...fm, ...body].join('\n');
}

/** Minimal YAML scalar reading (what Obsidian's Properties editor writes for text). */
function scalar(raw: string): string {
  const v = raw.trim();
  if (v.startsWith('"')) {
    try {
      return JSON.parse(v) as string;
    } catch {
      return v.slice(1, v.endsWith('"') ? -1 : undefined);
    }
  }
  if (v.startsWith("'")) return v.slice(1, v.endsWith("'") ? -1 : undefined).replace(/''/g, "'");
  return v;
}

export interface ParsedNote {
  meetingId: string | null;
  version: number | null;
  title: string | null;
  description: string | null | undefined;
  notes: string | null | undefined;
}

/** Reads the editable parts of a note. A missing section means "unchanged" (undefined). */
export function parseNote(content: string): ParsedNote {
  const text = content.replace(/\r\n/g, '\n');
  const out: ParsedNote = {
    meetingId: null,
    version: null,
    title: null,
    description: undefined,
    notes: undefined,
  };
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (fm) {
    for (const line of fm[1]!.split('\n')) {
      const m = /^([A-Za-z_][\w-]*):(.*)$/.exec(line);
      if (!m) continue;
      const [, key, value] = m;
      if (key === 'platform_meeting_id') out.meetingId = scalar(value!) || null;
      if (key === 'platform_version') out.version = Number.parseInt(scalar(value!), 10) || null;
      if (key === 'title') out.title = scalar(value!) || null;
    }
  }
  const section = (name: string) => {
    const a = text.indexOf(MARK(name, 'start'));
    const b = text.indexOf(MARK(name, 'end'));
    if (a < 0 || b < 0 || b < a) return undefined;
    const inner = text
      .slice(a + MARK(name, 'start').length, b)
      .replace(/^\n/, '')
      .replace(/\n$/, '')
      .trim();
    return inner === '' ? null : inner;
  };
  out.description = section('purpose');
  out.notes = section('notes');
  return out;
}
