'use client';

import type { AuditLogDto } from '@esports/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useLocale, useMessages, useTranslations } from 'next-intl';
import { useState } from 'react';
import {
  Button,
  EmptyState,
  ErrorBanner,
  PageHeader,
  Section,
  Spinner,
  tableClass,
  tdClass,
  thClass,
} from '@/components/ui';
import { AuditNav } from '@/components/audit-nav';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

const PAGE = 50;

export default function AuditPage() {
  const t = useTranslations('audit');
  const tc = useTranslations('common');
  const locale = useLocale();
  const messages = useMessages() as { audit: { actions: Record<string, Record<string, string>> } };
  // Action keys are nested in the catalog ("team" -> "created"); flatten back to "team.created".
  const knownActions = Object.entries(messages.audit.actions).flatMap(([group, items]) =>
    Object.keys(items).map((k) => `${group}.${k}`),
  );
  const [action, setAction] = useState('');

  const logs = useInfiniteQuery({
    queryKey: ['audit', action],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams({ limit: String(PAGE) });
      if (action) q.set('action', action);
      if (pageParam) q.set('before', pageParam);
      return api<AuditLogDto[]>(`/audit-logs?${q.toString()}`);
    },
    getNextPageParam: (last) =>
      last.length === PAGE ? last[last.length - 1]!.createdAt : undefined,
  });
  const rows = logs.data?.pages.flat() ?? [];
  const label = (a: string) => (knownActions.includes(a) ? t(`actions.${a}` as never) : a);

  const who = (r: AuditLogDto) => {
    if (r.actor)
      return r.actorType === 'platform_admin'
        ? `${r.actor.displayName} (${t('platformAdmin')})`
        : r.actor.displayName;
    return r.actorType === 'system' ? t('system') : t('anonymous');
  };

  return (
    <>
      <PageHeader title={t('title')} lead={t('lead')} />
      <AuditNav />
      <Section
        title={t('title')}
        actions={
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted">{t('filterAction')}</span>
            <select
              value={action}
              onChange={(e) => setAction(e.target.value)}
              className="h-8 max-w-64 rounded-md border border-line-strong bg-panel px-2"
            >
              <option value="">{t('allActions')}</option>
              {knownActions.map((a) => (
                <option key={a} value={a}>
                  {label(a)}
                </option>
              ))}
            </select>
          </label>
        }
      >
        {logs.isLoading ? (
          <Spinner />
        ) : logs.error ? (
          <div className="p-5">
            <ErrorBanner error={logs.error} />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState title={t('empty')} />
        ) : (
          <div className="relative overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th className={thClass}>{t('when')}</th>
                  <th className={thClass}>{t('who')}</th>
                  <th className={thClass}>{t('what')}</th>
                  <th className={thClass}>{t('details')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className={`${tdClass} whitespace-nowrap text-sm`}>
                      {formatDateTime(r.createdAt, locale)}
                    </td>
                    <td className={tdClass}>{who(r)}</td>
                    <td className={tdClass}>{label(r.action)}</td>
                    <td className={`${tdClass} text-sm`}>
                      {Object.keys(r.metadata).length > 0 || r.ip ? (
                        <details>
                          <summary className="cursor-pointer text-muted">{t('details')}</summary>
                          <pre
                            dir="ltr"
                            className="mt-2 max-w-md overflow-x-auto rounded bg-panel-2 p-2 text-xs whitespace-pre-wrap"
                          >
                            {JSON.stringify(
                              {
                                target: r.targetType ? `${r.targetType}:${r.targetId}` : undefined,
                                ip: r.ip ?? undefined,
                                ...r.metadata,
                              },
                              null,
                              2,
                            )}
                          </pre>
                        </details>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {logs.hasNextPage && (
          <div className="border-t border-line px-5 py-3">
            <Button
              size="sm"
              onClick={() => logs.fetchNextPage()}
              disabled={logs.isFetchingNextPage}
            >
              {logs.isFetchingNextPage ? tc('loading') : tc('loadMore')}
            </Button>
          </div>
        )}
      </Section>
    </>
  );
}
