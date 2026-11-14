'use client';

import {
  type ApprovalRequestDto,
  type ContractDto,
  contractSaveSchema,
  type ContractSnapshot,
  DEFAULT_CONTRACT_TEXT_STYLE,
} from '@esports/shared';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  CheckCircle2,
  Download,
  FileCheck2,
  PenLine,
  Send,
  ShieldAlert,
  Undo2,
  XCircle,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { ClauseAssistantDialog } from '@/components/contracts/clause-assistant';
import { ClauseList, DetailsForm, type Draft } from '@/components/contracts/contract-forms';
import { ContractStatusBadge, DocumentFrame } from '@/components/contracts/contracts-nav';
import { SigningPanel } from '@/components/contracts/signing-panel';
import { TerminationPanel } from '@/components/contracts/termination-panel';
import {
  Badge,
  Button,
  ConfirmDialog,
  cx,
  Dialog,
  ErrorBanner,
  Section,
  SelectField,
  Spinner,
  TextArea,
} from '@/components/ui';
import { ApiError, apiPost, apiPut } from '@/lib/api';
import {
  downloadGet,
  fetchHtml,
  pick,
  useContract,
  useContractLabels,
  useContractLocale,
} from '@/lib/contracts';
import { formatDate, formatDateTime } from '@/lib/format';
import { useAction } from '@/lib/mutation';
import { useMe } from '@/lib/session';

type Tab = 'details' | 'clauses' | 'preview' | 'history' | 'signatures';
const TABS: Tab[] = ['details', 'clauses', 'preview', 'history', 'signatures'];
const SIGNING_STATUSES = ['approved', 'awaiting_signatures', 'signed'];

const toDraft = (s: ContractSnapshot): Draft => ({
  teamId: s.teamId,
  rosterMemberId: s.rosterMemberId,
  details: s.details,
  clauses: s.clauses,
  textStyle: s.textStyle ?? DEFAULT_CONTRACT_TEXT_STYLE,
});

