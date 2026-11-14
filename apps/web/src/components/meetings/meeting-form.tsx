'use client';

import {
  type DepartmentDto,
  type MeetingDto,
  MEETING_LIMITS,
  REMINDER_OPTIONS,
  type RecurrenceRule,
  type TeamDto,
  WEEKDAYS,
  type Weekday,
} from '@esports/shared';
import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import {
  Button,
  Checkbox,
  cx,
  Dialog,
  ErrorBanner,
  SelectField,
  TextArea,
  TextField,
} from '@/components/ui';
import { api, ApiError, apiPatch, apiPost } from '@/lib/api';
import {
  browserTimeZone,
  COMMON_TIME_ZONES,
  useRecurrenceText,
  useReminderLabel,
  weekdayNames,
} from '@/lib/meetings';
import { useAction } from '@/lib/mutation';
import { useCan } from '@/lib/session';

type Repeat = 'none' | 'daily' | 'weekly' | 'monthly';

interface Form {
  kind: 'standard' | 'administrative';
  title: string;
  description: string;
  notes: string;
  scope: string; // '' (organization) | 'team:<id>' | 'dept:<id>'
  date: string;
  startTime: string;
  endTime: string;
  timeZone: string;
  repeat: Repeat;
  interval: string;
  weekdays: Weekday[];
  endType: 'count' | 'until';
  count: string;
  until: string;
  participants: string[];
  reminders: number[];
}

