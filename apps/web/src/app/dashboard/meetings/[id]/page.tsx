'use client';

import type { MeetingDto, MeetingOccurrenceDto } from '@esports/shared';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Ban, Bell, CalendarDays, Download, Pencil, Repeat, Users } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { MeetingFormDialog } from '@/components/meetings/meeting-form';
import {
  Badge,
  Button,
  ConfirmDialog,
  cx,
  ErrorBanner,
  PageHeader,
  Section,
  Spinner,
  TextArea,
  TextField,
} from '@/components/ui';
import { api, apiPost } from '@/lib/api';
import {
  browserTimeZone,
  formatTime,
  formatWhen,
  useRecurrenceText,
  useReminderLabel,
} from '@/lib/meetings';
import { useAction } from '@/lib/mutation';
import { useMe } from '@/lib/session';

function Field({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof Users;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-[0.8125rem] text-muted">{label}</p>
        <div className="text-[0.9375rem]">{children}</div>
      </div>
    </div>
  );
}

export default function MeetingPage() {
  const { id } = useParams<{ id: string }>();
  const t = useTranslations('meetings');
  const ti = useTranslations('integrations');
  const locale = useLocale();
  const recurrenceText = useRecurrenceText();
  const reminderLabel = useReminderLabel();
  const meUser = useMe();
  const meeting = useQuery({
    queryKey: ['meetings', 'one', id],
    queryFn: () => api<MeetingDto>(`/meetings/${id}`),
  });
  const [editing, setEditing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [occurrence, setOccurrence] = useState<MeetingOccurrenceDto | null>(null);
  const invalidate = [['meetings']];
  const respond = useAction(
    (response: 'accepted' | 'declined') =>
      apiPost(`/meetings/${id}/respond`, {
        response,
        note: note === null ? undefined : note.trim() || null,
      }),
    { invalidate, success: t('responded'), onSuccess: () => setNote(null) },
  );
  const cancel = useAction(
    () => apiPost(`/meetings/${id}/cancel`, { reason: reason.trim() || null }),
    {
      invalidate,
      success: t('cancelledToast'),
      onSuccess: () => setCancelling(false),
    },
  );
  const cancelOne = useAction(
    (key: string) => apiPost(`/meetings/${id}/occurrences/cancel`, { originalStart: key }),
    {
      invalidate,
      success: t('occurrence.cancelledToast'),
      onSuccess: () => setOccurrence(null),
    },
  );

  if (meeting.isLoading) return <Spinner />;
  if (meeting.error || !meeting.data)
    return (
      <>
        <PageHeader title={t('title')} />
        <ErrorBanner error={meeting.error} />
      </>
    );
  const m = meeting.data;
  const own = browserTimeZone();
  const mine = m.participants.find((p) => p.userId === meUser.user.id);

  return (
    <>
      <Link
        href="/dashboard/meetings"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"
      >
        <ArrowLeft className="size-4 rtl:-scale-x-100" aria-hidden="true" />
        {t('back')}
      </Link>
      <PageHeader
        title={m.title}
        lead={
          m.kind === 'administrative'
            ? t('kinds.administrative')
            : (m.teamName ?? m.departmentName ?? t('fields.wholeOrganization'))
        }
        actions={
          <>
            <a
              className="inline-flex h-10 items-center gap-2 rounded-md border border-line-strong bg-panel px-4 text-[0.9375rem] font-medium hover:bg-panel-2"
              href={`/api/integrations/obsidian/notes/${m.id}`}
            >
              <Download className="size-4" aria-hidden="true" />
              {t('detail.obsidian')}
            </a>
            {m.canEdit && (
              <>
                <Button onClick={() => setEditing(true)}>
                  <Pencil className="size-4" aria-hidden="true" />
                  {t('edit')}
                </Button>
                <Button variant="danger" onClick={() => setCancelling(true)}>
                  <Ban className="size-4" aria-hidden="true" />
                  {t('cancel.action')}
                </Button>
              </>
            )}
          </>
        }
      />
      {m.status === 'cancelled' && (
        <p
          role="status"
          className="mb-5 rounded-md border border-brick/30 bg-brick-soft px-4 py-3 text-sm"
        >
          {m.cancelReason
            ? t('cancel.bannerWithReason', { reason: m.cancelReason })
            : t('cancel.banner')}
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-5">
          <Section title={t('detail.details')}>
            <div className="grid gap-5 px-5 py-4 sm:grid-cols-2">
              <Field icon={CalendarDays} label={t('detail.when')}>
                <p>
                  <bdi>{formatWhen(m.start, locale, m.timeZone)}</bdi> –{' '}
                  <bdi>{formatTime(m.end, locale, m.timeZone)}</bdi>
                </p>
                <p className="text-[0.8125rem] text-muted" dir="ltr">
                  {m.timeZone}
                </p>
                {own !== m.timeZone && (
                  <p className="text-[0.8125rem] text-muted">
                    {t('detail.yourTime', { time: formatWhen(m.start, locale, own) })}
                  </p>
                )}
              </Field>
              <Field icon={Repeat} label={t('detail.repeats')}>
                {recurrenceText(m.recurrence, m.startLocal)}
              </Field>
              <Field icon={Bell} label={t('fields.reminders')}>
                {m.reminderMinutes.length
                  ? m.reminderMinutes
                      .map((x) => reminderLabel(x))
                      .join(locale === 'ar' ? '، ' : ', ')
                  : t('detail.noReminders')}
              </Field>
              <Field icon={Users} label={t('organizer')}>
                {m.organizer?.displayName ?? '—'}
              </Field>
            </div>
            {(m.description || m.notes) && (
              <div className="flex flex-col gap-4 border-t border-line px-5 py-4">
                {m.description && (
                  <div>
                    <h3 className="text-sm font-medium">{t('fields.description')}</h3>
                    <p dir="auto" className="mt-1 whitespace-pre-wrap text-[0.9375rem]">
                      {m.description}
                    </p>
                  </div>
                )}
                {m.notes && (
                  <div>
                    <h3 className="text-sm font-medium">{t('fields.notes')}</h3>
                    <p dir="auto" className="mt-1 whitespace-pre-wrap text-[0.9375rem]">
                      {m.notes}
                    </p>
                  </div>
                )}
              </div>
            )}
          </Section>

          <Section
            title={t('detail.upcoming')}
            lead={m.recurrence ? t('detail.upcomingLead') : undefined}
          >
            {!m.upcoming.length ? (
              <p className="px-5 py-4 text-sm text-muted">{t('detail.nothingUpcoming')}</p>
            ) : (
              <ul className="divide-y divide-line">
                {m.upcoming.map((o) => (
                  <li key={o.key} className="flex flex-wrap items-center gap-3 px-5 py-2.5">
                    <span
                      className={cx(
                        'flex-1 text-[0.9375rem]',
                        o.cancelled && 'text-muted line-through',
                      )}
                    >
                      {formatWhen(o.start, locale, m.timeZone)}
                    </span>
                    {o.cancelled && <Badge tone="brick">{t('occurrence.cancelled')}</Badge>}
                    {o.moved && !o.cancelled && <Badge tone="amber">{t('occurrence.moved')}</Badge>}
                    {m.canEdit && m.recurrence && !o.cancelled && (
                      <Button size="sm" variant="ghost" onClick={() => setOccurrence(o)}>
                        {t('occurrence.cancelOne')}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>

        <div className="flex flex-col gap-5">
          {m.canRespond && !mine?.isOrganizer && (
            <Section
              title={t('respond.title')}
              lead={
                m.myResponse
                  ? t('respond.current', { response: t(`responses.${m.myResponse}`) })
                  : undefined
              }
            >
              <div className="flex flex-col gap-3 px-5 py-4">
                <div className="flex gap-2">
                  <Button
                    variant={m.myResponse === 'accepted' ? 'primary' : 'secondary'}
                    aria-pressed={m.myResponse === 'accepted'}
                    disabled={respond.isPending}
                    onClick={() => respond.mutate('accepted')}
                  >
                    {t('respond.accept')}
                  </Button>
                  <Button
                    variant={m.myResponse === 'declined' ? 'primary' : 'secondary'}
                    aria-pressed={m.myResponse === 'declined'}
                    disabled={respond.isPending}
                    onClick={() => respond.mutate('declined')}
                  >
                    {t('respond.decline')}
                  </Button>
                </div>
                <TextField
                  label={t('respond.note')}
                  optional
                  maxLength={500}
                  value={note ?? mine?.note ?? ''}
                  onChange={(e) => setNote(e.target.value)}
                />
                <ErrorBanner error={respond.error} />
              </div>
            </Section>
          )}
          <Section
            title={t('detail.participants')}
            lead={t('detail.answered', {
              count: m.participants.filter((p) => p.response !== 'pending').length,
              total: m.participants.length,
            })}
          >
            <ul className="divide-y divide-line">
              {m.participants.map((p) => (
                <li key={p.userId} className="flex items-center gap-2 px-5 py-2.5">
                  <span className="min-w-0 flex-1 truncate">{p.displayName}</span>
                  {p.isOrganizer ? (
                    <Badge tone="turf">{t('organizer')}</Badge>
                  ) : (
                    <Badge
                      tone={
                        p.response === 'accepted'
                          ? 'turf'
                          : p.response === 'declined'
                            ? 'neutral'
                            : 'amber'
                      }
                    >
                      {t(`responses.${p.response}`)}
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          </Section>
          {m.syncLinks.length > 0 && (
            <Section title={t('detail.syncedTo')}>
              <ul className="flex flex-col gap-1.5 px-5 py-4 text-sm">
                {m.syncLinks.map((l) => (
                  <li key={l.connectionId}>
                    {l.remoteUrl ? (
                      <a
                        href={l.remoteUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-turf hover:underline"
                      >
                        {ti(`providers.${l.provider}`)}
                      </a>
                    ) : (
                      ti(`providers.${l.provider}`)
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      </div>

      {editing && <MeetingFormDialog meeting={m} onClose={() => setEditing(false)} />}
      <ConfirmDialog
        open={cancelling}
        title={t('cancel.title')}
        body={t('cancel.body')}
        confirmLabel={t('cancel.action')}
        danger
        busy={cancel.isPending}
        error={cancel.error}
        onConfirm={() => cancel.mutate(undefined)}
        onClose={() => setCancelling(false)}
      >
        <TextArea
          label={t('cancel.reason')}
          optional
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
        />
      </ConfirmDialog>
      <ConfirmDialog
        open={!!occurrence}
        title={t('occurrence.cancelOneTitle')}
        body={
          occurrence
            ? t('occurrence.cancelOneBody', {
                when: formatWhen(occurrence.start, locale, m.timeZone),
              })
            : undefined
        }
        confirmLabel={t('occurrence.cancelOne')}
        danger
        busy={cancelOne.isPending}
        error={cancelOne.error}
        onConfirm={() => occurrence && cancelOne.mutate(occurrence.key)}
        onClose={() => setOccurrence(null)}
      />
    </>
  );
}