function Banner({
  tone,
  icon,
  children,
}: {
  tone: 'amber' | 'brick' | 'turf' | 'neutral';
  icon?: ReactNode;
  children: ReactNode;
}) {
  const tones = {
    amber: 'border-amber/40 bg-amber-soft text-amber-ink',
    brick: 'border-brick/30 bg-brick-soft text-ink',
    turf: 'border-turf/30 bg-turf-soft text-ink',
    neutral: 'border-line bg-panel-2 text-ink',
  } as const;
  return (
    <div
      role="status"
      className={cx('flex gap-3 rounded-lg border px-4 py-3 text-sm', tones[tone])}
    >
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function StatusBanners({ c }: { c: ContractDto }) {
  const t = useTranslations('contracts.editor');
  const loc = useContractLocale();
  const pending = c.requests.find((r) => r.status === 'pending');
  const lastRejected = [...c.requests].reverse().find((r) => r.status === 'rejected');
  const approved = c.requests.find((r) => r.status === 'approved');
  return (
    <div className="flex flex-col gap-3">
      {c.status === 'pending_approval' && pending && (
        <Banner tone="amber" icon={<Send className="size-4" aria-hidden="true" />}>
          {t('pendingBanner', { date: formatDateTime(pending.requestedAt, loc) })}
          {pending.note && (
            <p dir="auto" className="mt-1 text-amber-ink/80">
              “{pending.note}”
            </p>
          )}
        </Banner>
      )}
      {c.status === 'changes_requested' && lastRejected && (
        <Banner tone="brick" icon={<XCircle className="size-4 text-brick" aria-hidden="true" />}>
          <p className="font-medium">
            {t('rejectedBanner', {
              name: lastRejected.decidedBy?.displayName ?? '',
              date: formatDateTime(lastRejected.decidedAt, loc),
            })}
          </p>
          <p dir="auto" className="mt-1 whitespace-pre-line">
            {lastRejected.comment}
          </p>
        </Banner>
      )}
      {c.status === 'awaiting_signatures' && (
        <Banner tone="amber" icon={<PenLine className="size-4" aria-hidden="true" />}>
          {t('awaitingBanner', { date: formatDate(c.updatedAt, loc) })}
        </Banner>
      )}
      {c.status === 'signed' && (
        <Banner tone="turf" icon={<PenLine className="size-4 text-turf" aria-hidden="true" />}>
          <p className="font-medium">{t('signedBanner', { date: formatDate(c.signedAt, loc) })}</p>
        </Banner>
      )}
      {SIGNING_STATUSES.includes(c.status) && approved && (
        <Banner tone="turf" icon={<CheckCircle2 className="size-4 text-turf" aria-hidden="true" />}>
          <p className="font-medium">
            {t('approvedBanner', {
              name: approved.decidedBy?.displayName ?? '',
              date: formatDate(approved.decidedAt, loc),
              version: approved.version,
            })}
          </p>
          {c.approvedDocument && (
            <p
              className={cx(
                'mt-1',
                c.approvedDocument.verified ? 'text-muted' : 'font-medium text-brick',
              )}
            >
              {c.approvedDocument.verified ? t('integrityOk') : t('integrityFailed')}
            </p>
          )}
        </Banner>
      )}
      {c.status === 'cancelled' && <Banner tone="neutral">{t('cancelledBanner')}</Banner>}
    </div>
  );
}

function MissingList({ c }: { c: ContractDto }) {
  const t = useTranslations('contracts.editor');
  const L = useContractLabels();
  const loc = useContractLocale();
  if (!c.missing.length || !c.can.edit) return null;
  const label = (m: string) => {
    const clause = /^clause_text_(ar|en):(.+)$/.exec(m);
    if (clause) {
      const cl = c.snapshot.clauses.find((x) => x.id === clause[2]);
      return t('clauseTextMissing', {
        title: cl ? pick(cl.titleEn, cl.titleAr, loc) : '',
        language: L.language[clause[1] as 'ar' | 'en'],
      });
    }
    return (L.field as Record<string, string>)[m] ?? L.requirement[m] ?? m;
  };
  return (
    <Banner tone="amber" icon={<ShieldAlert className="size-4" aria-hidden="true" />}>
      <p className="font-medium">{t('missingTitle')}</p>
      <p className="text-amber-ink/80">{t('missingLead')}</p>
      <ul className="mt-1.5 list-disc ps-5">
        {c.missing.map((m) => (
          <li key={m}>{label(m)}</li>
        ))}
      </ul>
    </Banner>
  );
}

function PreviewTab({
  c,
  version,
  setVersion,
  dirty,
}: {
  c: ContractDto;
  version: number;
  setVersion: (v: number) => void;
  dirty: boolean;
}) {
  const t = useTranslations('contracts.preview');
  const te = useTranslations('contracts.editor');
  const th = useTranslations('contracts.history');
  const html = useQuery({
    queryKey: ['contracts', 'preview', c.id, version],
    queryFn: () => fetchHtml(`/contracts/${c.id}/preview?version=${version}`),
  });
  const [err, setErr] = useState<unknown>(null);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">{dirty ? t('unsaved') : t('lead')}</p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-40">
            <SelectField
              label={t('version')}
              value={String(version)}
              onChange={(e) => setVersion(Number(e.target.value))}
            >
              {[...c.versions].reverse().map((v) => (
                <option key={v.version} value={v.version}>
                  {th('version', { version: v.version })}
                </option>
              ))}
            </SelectField>
          </div>
          {c.can.export && (
            <Button
              onClick={() => {
                setErr(null);
                downloadGet(`/contracts/${c.id}/document.pdf?version=${version}`).catch(setErr);
              }}
            >
              <Download className="size-4" aria-hidden="true" />
              {te('downloadPdf')}
            </Button>
          )}
        </div>
      </div>
      <ErrorBanner error={err ?? html.error} />
      {html.isLoading ? <Spinner /> : <DocumentFrame html={html.data} title={t('frameTitle')} />}
    </div>
  );
}

function RequestItem({ r }: { r: ApprovalRequestDto }) {
  const t = useTranslations('contracts.history');
  const L = useContractLabels();
  const loc = useContractLocale();
  const tone =
    r.status === 'approved'
      ? 'turf'
      : r.status === 'rejected'
        ? 'brick'
        : r.status === 'pending'
          ? 'amber'
          : 'neutral';
  return (
    <li className="flex flex-col gap-1.5 px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={tone}>{L.requestStatus[r.status]}</Badge>
        <span className="font-medium">{t('version', { version: r.version })}</span>
        {r.selfApproved && <Badge>{t('selfApproved')}</Badge>}
      </div>
      <p className="text-sm text-muted">
        {t('requested', { name: r.requestedBy.displayName })} · {formatDateTime(r.requestedAt, loc)}
      </p>
      {r.note && (
        <p className="text-sm">
          <span className="text-muted">{t('note')}: </span>
          <bdi>{r.note}</bdi>
        </p>
      )}
      {r.decidedBy && r.decidedAt && r.status !== 'pending' && (
        <p className="text-sm text-muted">
          {t('decided', { status: L.requestStatus[r.status], name: r.decidedBy.displayName })} ·{' '}
          {formatDateTime(r.decidedAt, loc)}
        </p>
      )}
      {r.comment && (
        <p dir="auto" className="rounded-md bg-panel-2 px-3 py-2 text-sm whitespace-pre-line">
          {r.comment}
        </p>
      )}
      {r.documentSha256 && (
        <p className="text-[0.8125rem] text-muted">
          {t('documentHash')}:{' '}
          <code dir="ltr" className="break-all">
            {r.documentSha256}
          </code>
        </p>
      )}
    </li>
  );
}

function HistoryTab({ c, onPreview }: { c: ContractDto; onPreview: (v: number) => void }) {
  const t = useTranslations('contracts.history');
  const loc = useContractLocale();
  const [err, setErr] = useState<unknown>(null);
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Section title={t('versions')}>
        <ErrorBanner error={err} />
        <ol className="divide-y divide-line">
          {[...c.versions].reverse().map((v) => (
            <li key={v.version} className="flex flex-col gap-1.5 px-5 py-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{t('version', { version: v.version })}</span>
                {v.version === c.currentVersion && <Badge tone="turf">{t('current')}</Badge>}
                <Badge tone={v.verified ? 'neutral' : 'brick'}>
                  {v.verified ? t('verified') : t('tampered')}
                </Badge>
              </div>
              <p className="text-sm text-muted">
                {v.createdBy?.displayName ?? '—'} · {formatDateTime(v.createdAt, loc)}
              </p>
              {v.note && (
                <p dir="auto" className="text-sm">
                  {v.note}
                </p>
              )}
              <p className="text-[0.8125rem] text-muted">
                {t('fingerprint')}:{' '}
                <code dir="ltr" className="break-all">
                  {v.sha256.slice(0, 16)}…
                </code>
              </p>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => onPreview(v.version)}>
                  {t('view')}
                </Button>
                {c.can.export && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      downloadGet(`/contracts/${c.id}/document.pdf?version=${v.version}`).catch(
                        setErr,
                      )
                    }
                  >
                    <Download className="size-4" aria-hidden="true" />
                    {t('pdf')}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ol>
      </Section>
      <Section title={t('requests')}>
        {c.requests.length ? (
          <ol className="divide-y divide-line">
            {[...c.requests].reverse().map((r) => (
              <RequestItem key={r.id} r={r} />
            ))}
          </ol>
        ) : (
          <p className="px-5 py-6 text-sm text-muted">{t('noRequests')}</p>
        )}
      </Section>
    </div>
  );
}

function Editor({ c }: { c: ContractDto }) {
  const t = useTranslations('contracts.editor');
  const tc = useTranslations('common');
  const tContracts = useTranslations('contracts');
  const td = useTranslations('contracts.details');
  const loc = useContractLocale();
  const me = useMe();
  const saved = useMemo(() => toDraft(c.snapshot), [c.snapshot]);
  const [draft, setDraft] = useState<Draft>(saved);
  const signable = SIGNING_STATUSES.includes(c.status);
  const tabs = TABS.filter((k) => k !== 'signatures' || signable);
  // Drafts open on the form; contracts out for signature (or signed) on the signatures; the rest
  // on the document. A notification link can ask for a tab (?tab=signatures).
  const [tab, setTab] = useState<Tab>(() => {
    const asked = new URLSearchParams(window.location.search).get('tab') as Tab | null;
    if (asked && tabs.includes(asked)) return asked;
    if (c.can.edit) return 'details';
    return c.status === 'awaiting_signatures' || c.status === 'signed' ? 'signatures' : 'preview';
  });
  const [previewVersion, setPreviewVersion] = useState(c.currentVersion);
  const [dialog, setDialog] = useState<
    null | 'submit' | 'withdraw' | 'cancel' | 'approve' | 'reject' | 'assistant'
  >(null);
  const [note, setNote] = useState('');
  const [invalid, setInvalid] = useState<Set<string>>(new Set());
  const [dlError, setDlError] = useState<unknown>(null);
  const [textStyleValid, setTextStyleValid] = useState(true);
  // A new saved version (or status) replaces local edits; background refetches of the same
  // version don't, so unsaved work is never overwritten.
  useEffect(() => {
    setDraft(toDraft(c.snapshot));
    setPreviewVersion(c.currentVersion);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.currentVersion, c.status]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const editable = c.can.edit;
  const invalidate = [['contracts']];
  const pending = c.requests.find((r) => r.status === 'pending');

  const save = useAction(
    () => {
      const body = { ...draft, note: note.trim() || null };
      const parsed = contractSaveSchema.safeParse(body);
      if (!parsed.success) {
        setInvalid(new Set(parsed.error.issues.map((i) => String(i.path.at(-1) ?? ''))));
        return Promise.reject(new ApiError(400, 'validation_failed', 'Validation failed'));
      }
      setInvalid(new Set());
      return apiPut<ContractDto & { unchanged?: boolean }>(`/contracts/${c.id}`, parsed.data);
    },
    {
      invalidate,
      success: (r) => (r.unchanged ? t('unchanged') : t('saved', { version: r.currentVersion })),
      onSuccess: () => setNote(''),
    },
  );
  const submit = useAction(
    () => apiPost(`/contracts/${c.id}/submit`, { note: note.trim() || null }),
    {
      invalidate,
      success: t('submitted'),
      onSuccess: () => {
        setDialog(null);
        setNote('');
      },
    },
  );
  const withdraw = useAction(() => apiPost(`/contracts/${c.id}/withdraw`), {
    invalidate,
    success: t('withdrawn'),
    onSuccess: () => setDialog(null),
  });
  const cancel = useAction(() => apiPost(`/contracts/${c.id}/cancel`), {
    invalidate,
    success: t('cancelled'),
    onSuccess: () => setDialog(null),
  });
  const approve = useAction(
    () => apiPost(`/contracts/${c.id}/approve`, { comment: note.trim() || null }),
    {
      invalidate,
      success: t('approved'),
      onSuccess: () => {
        setDialog(null);
        setNote('');
      },
    },
  );
  const reject = useAction(() => apiPost(`/contracts/${c.id}/reject`, { reason: note.trim() }), {
    invalidate,
    success: t('rejected'),
    onSuccess: () => {
      setDialog(null);
      setNote('');
    },
  });

  const title = c.title || pick(c.typeNameEn, c.typeNameAr, loc);
  const excluded = c.snapshot.clauses.filter((x) => !x.included).length;
  const close = () => {
    setDialog(null);
    setNote('');
  };

  return (
    <>
      <Link
        href="/dashboard/contracts"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"
      >
        <ArrowLeft className="size-4 rtl:-scale-x-100" aria-hidden="true" />
        {t('back')}
      </Link>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm text-muted">
            <span className="ltr-text">{c.number}</span> ·{' '}
            {tContracts('versionShort', { version: c.currentVersion })}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-muted">
            <ContractStatusBadge status={c.status} />
            <span>
              {[c.title ? pick(c.typeNameEn, c.typeNameAr, loc) : null, c.teamName, c.recipientName]
                .filter(Boolean)
                .join(' · ')}
            </span>
            {dirty && <Badge tone="amber">{t('unsaved')}</Badge>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {editable && (
            <Button
              variant={dirty ? 'primary' : 'secondary'}
              disabled={!dirty || save.isPending || !textStyleValid}
              onClick={() => save.mutate(undefined)}
            >
              {save.isPending ? tc('saving') : t('save')}
            </Button>
          )}
          {c.can.submit && (
            <Button
              variant={dirty ? 'secondary' : 'primary'}
              disabled={dirty}
              title={dirty ? t('saveFirst') : undefined}
              onClick={() => setDialog('submit')}
            >
              <Send className="size-4 rtl:-scale-x-100" aria-hidden="true" />
              {t('submit')}
            </Button>
          )}
          {c.can.decide && (
            <>
              <Button variant="primary" onClick={() => setDialog('approve')}>
                <FileCheck2 className="size-4" aria-hidden="true" />
                {t('approve')}
              </Button>
              <Button onClick={() => setDialog('reject')}>{t('reject')}</Button>
            </>
          )}
          {c.can.withdraw && (
            <Button onClick={() => setDialog('withdraw')}>
              <Undo2 className="size-4" aria-hidden="true" />
              {t('withdraw')}
            </Button>
          )}
          {c.approvedDocument && c.can.export && (
            <Button
              variant={c.status === 'signed' ? 'secondary' : 'primary'}
              onClick={() => {
                setDlError(null);
                downloadGet(`/contracts/${c.id}/approved.pdf`).catch(setDlError);
              }}
            >
              <Download className="size-4" aria-hidden="true" />
              {t('downloadApproved')}
            </Button>
          )}
          {c.status === 'signed' && c.can.export && (
            <Button
              variant="primary"
              onClick={() => {
                setDlError(null);
                downloadGet(`/contracts/${c.id}/signed.pdf`).catch(setDlError);
              }}
            >
              <Download className="size-4" aria-hidden="true" />
              {t('downloadSigned')}
            </Button>
          )}
          {c.can.cancel && (
            <Button variant="ghost" onClick={() => setDialog('cancel')}>
              {t('cancelContract')}
            </Button>
          )}
        </div>
      </header>

      <div className="mb-5 flex flex-col gap-3">
        <ErrorBanner error={save.error ?? dlError} />
        {save.error && invalid.size > 0 && (
          <p className="text-sm text-brick">
            {td('invalid', { fields: [...invalid].filter(Boolean).join(', ') })}
          </p>
        )}
        <StatusBanners c={c} />
        <MissingList c={c} />
        {!editable && (c.status === 'draft' || c.status === 'changes_requested') && (
          <Banner tone="neutral">{t('readOnly')}</Banner>
        )}
      </div>
      <div className="mb-5">
        <TerminationPanel c={c} />
      </div>

      <div
        role="tablist"
        aria-label={title}
        className="mb-5 flex gap-1 overflow-x-auto border-b border-line"
      >
        {tabs.map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => {
              if (k === 'preview') setPreviewVersion(c.currentVersion);
              setTab(k);
            }}
            className={cx(
              '-mb-px inline-flex h-10 items-center border-b-2 px-3 text-[0.9375rem] whitespace-nowrap',
              tab === k
                ? 'border-turf font-medium text-ink'
                : 'border-transparent text-muted hover:text-ink',
            )}
          >
            {t(`tabs.${k}`)}
            {k === 'clauses' && (
              <span className="ms-1.5 text-[0.8125rem] text-muted">
                {draft.clauses.filter((x) => x.included).length}
              </span>
            )}
          </button>
        ))}
      </div>

      {tab === 'details' && (
        <DetailsForm
          draft={draft}
          setDraft={setDraft}
          disabled={!editable}
          invalid={invalid}
          onTextStyleValidityChange={setTextStyleValid}
        />
      )}
      {tab === 'clauses' && (
        <ClauseList
          clauses={draft.clauses}
          onChange={(clauses) => setDraft((d) => ({ ...d, clauses }))}
          disabled={!editable}
          modifiedIds={c.modifiedClauseIds}
          onAssistant={editable ? () => setDialog('assistant') : undefined}
        />
      )}
      {tab === 'preview' && (
        <PreviewTab c={c} version={previewVersion} setVersion={setPreviewVersion} dirty={dirty} />
      )}
      {tab === 'signatures' && <SigningPanel c={c} />}
      {tab === 'history' && (
        <HistoryTab
          c={c}
          onPreview={(v) => {
            setPreviewVersion(v);
            setTab('preview');
          }}
        />
      )}

      {dialog === 'submit' && (
        <Dialog
          open
          onClose={close}
          title={t('submit')}
          lead={t('submitLead')}
          footer={
            <>
              <Button onClick={close}>{tc('cancel')}</Button>
              <Button
                variant="primary"
                disabled={submit.isPending}
                onClick={() => submit.mutate(undefined)}
              >
                {submit.isPending ? tc('saving') : t('submit')}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <ErrorBanner error={submit.error} />
            <TextArea
              label={t('submitNote')}
              optional
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </Dialog>
      )}
      {dialog === 'approve' && pending && (
        <Dialog
          open
          onClose={close}
          title={t('approveTitle', { number: c.number })}
          lead={t('approveLead', { version: pending.version })}
          footer={
            <>
              <Button onClick={close}>{tc('cancel')}</Button>
              <Button
                variant="primary"
                disabled={approve.isPending}
                onClick={() => approve.mutate(undefined)}
              >
                {approve.isPending ? tc('saving') : t('approve')}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <ErrorBanner error={approve.error} />
            {pending.requestedBy.id === me.user.id && (
              <Banner tone="amber">{t('selfApprovalNote')}</Banner>
            )}
            {!!c.modifiedClauseIds.length && (
              <Banner tone="amber">
                {t('modifiedNote', { count: c.modifiedClauseIds.length })}
              </Banner>
            )}
            {!!excluded && (
              <p className="text-sm text-muted">{t('excludedNote', { count: excluded })}</p>
            )}
            <TextArea
              label={t('approveComment')}
              optional
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </Dialog>
      )}
      {dialog === 'reject' && (
        <Dialog
          open
          onClose={close}
          title={t('rejectTitle', { number: c.number })}
          lead={t('rejectLead')}
          footer={
            <>
              <Button onClick={close}>{tc('cancel')}</Button>
              <Button
                variant="danger"
                disabled={note.trim().length < 3 || reject.isPending}
                onClick={() => reject.mutate(undefined)}
              >
                {reject.isPending ? tc('saving') : t('reject')}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <ErrorBanner error={reject.error} />
            <TextArea
              label={t('rejectReason')}
              hint={t('reasonRequired')}
              required
              rows={4}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              autoFocus
            />
          </div>
        </Dialog>
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
      <ConfirmDialog
        open={dialog === 'cancel'}
        title={t('cancelContract')}
        body={t('cancelLead')}
        confirmLabel={t('cancelContract')}
        danger
        busy={cancel.isPending}
        error={cancel.error}
        onConfirm={() => cancel.mutate(undefined)}
        onClose={close}
      />
      {dialog === 'assistant' && (
        <ClauseAssistantDialog contract={c} dirty={dirty} onClose={close} />
      )}
    </>
  );
}

export default function ContractPage() {
  const { id } = useParams<{ id: string }>();
  const t = useTranslations('contracts.editor');
  const contract = useContract(id);
  if (contract.isLoading) return <Spinner />;
  if (contract.error || !contract.data)
    return (
      <div className="flex flex-col items-start gap-4">
        <ErrorBanner error={contract.error} />
        <Link
          href="/dashboard/contracts"
          className="inline-flex items-center gap-1.5 text-sm text-turf hover:underline"
        >
          <ArrowLeft className="size-4 rtl:-scale-x-100" aria-hidden="true" />
          {t('back')}
        </Link>
      </div>
    );
  return <Editor key={contract.data.id} c={contract.data} />;
}
