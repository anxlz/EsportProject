'use client';

import { categoryLabel, formatMoney, type NotificationDto } from '@esports/shared';
import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { Button, cx, EmptyState, ErrorBanner, PageHeader, Section, Spinner } from '@/components/ui';
import { api, apiPost } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { formatWhen } from '@/lib/meetings';
import { useAction } from '@/lib/mutation';
import { useRiyalSign } from '@/lib/riyal';

export default function NotificationsPage() {
  const t = useTranslations('notifications');
  const locale = useLocale();
  const list = useQuery({
    queryKey: ['notifications', 'list'],
    queryFn: () => api<NotificationDto[]>('/notifications?limit=100'),
  });
  const invalidate = [['notifications']];
  const readAll = useAction(() => apiPost('/notifications/read-all'), { invalidate });
  const readOne = useAction((id: string) => apiPost(`/notifications/${id}/read`), { invalidate });

  const fl = locale === 'ar' ? 'ar' : 'en';
  const riyalSign = useRiyalSign();
  const tm = useTranslations('meetings');
  const ti = useTranslations('integrations');
  /** Budget alerts carry raw amounts and a category key; format them for the reader. */
  const values = (n: NotificationDto): Record<string, string> => {
    const d = n.data as Record<string, string | null>;
    if (n.type.startsWith('meeting.')) {
      // Meeting times are shown in the reader's own time zone.
      return {
        ...(d as Record<string, string>),
        title: d.title ?? '',
        when: d.start ? formatWhen(d.start, locale) : '',
        response: d.response ? tm(`responses.${d.response}` as never) : '',
      };
    }
    if (n.type.startsWith('integration.')) {
      return {
        ...(d as Record<string, string>),
        name: d.provider ? ti(`providers.${d.provider}` as never) : (d.name ?? ''),
        title: d.title ?? '',
        code: d.code ?? '',
        fields: (d.fields ?? '')
          .split(', ')
          .filter(Boolean)
          .map((f) => (ti.has(`fieldNames.${f}` as never) ? ti(`fieldNames.${f}` as never) : f))
          .join(locale === 'ar' ? '، ' : ', '),
      };
    }
    if (n.type !== 'budget.exceeded') return d as Record<string, string>;
    const c = d.currency ?? 'USD';
    return {
      budgetName: d.budgetName ?? '',
      actual: formatMoney(d.actual ?? '0', c, fl, { riyalSign }),
      planned: formatMoney(d.planned ?? '0', c, fl, { riyalSign }),
      line: d.category
        ? t('budgetLine', { category: categoryLabel(fl, d.category) })
        : t('budgetTotal'),
    };
  };
  const text = (n: NotificationDto) => {
    const key = `types.${n.type}`;
    return t.has(key as never) ? t(key as never, values(n) as never) : n.type;
  };
  const unread = (list.data ?? []).filter((n) => !n.readAt).length;

  return (
    <>
      <PageHeader
        title={t('title')}
        lead={t('unread', { count: unread })}
        actions={
          unread > 0 && (
            <Button onClick={() => readAll.mutate(undefined)} disabled={readAll.isPending}>
              {t('markAllRead')}
            </Button>
          )
        }
      />
      <Section title={t('title')}>
        {list.isLoading ? (
          <Spinner />
        ) : list.error ? (
          <div className="p-5">
            <ErrorBanner error={list.error} />
          </div>
        ) : !list.data?.length ? (
          <EmptyState title={t('empty')} />
        ) : (
          <ul className="divide-y divide-line">
            {list.data.map((n) => (
              <li
                key={n.id}
                className={cx('flex items-start gap-3 px-5 py-3', !n.readAt && 'bg-amber-soft/40')}
              >
                <span
                  aria-hidden="true"
                  className={cx(
                    'mt-2 size-2 shrink-0 rounded-full',
                    n.readAt ? 'bg-transparent' : 'bg-amber',
                  )}
                />
                <div className="min-w-0 flex-1">
                  {n.link ? (
                    <Link
                      href={n.link}
                      onClick={() => !n.readAt && readOne.mutate(n.id)}
                      className="hover:underline"
                    >
                      {text(n)}
                    </Link>
                  ) : (
                    <p>{text(n)}</p>
                  )}
                  <p className="text-[0.8125rem] text-muted">
                    {formatDateTime(n.createdAt, locale)}
                  </p>
                </div>
                {!n.readAt && (
                  <Button size="sm" variant="ghost" onClick={() => readOne.mutate(n.id)}>
                    {t('markRead')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
