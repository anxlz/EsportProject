'use client';

import {
  TERMINATION_REASON_CODES,
  type ContractDto,
  type ContractTerminationViewDto,
  contractTerminationRequestSchema,
} from '@esports/shared';
import { useQuery } from '@tanstack/react-query';
import { Download, FileWarning, ShieldCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  ErrorBanner,
  Section,
  SelectField,
  Spinner,
  TextArea,
  TextField,
} from '@/components/ui';
import { api, ApiError, apiPost } from '@/lib/api';
import { downloadGet, useContractLabels, useContractLocale } from '@/lib/contracts';
import { formatDate, formatDateTime } from '@/lib/format';
import { useAction } from '@/lib/mutation';

const today = () => new Date().toISOString().slice(0, 10);

export function TerminationPanel({ c }: { c: ContractDto }) {
  const t = useTranslations('contracts.termination');
  const tc = useTranslations('common');
  const locale = useContractLocale();
  const labels = useContractLabels();
  const [dialog, setDialog] = useState<'request' | 'respond' | 'execute' | 'withdraw' | null>(null);
  const [reasonCode, setReasonCode] =
    useState<(typeof TERMINATION_REASON_CODES)[number]>('mutual_agreement');
  const [reasonDetails, setReasonDetails] = useState('');
  const [effectiveDate, setEffectiveDate] = useState(today);
  const [noticePeriodDays, setNoticePeriodDays] = useState('0');
  const [note, setNote] = useState('');
  const [invalid, setInvalid] = useState<unknown>(null);
  const [downloadError, setDownloadError] = useState<unknown>(null);
  const query = useQuery({
    queryKey: ['contracts', 'termination', c.id],
    queryFn: () => api<ContractTerminationViewDto>(`/contracts/${c.id}/termination`),
  });
  const refresh = [['contracts']];
  const close = () => {
    setDialog(null);
    setInvalid(null);
    setNote('');
  };
  const request = useAction(
    () => {
      const body = {
        reasonCode,
        reasonDetails: reasonDetails.trim() || null,
        effectiveDate,
        noticePeriodDays: Number(noticePeriodDays),
      };
      const parsed = contractTerminationRequestSchema.safeParse(body);
      if (!parsed.success) {
        const error = new ApiError(
          400,
          'validation_failed',
          'Validation failed',
          parsed.error.issues,
        );
        setInvalid(error);
        return Promise.reject(error);
      }
      return apiPost<ContractTerminationViewDto>(`/contracts/${c.id}/termination`, parsed.data);
    },
    {
      invalidate: refresh,
      success: t('requested'),
      onSuccess: close,
    },
  );
  const respond = useAction(
    (decision: 'accepted' | 'rejected') =>
      apiPost<ContractTerminationViewDto>(`/contracts/${c.id}/termination/respond`, {
        decision,
        note: note.trim() || null,
      }),
    {
      invalidate: refresh,
      success: t('responded'),
      onSuccess: close,
    },
  );
  const withdraw = useAction(
    () => apiPost<ContractTerminationViewDto>(`/contracts/${c.id}/termination/withdraw`),
    { invalidate: refresh, success: t('withdrawn'), onSuccess: close },
  );
  const execute = useAction(
    () =>
      apiPost<ContractTerminationViewDto>(`/contracts/${c.id}/termination/execute`, {
        settlementNotes: note.trim() || null,
      }),
    {
      invalidate: refresh,
      success: t('executed'),
      onSuccess: close,
    },
  );

  if (query.isLoading) return <Spinner />;
  if (query.error || !query.data) return <ErrorBanner error={query.error} />;
  const { current, events, can } = query.data;
  const needsDetails = reasonCode === 'breach' || reasonCode === 'non_performance';

  return (
    <Section
      title={t('title')}
      lead={t('lead')}
      actions={
        can.request ? (
          <Button variant="secondary" onClick={() => setDialog('request')}>
            <FileWarning className="size-4" aria-hidden="true" />
            {t('request')}
          </Button>
        ) : null
      }
    >
      <div className="flex flex-col gap-4 px-5 py-4">
        <ErrorBanner error={downloadError ?? request.error ?? respond.error ?? execute.error} />
        {current ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={current.status === 'executed' ? 'brick' : 'amber'}>
                {labels.terminationStatus[current.status]}
              </Badge>
              <span className="text-sm text-muted">
                {t('effectiveDate')}: {formatDate(current.effectiveDate, locale)}
              </span>
            </div>
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted">{t('reason')}</dt>
                <dd>
                  {labels.terminationReason[current.reasonCode]}
                  {current.reasonDetails && (
                    <p className="mt-1 whitespace-pre-line">{current.reasonDetails}</p>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-muted">{t('initiatedBy')}</dt>
                <dd>{current.initiatedBy.displayName}</dd>
                <dt className="mt-2 text-muted">{t('noticePeriod')}</dt>
                <dd>{t('days', { count: current.noticePeriodDays })}</dd>
              </div>
            </dl>
            {current.counterpartyNote && (
              <p className="rounded-md bg-panel-2 px-3 py-2 text-sm whitespace-pre-line">
                {current.counterpartyNote}
              </p>
            )}
            {can.respond && (
              <Button variant="secondary" onClick={() => setDialog('respond')}>
                <ShieldCheck className="size-4" aria-hidden="true" />
                {t('review')}
              </Button>
            )}
            {can.withdraw && (
              <Button variant="ghost" onClick={() => setDialog('withdraw')}>
                {t('withdraw')}
              </Button>
            )}
            <ConfirmDialog
              open={dialog === 'withdraw'}
              title={t('withdraw')}
              body={t('withdrawLead')}
              confirmLabel={t('withdraw')}
              busy={withdraw.isPending}
              error={withdraw.error}
              onConfirm={() => withdraw.mutate(undefined)}
              onClose={close}
            />
            {can.execute && (
              <Button variant="primary" onClick={() => setDialog('execute')}>
                {t('execute')}
              </Button>
            )}
            {current.status === 'executed' && c.can.export && (
              <Button
                variant="secondary"
                onClick={() =>
                  downloadGet(`/contracts/${c.id}/termination/notice.pdf`).catch(setDownloadError)
                }
              >
                <Download className="size-4" aria-hidden="true" />
                {t('downloadNotice')}
              </Button>
            )}
            <ol className="divide-y divide-line border-t border-line">
              {events.map((event) => (
                <li key={event.id} className="py-2 text-sm">
                  <p>{t(`events.${event.action}`)}</p>
                  <p className="text-muted">
                    {event.actor?.displayName ?? event.actorRole} ·{' '}
                    {formatDateTime(event.createdAt, locale)}
                  </p>
                  {event.note && <p className="mt-1 whitespace-pre-line">{event.note}</p>}
                </li>
              ))}
            </ol>
          </>
        ) : (
          <p className="text-sm text-muted">{t('empty')}</p>
        )}
      </div>

      {dialog === 'request' && (
        <Dialog
          open
          onClose={close}
          title={t('request')}
          lead={t('requestLead')}
          footer={
            <>
              <Button onClick={close}>{tc('cancel')}</Button>
              <Button
                variant="primary"
                disabled={request.isPending}
                onClick={() => request.mutate(undefined)}
              >
                {request.isPending ? tc('saving') : t('request')}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <ErrorBanner error={invalid} />
            <SelectField
              label={t('reason')}
              value={reasonCode}
              onChange={(e) =>
                setReasonCode(e.target.value as (typeof TERMINATION_REASON_CODES)[number])
              }
            >
              {TERMINATION_REASON_CODES.map((value) => (
                <option key={value} value={value}>
                  {labels.terminationReason[value]}
                </option>
              ))}
            </SelectField>
            <TextArea
              label={t('reasonDetails')}
              required={needsDetails}
              optional={!needsDetails}
              value={reasonDetails}
              onChange={(e) => setReasonDetails(e.target.value)}
            />
            <TextField
              label={t('effectiveDate')}
              type="date"
              min={today()}
              value={effectiveDate}
              onChange={(e) => setEffectiveDate(e.target.value)}
            />
            <TextField
              label={t('noticePeriod')}
              type="number"
              min="0"
              max="3650"
              value={noticePeriodDays}
              onChange={(e) => setNoticePeriodDays(e.target.value)}
            />
          </div>
        </Dialog>
      )}
      {dialog === 'respond' && (
        <Dialog
          open
          onClose={close}
          title={t('responseTitle')}
          lead={t('responseLead')}
          footer={
            <>
              <Button onClick={close}>{tc('cancel')}</Button>
              <Button
                variant="danger"
                disabled={respond.isPending}
                onClick={() => respond.mutate('rejected')}
              >
                {t('reject')}
              </Button>
              <Button
                variant="primary"
                disabled={respond.isPending}
                onClick={() => respond.mutate('accepted')}
              >
                {respond.isPending ? tc('saving') : t('accept')}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <ErrorBanner error={respond.error} />
            <TextArea
              label={t('responseNote')}
              optional
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </Dialog>
      )}
      {dialog === 'execute' && (
        <Dialog
          open
          onClose={close}
          title={t('execute')}
          lead={t('executeLead')}
          footer={
            <>
              <Button onClick={close}>{tc('cancel')}</Button>
              <Button
                variant="primary"
                disabled={execute.isPending}
                onClick={() => execute.mutate(undefined)}
              >
                {execute.isPending ? tc('saving') : t('execute')}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <ErrorBanner error={execute.error} />
            <TextArea
              label={t('settlementNotes')}
              optional
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </Dialog>
      )}
    </Section>
  );
}
