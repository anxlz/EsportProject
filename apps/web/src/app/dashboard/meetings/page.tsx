'use client';

import type { MeetingOccurrenceDto, TeamDto } from '@esports/shared';
import { useQuery } from '@tanstack/react-query';
import { CalendarClock, ChevronLeft, ChevronRight, Plus, Repeat } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { MeetingFormDialog } from '@/components/meetings/meeting-form';
import {
  Badge,
  Button,
  cx,
  EmptyState,
  ErrorBanner,
  PageHeader,
  SelectField,
  Spinner,
} from '@/components/ui';
import { api, apiPost } from '@/lib/api';
import {
  addDays,
  formatDayHeading,
  formatTime,
  isoDate,
  localDayKey,
  useMeetings,
} from '@/lib/meetings';
import { useAction } from '@/lib/mutation';
import { useCan } from '@/lib/session';

const WINDOW_DAYS = 28;

function ResponseBadge({ o }: { o: MeetingOccurrenceDto }) {
  const t = useTranslations('meetings');
  if (o.cancelled) return <Badge tone="brick">{t('occurrence.cancelled')}</Badge>;
  if (o.isOrganizer) return <Badge tone="turf">{t('organizer')}</Badge>;
  if (!o.myResponse) return null;
  const tone =
    o.myResponse === 'accepted' ? 'turf' : o.myResponse === 'declined' ? 'neutral' : 'amber';
  return <Badge tone={tone}>{t(`responses.${o.myResponse}`)}</Badge>;
}

