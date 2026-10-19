'use client';

import { ASSISTANT_KEYS, type AssistantKey, type ToolCallLogDto } from '@esports/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { useToolLabel } from '@/components/assistants/answer-parts';
import { AuditNav } from '@/components/audit-nav';
import {
  Badge,
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
import { api } from '@/lib/api';
import { lookupInput } from '@/lib/assistants';
import { formatDateTime } from '@/lib/format';

const PAGE = 100;

const OUTCOME_TONE = {
  ok: 'turf',
  denied: 'amber',
  not_found: 'neutral',
  error: 'brick',
  unknown_tool: 'brick',
} as const;

/** The assistants' lookup log (spec §8.1 guardrail 4): what was looked up, by whom, and when. */
export default function ToolCallsPage() {
  const t = useTranslations('audit');
  const ta = useTranslations('assistants');
  const tl = useTranslations('assistants.toolLog');
  const tc = useTranslations('common');
  const locale = useLocale();
  const toolLabel = useToolLabel();
  const [assistant, setAssistant] = useState<AssistantKey | ''>('');

  const log = useInfiniteQuery({
    queryKey: ['assistants', 'tool-calls', assistant],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams({ limit: String(PAGE) });
      if (assistant) q.set('assistant', assistant);
      if (pageParam) q.set('before', pageParam);
      return api<ToolCallLogDto[]>(`/assistants/tool-calls?${q.toString()}`);
    },
    getNextPageParam: (last) =>
      last.length === PAGE ? last[last.length - 1]!.createdAt : undefined,
  });
  const rows = log.data?.pages.flat() ?? [];

  const result = (r: ToolCallLogDto) => {
    const s = r.resultSummary;
    if (s.error) return <span dir="ltr">{s.error}</span>;
    const parts: string[] = [];
    if (typeof s.count === 'number') parts.push(tl('results', { count: s.count }));
    if (s.sourceIds?.length) parts.push(s.sourceIds.join(', '));
    return parts.join(' · ');
  };

  return (
    <>
      <PageHeader title={t('title')} lead={t('lead')} />
      <AuditNav />
      <Section
        title={tl('title')}
        lead={tl('lead')}
        actions={
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted">{tl('filter')}</span>
            <select
              value={assistant}
              onChange={(e) => setAssistant(e.target.value as AssistantKey | '')}
              className="h-8 max-w-64 rounded-md border border-line-strong bg-panel px-2"
            >
              <option value="">{tl('allAssistants')}</option>
              {ASSISTANT_KEYS.map((k) => (
                <option key={k} value={k}>
                  {ta(`names.${k}`)}
                </option>
              ))}
            </select>
          </label>
        }
      >
        {log.isLoading ? (
          <Spinner />
        ) : log.error ? (
          <div className="p-5">
            <ErrorBanner error={log.error} />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState title={tl('empty')} />
        ) : (
          <div className="relative overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th className={thClass}>{tl('when')}</th>
                  <th className={thClass}>{tl('who')}</th>
                  <th className={thClass}>{tl('assistant')}</th>
                  <th className={thClass}>{tl('lookup')}</th>
                  <th className={thClass}>{tl('input')}</th>
                  <th className={thClass}>{tl('outcome')}</th>
                  <th className={thClass}>{tl('result')}</th>
                  <th className={thClass}>{tl('duration')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className={`${tdClass} text-sm whitespace-nowrap`}>
                      {formatDateTime(r.createdAt, locale)}
                    </td>
                    <td className={tdClass}>{r.user.displayName}</td>
                    <td className={`${tdClass} text-sm`}>{ta(`short.${r.assistant}`)}</td>
                    <td className={`${tdClass} text-sm`}>{toolLabel(r.tool)}</td>
                    <td className={`${tdClass} max-w-xs text-sm break-words text-muted`} dir="auto">
                      {lookupInput(r.input)}
                    </td>
                    <td className={tdClass}>
                      <Badge tone={OUTCOME_TONE[r.outcome]}>{ta(`outcomes.${r.outcome}`)}</Badge>
                    </td>
                    <td className={`${tdClass} text-sm text-muted`}>{result(r)}</td>
                    <td className={`${tdClass} text-sm whitespace-nowrap text-muted tabular-nums`}>
                      {r.durationMs !== null ? tl('ms', { ms: r.durationMs }) : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {log.hasNextPage && (
          <div className="border-t border-line px-5 py-3">
            <Button size="sm" onClick={() => log.fetchNextPage()} disabled={log.isFetchingNextPage}>
              {log.isFetchingNextPage ? tc('loading') : tc('loadMore')}
            </Button>
          </div>
        )}
      </Section>
    </>
  );
}
