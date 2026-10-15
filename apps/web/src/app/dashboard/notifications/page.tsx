'use client';

import type { NotificationDto } from '@esports/shared';
import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { Button, cx, EmptyState, ErrorBanner, PageHeader, Section, Spinner } from '@/components/ui';
import { api, apiPost } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useAction } from '@/lib/mutation';

export default function NotificationsPage() {
  const t = useTranslations('notifications');
  const locale = useLocale();
  const list = useQuery({ queryKey: ['notifications', 'list'], queryFn: () => api<NotificationDto[]>('/notifications?limit=100') });
  const invalidate = [['notifications']];
  const readAll = useAction(() => apiPost('/notifications/read-all'), { invalidate });
  const readOne = useAction((id: string) => apiPost(`/notifications/${id}/read`), { invalidate });

  const text = (n: NotificationDto) => {
    const key = `types.${n.type}`;
    return t.has(key as never) ? t(key as never, n.data as never) : n.type;
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
              <li key={n.id} className={cx('flex items-start gap-3 px-5 py-3', !n.readAt && 'bg-amber-soft/40')}>
                <span
                  aria-hidden="true"
                  className={cx('mt-2 size-2 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-amber')}
                />
                <div className="min-w-0 flex-1">
                  {n.link ? (
                    <Link href={n.link} onClick={() => !n.readAt && readOne.mutate(n.id)} className="hover:underline">
                      {text(n)}
                    </Link>
                  ) : (
                    <p>{text(n)}</p>
                  )}
                  <p className="text-[0.8125rem] text-muted">{formatDateTime(n.createdAt, locale)}</p>
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
