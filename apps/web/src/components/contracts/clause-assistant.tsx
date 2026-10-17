'use client';

import type { ClauseProposalDto, ContractDto } from '@esports/shared';
import { useQuery } from '@tanstack/react-query';
import { ShieldAlert, Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Badge, Button, Dialog, ErrorBanner, SelectField, TextArea } from '@/components/ui';
import { api, apiPost } from '@/lib/api';
import { useAssistantStatus, useContractLocale } from '@/lib/contracts';
import { formatDateTime } from '@/lib/format';
import { useAction } from '@/lib/mutation';

/** The non-legal-advice caveat, shown with every assistant output (spec §7.4). */
export function AssistantCaveat() {
  const t = useTranslations('contracts.assistant');
  return (
    <p
      role="note"
      className="flex gap-2.5 rounded-md border border-amber/40 bg-amber-soft px-3 py-2.5 text-sm text-amber-ink"
    >
      <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>{t('caveat')}</span>
    </p>
  );
}

function ProposalView({ p }: { p: ClauseProposalDto }) {
  const t = useTranslations('contracts.assistant');
  return (
    <div className="flex flex-col gap-3 rounded-md border border-line bg-panel-2 p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div dir="ltr" lang="en" className="text-start">
          <p className="font-semibold">{p.titleEn}</p>
          <p className="mt-1 text-sm whitespace-pre-line">{p.bodyEn}</p>
        </div>
        <div dir="rtl" lang="ar" className="text-start">
          <p className="font-semibold">{p.titleAr}</p>
          <p className="mt-1 text-sm whitespace-pre-line">{p.bodyAr}</p>
        </div>
      </div>
      {!!p.questions.length && (
        <div>
          <p className="text-sm font-medium">{t('questions')}</p>
          <ul className="mt-1 list-disc ps-5 text-sm">
            {p.questions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </div>
      )}
      {p.notes && (
        <p className="text-sm text-muted">
          <span className="font-medium text-ink">{t('notes')}: </span>
          {p.notes}
        </p>
      )}
      <p className="text-[0.8125rem] text-muted">{t('model', { model: p.model })}</p>
    </div>
  );
}

export function ClauseAssistantDialog({
  contract,
  dirty,
  onClose,
}: {
  contract: ContractDto;
  dirty: boolean;
  onClose: () => void;
}) {
  const t = useTranslations('contracts.assistant');
  const tc = useTranslations('common');
  const loc = useContractLocale();
  const status = useAssistantStatus();
  const proposals = useQuery({
    queryKey: ['contracts', 'proposals', contract.id],
    queryFn: () => api<ClauseProposalDto[]>(`/contracts/${contract.id}/proposals`),
  });
  const [purpose, setPurpose] = useState('');
  const [feedback, setFeedback] = useState('');
  const [current, setCurrent] = useState<ClauseProposalDto | null>(null);
  const [before, setBefore] = useState('');
  const invalidate = [['contracts', 'proposals', contract.id]];
  const draft = useAction(
    (revise: boolean) =>
      apiPost<ClauseProposalDto>(
        `/contracts/${contract.id}/proposals`,
        revise && current
          ? { purpose: current.purpose, revisionOf: current.id, feedback }
          : { purpose },
      ),
    {
      invalidate,
      onSuccess: (p) => {
        setCurrent(p);
        setFeedback('');
      },
    },
  );
  const accept = useAction(
    () =>
      apiPost<{ clauseId: string; contract: ContractDto }>(
        `/contracts/${contract.id}/proposals/${current!.id}/accept`,
        { beforeClauseId: before || null },
      ),
    {
      invalidate: [...invalidate, ['contracts']],
      success: (r) => t('accepted', { version: r.contract.currentVersion }),
      onSuccess: onClose,
    },
  );
  const discard = useAction(
    () => apiPost(`/contracts/${contract.id}/proposals/${current!.id}/reject`),
    {
      invalidate,
      success: t('discarded'),
      onSuccess: () => setCurrent(null),
    },
  );
  const included = contract.snapshot.clauses.filter((c) => c.included);
  const earlier = (proposals.data ?? []).filter((p) => p.id !== current?.id);

  return (
    <Dialog open wide onClose={onClose} title={t('title')} lead={t('nothingChanges')}>
      <div className="flex flex-col gap-4">
        <AssistantCaveat />
        {status.data && !status.data.configured ? (
          <p className="rounded-md border border-line bg-panel-2 px-4 py-3 text-sm">
            {t('notConfigured')}
          </p>
        ) : (
          <>
            <ErrorBanner error={draft.error ?? accept.error ?? discard.error} />
            {!current && (
              <>
                <TextArea
                  label={t('purpose')}
                  hint={t('purposeHint')}
                  rows={4}
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value)}
                />
                <div>
                  <Button
                    variant="primary"
                    disabled={purpose.trim().length < 5 || draft.isPending}
                    onClick={() => draft.mutate(false)}
                  >
                    <Sparkles className="size-4" aria-hidden="true" />
                    {draft.isPending ? t('drafting') : t('draft')}
                  </Button>
                </div>
              </>
            )}
            {current && (
              <section aria-label={t('proposal')} className="flex flex-col gap-4">
                <h3 className="font-semibold">{t('proposal')}</h3>
                <ProposalView p={current} />
                <TextArea
                  label={t('feedback')}
                  rows={2}
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                />
                <div className="flex flex-wrap items-end gap-3">
                  <Button disabled={draft.isPending} onClick={() => draft.mutate(true)}>
                    {draft.isPending ? t('drafting') : t('revise')}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={discard.isPending}
                    onClick={() => discard.mutate(undefined)}
                  >
                    {t('discard')}
                  </Button>
                </div>
                <div className="flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-end">
                  <div className="sm:w-80">
                    <SelectField
                      label={t('insertAt')}
                      value={before}
                      onChange={(e) => setBefore(e.target.value)}
                    >
                      <option value="">{t('atEnd')}</option>
                      {included.map((c, i) => (
                        <option key={c.id} value={c.id}>
                          {t('before', {
                            n: i + 1,
                            title: (loc === 'ar'
                              ? c.titleAr || c.titleEn
                              : c.titleEn || c.titleAr
                            ).slice(0, 60),
                          })}
                        </option>
                      ))}
                    </SelectField>
                  </div>
                  <Button
                    variant="primary"
                    disabled={dirty || accept.isPending}
                    onClick={() => accept.mutate(undefined)}
                  >
                    {accept.isPending ? tc('saving') : t('insert')}
                  </Button>
                </div>
                {dirty && <p className="text-sm text-brick">{t('saveFirst')}</p>}
              </section>
            )}
          </>
        )}
        {!!earlier.length && (
          <details className="rounded-md border border-line px-4 py-3">
            <summary className="cursor-pointer text-sm font-medium">{t('history')}</summary>
            <ul className="mt-3 flex flex-col gap-3">
              {earlier.map((p) => (
                <li key={p.id} className="flex flex-col gap-1 text-sm">
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge tone={p.status === 'accepted' ? 'turf' : 'neutral'}>
                      {t(`status.${p.status}`)}
                    </Badge>
                    <span className="font-medium">{loc === 'ar' ? p.titleAr : p.titleEn}</span>
                    <span className="text-muted">{formatDateTime(p.createdAt, loc)}</span>
                  </span>
                  {p.status === 'proposed' && (
                    <span>
                      <Button size="sm" variant="ghost" onClick={() => setCurrent(p)}>
                        {t('proposal')}
                      </Button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </Dialog>
  );
}