/** Weekday code of a "YYYY-MM-DD" date. */
const weekdayOf = (date: string) => WEEKDAYS[(new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7]!;

function addMinutes(date: string, time: string, minutes: number) {
  const d = new Date(`${date}T${time}:00Z`);
  const e = new Date(d.getTime() + minutes * 60000);
  return e.toISOString().slice(0, 16);
}

function initial(m: MeetingDto | null): Form {
  const today = new Date();
  const date = m
    ? m.startLocal.slice(0, 10)
    : new Date(today.getTime() + 86_400_000).toISOString().slice(0, 10);
  const tz = browserTimeZone();
  return {
    kind: m?.kind ?? 'standard',
    title: m?.title ?? '',
    description: m?.description ?? '',
    notes: m?.notes ?? '',
    scope: m?.teamId ? `team:${m.teamId}` : m?.departmentId ? `dept:${m.departmentId}` : '',
    date,
    startTime: m ? m.startLocal.slice(11, 16) : '18:00',
    endTime: m ? m.endLocal.slice(11, 16) : '19:00',
    timeZone: m?.timeZone ?? (COMMON_TIME_ZONES.includes(tz) ? tz : tz || 'Asia/Riyadh'),
    repeat: (m?.recurrence?.freq as Repeat) ?? 'none',
    interval: String(m?.recurrence?.interval ?? 1),
    weekdays: m?.recurrence?.byWeekday ?? [weekdayOf(date)],
    endType: m?.recurrence?.end.type ?? 'count',
    count: String(m?.recurrence?.end.type === 'count' ? m.recurrence.end.count : 8),
    until: m?.recurrence?.end.type === 'until' ? m.recurrence.end.until : '',
    participants: m?.participants.filter((p) => !p.isOrganizer).map((p) => p.userId) ?? [],
    reminders: m?.reminderMinutes ?? [15],
  };
}

export function MeetingFormDialog({
  meeting,
  onClose,
  onSaved,
}: {
  meeting: MeetingDto | null;
  onClose: () => void;
  onSaved?: (m: MeetingDto) => void;
}) {
  const t = useTranslations('meetings');
  const tc = useTranslations('common');
  const locale = useLocale();
  const can = useCan();
  const recurrenceText = useRecurrenceText();
  const reminderLabel = useReminderLabel();
  const [form, setForm] = useState<Form>(() => initial(meeting));
  const [search, setSearch] = useState('');
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const teams = useQuery({
    queryKey: ['teams'],
    queryFn: () => api<TeamDto[]>('/teams'),
    enabled: can('teams.view'),
  });
  const departments = useQuery({
    queryKey: ['departments'],
    queryFn: () => api<DepartmentDto[]>('/departments'),
    enabled: can('departments.view'),
  });
  const invitees = useQuery({
    queryKey: ['meetings', 'invitees'],
    queryFn: () => api<{ userId: string; displayName: string }[]>('/meetings/invitees'),
  });
  const zones = useMemo(() => {
    const own = browserTimeZone();
    return [...new Set([form.timeZone, own, ...COMMON_TIME_ZONES])];
  }, [form.timeZone]);
  const names = weekdayNames(locale);

  const end = useMemo(() => {
    // An end time before the start time means the next day (e.g. 23:00–01:00).
    const sameDay = form.endTime > form.startTime;
    return sameDay ? `${form.date}T${form.endTime}` : addMinutes(form.date, form.endTime, 24 * 60);
  }, [form.date, form.startTime, form.endTime]);

  const recurrence = (): RecurrenceRule | null =>
    form.repeat === 'none'
      ? null
      : {
          freq: form.repeat,
          interval: Math.max(1, Number.parseInt(form.interval, 10) || 1),
          ...(form.repeat === 'weekly' ? { byWeekday: form.weekdays } : {}),
          end:
            form.endType === 'count'
              ? { type: 'count', count: Math.max(1, Number.parseInt(form.count, 10) || 1) }
              : { type: 'until', until: form.until },
        };

  const body = () => {
    const [scopeType, scopeId] = form.scope.split(':');
    return {
      ...(meeting ? {} : { kind: form.kind }),
      title: form.title.trim(),
      description: form.description.trim() || null,
      notes: form.notes.trim() || null,
      teamId: form.kind === 'administrative' ? null : scopeType === 'team' ? scopeId : null,
      departmentId: form.kind === 'administrative' ? null : scopeType === 'dept' ? scopeId : null,
      start: `${form.date}T${form.startTime}`,
      end,
      timeZone: form.timeZone,
      recurrence: recurrence(),
      participantUserIds: form.participants,
      reminderMinutes: form.reminders,
      ...(meeting ? { expectedVersion: meeting.version } : {}),
    };
  };

  const save = useAction(
    () =>
      meeting
        ? apiPatch<MeetingDto>(`/meetings/${meeting.id}`, body())
        : apiPost<MeetingDto>('/meetings', body()),
    {
      invalidate: [['meetings']],
      success: meeting ? t('saved') : t('created'),
      onSuccess: (m) => {
        onSaved?.(m);
        onClose();
      },
    },
  );

  // Messages for the API's validation details (the same rules as the shared schema).
  const problems = useMemo(() => {
    const e = save.error;
    if (!(e instanceof ApiError) || e.code !== 'validation_failed' || !Array.isArray(e.details))
      return [];
    return (e.details as { message?: string }[])
      .map((d) => d.message ?? '')
      .map((m) => (t.has(`validation.${m}` as never) ? t(`validation.${m}` as never) : null))
      .filter((x): x is string => !!x);
  }, [save.error, t]);

  const filtered = (invitees.data ?? []).filter((u) =>
    u.displayName.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const canAdmin = can('meetings.administrative') && !meeting;
  const titleMissing = !form.title.trim();

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={meeting ? t('editTitle') : t('newTitle')}
      lead={t('formLead')}
      footer={
        <>
          <Button onClick={onClose}>{tc('cancel')}</Button>
          <Button
            variant="primary"
            disabled={save.isPending || titleMissing}
            onClick={() => save.mutate(undefined)}
          >
            {save.isPending ? tc('saving') : meeting ? tc('save') : t('create')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <TextField
          label={t('fields.title')}
          value={form.title}
          maxLength={MEETING_LIMITS.titleMax}
          onChange={(e) => set('title', e.target.value)}
          required
        />
        <TextArea
          label={t('fields.description')}
          optional
          value={form.description}
          maxLength={MEETING_LIMITS.descriptionMax}
          onChange={(e) => set('description', e.target.value)}
        />

        {canAdmin && (
          <Checkbox
            label={t('fields.administrative')}
            hint={t('fields.administrativeHint')}
            checked={form.kind === 'administrative'}
            onChange={(e) => set('kind', e.target.checked ? 'administrative' : 'standard')}
          />
        )}
        {form.kind === 'standard' && (
          <SelectField
            label={t('fields.scope')}
            value={form.scope}
            onChange={(e) => set('scope', e.target.value)}
          >
            <option value="">{t('fields.wholeOrganization')}</option>
            {(departments.data ?? []).length > 0 && (
              <optgroup label={t('fields.departments')}>
                {departments.data!.map((d) => (
                  <option key={d.id} value={`dept:${d.id}`}>
                    {d.name}
                  </option>
                ))}
              </optgroup>
            )}
            {(teams.data ?? []).length > 0 && (
              <optgroup label={t('fields.teams')}>
                {teams.data!.map((x) => (
                  <option key={x.id} value={`team:${x.id}`}>
                    {x.name}
                  </option>
                ))}
              </optgroup>
            )}
          </SelectField>
        )}

        <fieldset className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <legend className="sr-only">{t('fields.when')}</legend>
          <TextField
            label={t('fields.date')}
            type="date"
            value={form.date}
            onChange={(e) => {
              const date = e.target.value;
              setForm((f) => ({
                ...f,
                date,
                // Keep the first date one of the repeat days.
                weekdays:
                  f.repeat === 'weekly' && date && !f.weekdays.includes(weekdayOf(date))
                    ? [...f.weekdays, weekdayOf(date)]
                    : f.weekdays,
              }));
            }}
          />
          <TextField
            label={t('fields.startTime')}
            type="time"
            value={form.startTime}
            onChange={(e) => set('startTime', e.target.value)}
          />
          <TextField
            label={t('fields.endTime')}
            type="time"
            value={form.endTime}
            hint={form.endTime <= form.startTime ? t('fields.nextDay') : undefined}
            onChange={(e) => set('endTime', e.target.value)}
          />
          <SelectField
            label={t('fields.timeZone')}
            value={form.timeZone}
            onChange={(e) => set('timeZone', e.target.value)}
          >
            {zones.map((z) => (
              <option key={z} value={z} dir="ltr">
                {z}
              </option>
            ))}
          </SelectField>
        </fieldset>

        <fieldset className="flex flex-col gap-3 rounded-md border border-line p-4">
          <legend className="px-1 text-sm font-medium">{t('fields.repeat')}</legend>
          <div className="grid gap-4 sm:grid-cols-3">
            <SelectField
              label={t('fields.repeatLabel')}
              value={form.repeat}
              onChange={(e) => {
                const repeat = e.target.value as Repeat;
                setForm((f) => ({
                  ...f,
                  repeat,
                  weekdays:
                    repeat === 'weekly' && !f.weekdays.length ? [weekdayOf(f.date)] : f.weekdays,
                }));
              }}
            >
              {(['none', 'daily', 'weekly', 'monthly'] as const).map((r) => (
                <option key={r} value={r}>
                  {t(`repeat.${r}`)}
                </option>
              ))}
            </SelectField>
            {form.repeat !== 'none' && (
              <TextField
                label={t('fields.every')}
                type="number"
                min={1}
                max={MEETING_LIMITS.intervalMax}
                value={form.interval}
                hint={t(`repeat.unit.${form.repeat}`, { count: Number(form.interval) || 1 })}
                onChange={(e) => set('interval', e.target.value)}
              />
            )}
          </div>
          {form.repeat === 'weekly' && (
            <div role="group" aria-label={t('fields.onDays')} className="flex flex-wrap gap-2">
              {WEEKDAYS.map((d, i) => {
                const on = form.weekdays.includes(d);
                const locked = d === weekdayOf(form.date);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={on}
                    disabled={locked}
                    title={locked ? t('fields.firstDay') : undefined}
                    onClick={() =>
                      set(
                        'weekdays',
                        on ? form.weekdays.filter((x) => x !== d) : [...form.weekdays, d],
                      )
                    }
                    className={cx(
                      'h-9 min-w-12 rounded-md border px-2 text-sm',
                      on
                        ? 'border-turf bg-turf text-turf-ink'
                        : 'border-line-strong bg-panel text-ink hover:bg-panel-2',
                      locked && 'cursor-default',
                    )}
                  >
                    {names[i]}
                  </button>
                );
              })}
            </div>
          )}
          {form.repeat !== 'none' && (
            <div className="grid gap-4 sm:grid-cols-3">
              <SelectField
                label={t('fields.ends')}
                value={form.endType}
                onChange={(e) => set('endType', e.target.value as Form['endType'])}
              >
                <option value="count">{t('fields.endsAfter')}</option>
                <option value="until">{t('fields.endsOn')}</option>
              </SelectField>
              {form.endType === 'count' ? (
                <TextField
                  label={t('fields.occurrences')}
                  type="number"
                  min={1}
                  max={MEETING_LIMITS.countMax}
                  value={form.count}
                  onChange={(e) => set('count', e.target.value)}
                />
              ) : (
                <TextField
                  label={t('fields.lastDate')}
                  type="date"
                  min={form.date}
                  value={form.until}
                  onChange={(e) => set('until', e.target.value)}
                />
              )}
            </div>
          )}
          {form.repeat !== 'none' && (form.endType === 'count' || form.until) && (
            <p className="text-sm text-muted">
              {recurrenceText(recurrence(), `${form.date}T${form.startTime}`)}
            </p>
          )}
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">{t('fields.participants')}</legend>
          <p className="text-[0.8125rem] text-muted">{t('fields.participantsHint')}</p>
          <input
            type="search"
            className="h-9 w-full rounded-md border border-line-strong bg-panel px-3 text-sm sm:max-w-xs"
            placeholder={t('fields.searchPeople')}
            aria-label={t('fields.searchPeople')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <ul
            data-lenis-prevent
            className="grid max-h-48 gap-1 overflow-y-auto rounded-md border border-line p-2 sm:grid-cols-2"
          >
            {filtered.map((u) => (
              <li key={u.userId}>
                <Checkbox
                  label={u.displayName}
                  checked={form.participants.includes(u.userId)}
                  onChange={(e) =>
                    set(
                      'participants',
                      e.target.checked
                        ? [...form.participants, u.userId]
                        : form.participants.filter((x) => x !== u.userId),
                    )
                  }
                />
              </li>
            ))}
          </ul>
          <p className="text-[0.8125rem] text-muted">
            {t('fields.invitedCount', { count: form.participants.length })}
          </p>
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">{t('fields.reminders')}</legend>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {REMINDER_OPTIONS.map((m) => {
              const on = form.reminders.includes(m);
              return (
                <Checkbox
                  key={m}
                  label={reminderLabel(m)}
                  checked={on}
                  disabled={!on && form.reminders.length >= MEETING_LIMITS.remindersMax}
                  onChange={(e) =>
                    set(
                      'reminders',
                      e.target.checked
                        ? [...form.reminders, m]
                        : form.reminders.filter((x) => x !== m),
                    )
                  }
                />
              );
            })}
          </div>
          <p className="text-[0.8125rem] text-muted">{t('fields.remindersHint')}</p>
        </fieldset>

        <TextArea
          label={t('fields.notes')}
          optional
          rows={4}
          value={form.notes}
          maxLength={MEETING_LIMITS.notesMax}
          onChange={(e) => set('notes', e.target.value)}
        />

        {problems.length > 0 ? (
          <div
            role="alert"
            className="rounded-md border border-brick/30 bg-brick-soft px-4 py-3 text-sm"
          >
            <ul className="list-disc ps-5">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        ) : (
          <ErrorBanner error={save.error} />
        )}
      </div>
    </Dialog>
  );
}