export default function MeetingsPage() {
  const t = useTranslations('meetings');
  const locale = useLocale();
  const can = useCan();
  const [start, setStart] = useState(() => {
    const d = new Date();
    return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  });
  const [mine, setMine] = useState(false);
  const [teamId, setTeamId] = useState('');
  const [creating, setCreating] = useState(false);
  const from = isoDate(start);
  const to = isoDate(addDays(start, WINDOW_DAYS - 1));
  const list = useMeetings(from, to, { mine, teamId: teamId || undefined });
  const teams = useQuery({
    queryKey: ['teams'],
    queryFn: () => api<TeamDto[]>('/teams'),
    enabled: can('teams.view'),
  });
  const canCreate = can('meetings.create') || can('meetings.administrative');
  const respond = useAction(
    (v: { id: string; response: 'accepted' | 'declined' }) =>
      apiPost(`/meetings/${v.id}/respond`, { response: v.response }),
    { invalidate: [['meetings']], success: t('responded') },
  );

  // Group by the viewer's local day, inside the chosen window.
  const days = useMemo(() => {
    const groups = new Map<string, MeetingOccurrenceDto[]>();
    for (const o of list.data ?? []) {
      const key = localDayKey(o.start);
      if (key < from || key > to) continue;
      groups.set(key, [...(groups.get(key) ?? []), o]);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [list.data, from, to]);
  const todayKey = localDayKey(new Date().toISOString());

  return (
    <>
      <PageHeader
        title={t('title')}
        lead={t('lead')}
        actions={
          canCreate && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden="true" />
              {t('new')}
            </Button>
          )
        }
      />
      <div className="mb-5 flex flex-wrap items-end gap-3">
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            aria-label={t('previous')}
            onClick={() => setStart((d) => addDays(d, -WINDOW_DAYS))}
          >
            <ChevronLeft className="size-4 rtl:-scale-x-100" aria-hidden="true" />
          </Button>
          <p className="min-w-44 text-center text-sm font-medium" aria-live="polite">
            {t('window', {
              from: new Intl.DateTimeFormat(locale === 'ar' ? 'ar-u-ca-gregory-nu-latn' : 'en-GB', {
                day: 'numeric',
                month: 'short',
                timeZone: 'UTC',
              }).format(start),
              to: new Intl.DateTimeFormat(locale === 'ar' ? 'ar-u-ca-gregory-nu-latn' : 'en-GB', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
                timeZone: 'UTC',
              }).format(addDays(start, WINDOW_DAYS - 1)),
            })}
          </p>
          <Button
            size="sm"
            variant="ghost"
            aria-label={t('next')}
            onClick={() => setStart((d) => addDays(d, WINDOW_DAYS))}
          >
            <ChevronRight className="size-4 rtl:-scale-x-100" aria-hidden="true" />
          </Button>
        </div>
        <div
          role="group"
          aria-label={t('show')}
          className="inline-flex rounded-md border border-line-strong p-0.5"
        >
          {([false, true] as const).map((v) => (
            <button
              key={String(v)}
              type="button"
              aria-pressed={mine === v}
              onClick={() => setMine(v)}
              className={cx(
                'h-8 rounded px-3 text-sm',
                mine === v ? 'bg-turf text-turf-ink' : 'text-ink hover:bg-panel-2',
              )}
            >
              {v ? t('views.mine') : t('views.all')}
            </button>
          ))}
        </div>
        {(teams.data ?? []).length > 1 && (
          <div className="w-56">
            <SelectField
              label={t('filterTeam')}
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
            >
              <option value="">{t('allTeams')}</option>
              {teams.data!.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </SelectField>
          </div>
        )}
      </div>

      <ErrorBanner error={list.error ?? respond.error} />
      {list.isLoading ? (
        <Spinner />
      ) : !days.length ? (
        <div className="rounded-lg border border-line bg-panel">
          <EmptyState title={t('empty')} lead={canCreate ? t('emptyLead') : undefined} />
        </div>
      ) : (
        <ol className="flex flex-col gap-5">
          {days.map(([day, items]) => (
            <li key={day}>
              <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-muted">
                {formatDayHeading(day, locale)}
                {day === todayKey && <Badge tone="turf">{t('today')}</Badge>}
              </h2>
              <ul className="divide-y divide-line rounded-lg border border-line bg-panel">
                {items.map((o) => (
                  <li
                    key={`${o.meetingId}-${o.key}`}
                    className={cx(
                      'flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-3',
                      o.cancelled && 'opacity-70',
                    )}
                  >
                    <p className="text-sm tabular-nums sm:w-36 sm:shrink-0">
                      <bdi>{formatTime(o.start, locale)}</bdi> –{' '}
                      <bdi>{formatTime(o.end, locale)}</bdi>
                    </p>
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/dashboard/meetings/${o.meetingId}`}
                        dir="auto"
                        className={cx(
                          'block font-medium break-words hover:underline',
                          o.cancelled && 'line-through',
                        )}
                      >
                        {o.title}
                      </Link>
                      <p className="flex flex-wrap items-center gap-x-2 text-[0.8125rem] text-muted">
                        <span>
                          {o.kind === 'administrative'
                            ? t('kinds.administrative')
                            : (o.teamName ?? o.departmentName ?? t('fields.wholeOrganization'))}
                        </span>
                        {o.recurring && (
                          <span className="inline-flex items-center gap-1">
                            <Repeat className="size-3.5" aria-hidden="true" />
                            {t('recurring')}
                          </span>
                        )}
                        {o.moved && (
                          <span className="inline-flex items-center gap-1">
                            <CalendarClock className="size-3.5" aria-hidden="true" />
                            {t('occurrence.moved')}
                          </span>
                        )}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <ResponseBadge o={o} />
                      {o.myResponse === 'pending' && !o.cancelled && (
                        <>
                          <Button
                            size="sm"
                            variant="primary"
                            disabled={respond.isPending}
                            onClick={() =>
                              respond.mutate({ id: o.meetingId, response: 'accepted' })
                            }
                          >
                            {t('respond.accept')}
                          </Button>
                          <Button
                            size="sm"
                            disabled={respond.isPending}
                            onClick={() =>
                              respond.mutate({ id: o.meetingId, response: 'declined' })
                            }
                          >
                            {t('respond.decline')}
                          </Button>
                        </>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
      {creating && <MeetingFormDialog meeting={null} onClose={() => setCreating(false)} />}
    </>
  );
}
