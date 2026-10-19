'use client';

import {
  type AnalystAnswer,
  type AssistantMessageDto,
  type ContractDto,
  type ContractSummaryDto,
  type ConversationDto,
  EDITABLE_STATUSES,
  type EmailAnswer,
  type FormalMessageAnswer,
  type GeneralAnswer,
  type OfferAnswer,
  type OfferCost,
  type OfferTerms,
  type ProposalActionDto,
  sendProposedEmailSchema,
} from '@esports/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Mail, ShieldAlert } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { type ReactNode, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  ConfirmDialog,
  cx,
  SelectField,
  tableClass,
  tdClass,
  TextArea,
  TextField,
  thClass,
  useToast,
} from '@/components/ui';
import { api, apiPost } from '@/lib/api';
import { conversationKey, EMAIL_RE, splitAddresses } from '@/lib/assistants';
import { useContractLabels } from '@/lib/contracts';
import { useFinanceLabels, useMoney } from '@/lib/finance';
import { formatDateTime } from '@/lib/format';
import { useAction } from '@/lib/mutation';
import { useCan } from '@/lib/session';
import {
  ClaimsList,
  CopyButton,
  PlainText,
  SubHeading,
  TextList,
  useAnswerText,
} from './answer-parts';

// ------------------------------------------------------------------------------------------
// General Esports Assistant
// ------------------------------------------------------------------------------------------

export function GeneralView({
  m,
  a,
  onAsk,
}: {
  m: AssistantMessageDto;
  a: GeneralAnswer;
  onAsk?: (text: string) => void;
}) {
  const t = useTranslations('assistants');
  const tp = useAnswerText();
  return (
    <>
      <PlainText text={a.reply} />
      <ClaimsList claims={a.claims} messageId={m.id} />
      <TextList title={t('gaps')} items={a.gaps} />
      {a.followUps.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <SubHeading>{t('followUps')}</SubHeading>
          <div className="flex flex-wrap gap-2">
            {a.followUps.map((f) => (
              <button
                key={f}
                type="button"
                {...tp}
                onClick={() => onAsk?.(f)}
                disabled={!onAsk}
                className="rounded-full border border-line-strong bg-panel px-3 py-1 text-start text-sm hover:border-turf disabled:opacity-60"
              >
                {f}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------------------------------
// Formal Message Assistant: the finished message only
// ------------------------------------------------------------------------------------------

export function FormalView({ a }: { a: FormalMessageAnswer }) {
  const t = useTranslations('assistants');
  const tp = useAnswerText();
  return (
    <>
      <div
        {...tp}
        className="rounded-md border border-line bg-panel px-4 py-3 text-start whitespace-pre-wrap"
      >
        {a.message}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <CopyButton text={a.message} />
        <span className="text-[0.8125rem] text-muted">{t('formal.note')}</span>
      </div>
    </>
  );
}

// ------------------------------------------------------------------------------------------
// Email Assistant: editable proposal; sending is a separate, confirmed action
// ------------------------------------------------------------------------------------------

const addresses = (rs: { email: string | null }[]) =>
  rs
    .map((r) => r.email)
    .filter((e): e is string => !!e)
    .join(', ');

function ActionNote({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-md border border-turf/30 bg-turf-soft px-3 py-2 text-sm text-ink">
      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-turf" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

export function EmailProposal({
  m,
  a,
  conversationId,
  canSend,
  replyTo,
}: {
  m: AssistantMessageDto;
  a: EmailAnswer;
  conversationId: string;
  canSend: boolean;
  replyTo: string;
}) {
  const t = useTranslations('assistants.email');
  const locale = useLocale();
  const qc = useQueryClient();
  const toast = useToast();
  const initial = useMemo(
    () => ({ to: addresses(a.to), cc: addresses(a.cc), subject: a.subject, body: a.body }),
    [a],
  );
  const [form, setForm] = useState(initial);
  const [confirm, setConfirm] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const edited =
    form.to !== initial.to ||
    form.cc !== initial.cc ||
    form.subject !== initial.subject ||
    form.body !== initial.body;
  const to = splitAddresses(form.to);
  const cc = splitAddresses(form.cc);

  const send = useAction(
    () =>
      apiPost<ConversationDto>(`/assistants/messages/${m.id}/send-email`, {
        to: to.map((email) => ({ email })),
        cc: cc.map((email) => ({ email })),
        subject: form.subject,
        body: form.body,
      }),
    {
      invalidate: [],
      onSuccess: (conv) => {
        qc.setQueryData(conversationKey(conversationId), conv);
        setConfirm(false);
        toast(t('sent'));
      },
    },
  );

  const openConfirm = () => {
    const bad = [...to, ...cc].filter((e) => !EMAIL_RE.test(e));
    if (!to.length) return setProblem(t('needRecipient'));
    if (bad.length) return setProblem(t('invalid', { list: bad.join(', ') }));
    const parsed = sendProposedEmailSchema.safeParse({
      to: to.map((email) => ({ email })),
      cc: cc.map((email) => ({ email })),
      subject: form.subject,
      body: form.body,
    });
    if (!parsed.success) return setProblem(t('needContent'));
    setProblem(null);
    send.reset();
    setConfirm(true);
  };

  const mailto = `mailto:${to.join(',')}?${new URLSearchParams({
    ...(cc.length ? { cc: cc.join(',') } : {}),
    subject: form.subject,
    body: form.body,
  })
    .toString()
    .replace(/\+/g, '%20')}`;
  const plain = `${t('subject')}: ${form.subject}\n\n${form.body}`;
  const sent = m.actions.filter((x) => x.action === 'email_sent');

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label={t('to')}
          dir="ltr"
          value={form.to}
          hint={t('recipientsHint')}
          onChange={(e) => setForm({ ...form, to: e.target.value })}
        />
        <TextField
          label={t('cc')}
          optional
          dir="ltr"
          value={form.cc}
          onChange={(e) => setForm({ ...form, cc: e.target.value })}
        />
      </div>
      <TextField
        label={t('subject')}
        dir="auto"
        value={form.subject}
        onChange={(e) => setForm({ ...form, subject: e.target.value })}
      />
      <TextArea
        label={t('body')}
        dir="auto"
        rows={Math.min(18, Math.max(6, form.body.split('\n').length + 1))}
        value={form.body}
        onChange={(e) => setForm({ ...form, body: e.target.value })}
      />
      <TextList title={t('notes')} items={a.notes} />
      {problem && (
        <p role="alert" className="text-sm text-brick">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <CopyButton text={plain} />
        <a
          href={mailto}
          className="inline-flex h-8 items-center gap-2 rounded-md border border-line-strong bg-panel px-3 text-sm font-medium hover:bg-panel-2"
        >
          <Mail className="size-4" aria-hidden="true" />
          {t('openInMail')}
        </a>
        {canSend && (
          <Button size="sm" variant="primary" onClick={openConfirm}>
            {t('send')}
          </Button>
        )}
        {edited && <Badge>{t('edited')}</Badge>}
      </div>
      {!canSend && <p className="text-[0.8125rem] text-muted">{t('noSendPermission')}</p>}
      {sent.map((x) => (
        <ActionNote key={x.id}>
          {t('sentBy', {
            name: x.user.displayName,
            time: formatDateTime(x.createdAt, locale),
            recipients: [
              ...((x.detail.to as string[] | undefined) ?? []),
              ...((x.detail.cc as string[] | undefined) ?? []),
            ].join(', '),
          })}
        </ActionNote>
      ))}
      <ConfirmDialog
        open={confirm}
        title={t('confirmTitle')}
        body={t('confirmBody', { email: replyTo })}
        confirmLabel={t('confirm')}
        busy={send.isPending}
        error={send.error}
        onConfirm={() => send.mutate(undefined)}
        onClose={() => setConfirm(false)}
      >
        <dl className="flex flex-col gap-2 text-sm">
          <div>
            <dt className="font-medium">{t('recipients')}</dt>
            <dd dir="ltr" className="ltr-text text-start break-all text-muted">
              {[...to, ...cc.map((c) => `${c} (${t('cc')})`)].join(', ')}
            </dd>
          </div>
          <div>
            <dt className="font-medium">{t('subject')}</dt>
            <dd dir="auto" className="text-muted">
              {form.subject}
            </dd>
          </div>
        </dl>
      </ConfirmDialog>
    </div>
  );
}

// ------------------------------------------------------------------------------------------
// Offer Optimizer: alternatives with platform-computed costs; applying is a confirmed action
// ------------------------------------------------------------------------------------------

export function useTermsLines() {
  const t = useTranslations('assistants.offer.termsLine');
  const F = useFinanceLabels();
  const fmt = useMoney();
  const locale = useLocale();
  return (terms: OfferTerms): string[] => {
    const cur = terms.currency;
    const out: string[] = [];
    if (terms.salaryAmount)
      out.push(
        t('salary', {
          amount: fmt(terms.salaryAmount, cur),
          frequency: F.payFrequency[terms.frequency],
        }),
      );
    if (terms.durationMonths) out.push(t('duration', { months: terms.durationMonths }));
    if (terms.signingBonus) out.push(t('signing', { amount: fmt(terms.signingBonus, cur) }));
    for (const b of terms.bonuses)
      out.push(
        b.amount
          ? t('bonusAmount', { description: b.description, amount: fmt(b.amount, cur) })
          : t('bonus', { description: b.description }),
      );
    if (terms.revenueSharePercent)
      out.push(
        t('revenueShare', {
          percent: new Intl.NumberFormat(locale === 'ar' ? 'ar-u-nu-latn' : 'en-GB').format(
            Number(terms.revenueSharePercent),
          ),
        }),
      );
    if (terms.buyoutAmount) out.push(t('buyout', { amount: fmt(terms.buyoutAmount, cur) }));
    if (terms.otherTerms) out.push(terms.otherTerms);
    return out;
  };
}

export function useSignedMoney() {
  const fmt = useMoney();
  return (amount: string, currency: string) => {
    const neg = amount.startsWith('-');
    const abs = neg ? amount.slice(1) : amount;
    if (/^0(\.0+)?$/.test(abs)) return fmt(abs, currency);
    return `⁦${neg ? '−' : '+'}${fmt(abs, currency)}⁩`;
  };
}

function CostCell({ value, currency }: { value: string | null; currency: string }) {
  const t = useTranslations('assistants.offer');
  const fmt = useMoney();
  return value === null ? (
    <span className="text-muted">{t('notComputed')}</span>
  ) : (
    <span className="tabular-nums whitespace-nowrap">{fmt(value, currency)}</span>
  );
}

/** Rows of the cost comparison, all computed by the platform (shared/assistants/offer.ts). */
export function CostTable({ columns }: { columns: { label: string; cost: OfferCost }[] }) {
  const t = useTranslations('assistants.offer');
  const rows: {
    key: string;
    label: string;
    get: (c: OfferCost) => string | null;
    strong?: boolean;
  }[] = [
    { key: 'monthly', label: t('monthly'), get: (c) => c.monthly },
    { key: 'base', label: t('base'), get: (c) => c.base },
    { key: 'signing', label: t('signing'), get: (c) => c.signingBonus },
    { key: 'bonuses', label: t('bonusesMax'), get: (c) => c.bonusesMax },
    { key: 'total', label: t('total'), get: (c) => c.totalUpperBound, strong: true },
  ];
  const cell = 'border-b border-line px-3 py-2.5 align-top';
  return (
    <>
      {/* Phone: one card per option, so nothing has to scroll sideways. */}
      <ul className="flex flex-col gap-2 sm:hidden">
        {columns.map((c) => (
          <li key={c.label} className="rounded-md border border-line bg-panel px-3 py-2.5">
            <p className="text-sm font-semibold">{c.label}</p>
            <dl className="mt-1.5 flex flex-col gap-1 text-sm">
              {rows.map((r) => (
                <div key={r.key} className="flex items-baseline justify-between gap-3">
                  <dt className="text-muted">{r.label}</dt>
                  <dd className={cx('text-end', r.strong && 'font-semibold')}>
                    <CostCell value={r.get(c.cost)} currency={c.cost.currency} />
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto rounded-md border border-line sm:block">
        <table className={tableClass.replace('text-[0.9375rem]', 'text-sm')}>
          <thead>
            <tr>
              <th className={cx(thClass, 'px-3')}>
                <span className="sr-only">{t('term')}</span>
              </th>
              {columns.map((c) => (
                <th key={c.label} className={cx(thClass, 'px-3 text-end')} scope="col">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <th
                  scope="row"
                  className={cx(cell, 'text-start font-normal whitespace-nowrap text-muted')}
                >
                  {r.label}
                </th>
                {columns.map((c) => (
                  <td key={c.label} className={cx(cell, 'text-end', r.strong && 'font-semibold')}>
                    <CostCell value={r.get(c.cost)} currency={c.cost.currency} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function CostNotes({ costs }: { costs: OfferCost[] }) {
  const t = useTranslations('assistants.offer.costNotes');
  const notes = [...new Set(costs.flatMap((c) => c.notes))];
  if (!notes.length) return null;
  return (
    <ul className="flex list-disc flex-col gap-0.5 ps-5 text-[0.8125rem] text-muted">
      {notes.map((n) => (
        <li key={n}>{t(n)}</li>
      ))}
    </ul>
  );
}

const RISK_TONE = { low: 'turf', medium: 'amber', high: 'brick' } as const;

function ApplyOfferDialog({
  m,
  index,
  label,
  conversationId,
  defaultContractId,
  onClose,
}: {
  m: AssistantMessageDto;
  index: number;
  label: string;
  conversationId: string;
  defaultContractId: string | null;
  onClose: () => void;
}) {
  const t = useTranslations('assistants.offer');
  const C = useContractLabels();
  const drafts = useQuery({
    queryKey: ['contracts', 'list', 'assistant-drafts'],
    queryFn: () => api<ContractSummaryDto[]>('/contracts?view=drafts&limit=200'),
  });
  const options = (drafts.data ?? []).filter((c) => EDITABLE_STATUSES.includes(c.status));
  const [chosen, setChosen] = useState<string>('');
  const contractId =
    chosen || (options.some((o) => o.id === defaultContractId) ? defaultContractId! : '');
  const apply = useAction(
    () =>
      apiPost<ContractDto & { unchanged?: boolean }>(`/assistants/messages/${m.id}/apply-offer`, {
        alternative: index,
        contractId,
      }),
    {
      invalidate: [conversationKey(conversationId), ['contracts']],
      success: (r) =>
        r.unchanged
          ? t('unchanged', { number: r.number })
          : t('applied', { number: r.number, version: r.currentVersion }),
      onSuccess: onClose,
    },
  );
  return (
    <ConfirmDialog
      open
      title={t('applyTitle', { label })}
      body={t('applyLead')}
      confirmLabel={t('applyConfirm')}
      busy={apply.isPending}
      confirmDisabled={!contractId}
      error={apply.error}
      onConfirm={() => contractId && apply.mutate(undefined)}
      onClose={onClose}
    >
      {drafts.isLoading ? null : options.length === 0 ? (
        <p className="text-sm text-muted">{t('noDrafts')}</p>
      ) : (
        <SelectField
          label={t('contract')}
          value={contractId}
          onChange={(e) => setChosen(e.target.value)}
        >
          <option value="">{t('chooseContract')}</option>
          {options.map((c) => (
            <option key={c.id} value={c.id}>
              {c.number} · {c.title || c.typeNameEn}
              {c.recipientName ? ` · ${c.recipientName}` : ''} · {C.status[c.status]}
            </option>
          ))}
        </SelectField>
      )}
    </ConfirmDialog>
  );
}

function AppliedNote({ x }: { x: ProposalActionDto }) {
  const t = useTranslations('assistants.offer');
  const locale = useLocale();
  const d = x.detail as { contractId: string; number: string; version: number; label: string };
  return (
    <ActionNote>
      {t('appliedBy', {
        name: x.user.displayName,
        label: d.label,
        number: d.number,
        version: d.version,
        time: formatDateTime(x.createdAt, locale),
      })}{' '}
      <Link
        href={`/dashboard/contracts/${d.contractId}`}
        className="font-medium text-turf underline"
      >
        {t('openContract')}
      </Link>
    </ActionNote>
  );
}

export function OfferProposal({
  m,
  a,
  conversationId,
  context,
}: {
  m: AssistantMessageDto;
  a: OfferAnswer;
  conversationId: string;
  context: Record<string, unknown>;
}) {
  const t = useTranslations('assistants.offer');
  const ta = useTranslations('assistants');
  const can = useCan();
  const lines = useTermsLines();
  const signed = useSignedMoney();
  const tp = useAnswerText();
  const [applying, setApplying] = useState<number | null>(null);
  const canApply = can('contracts.create') || can('contracts.edit');
  const applied = m.actions.filter((x) => x.action === 'offer_applied');

  return (
    <div className="flex flex-col gap-5">
      <PlainText text={a.summary} />

      <div className="flex flex-col gap-2">
        <SubHeading>{t('costs')}</SubHeading>
        <CostTable
          columns={[
            { label: t('preferred'), cost: a.preferredCost },
            { label: t('requested'), cost: a.requestedCost },
            ...a.alternatives.map((alt, i) => ({
              label: `${t('alternative', { n: i + 1 })}`,
              cost: alt.cost,
            })),
          ]}
        />
        <p className="text-[0.8125rem] text-muted">{t('calcNote')}</p>
        <CostNotes costs={[a.preferredCost, a.requestedCost]} />
      </div>

      {a.differences.length > 0 && (
        <div className="flex flex-col gap-2">
          <SubHeading>{t('differences')}</SubHeading>
          <ul className="flex flex-col gap-2 sm:hidden">
            {a.differences.map((d, i) => (
              <li key={i} className="rounded-md border border-line bg-panel px-3 py-2.5 text-sm">
                <p dir="auto" className="text-start font-semibold">
                  {d.term}
                </p>
                <dl className="mt-1 flex flex-col gap-1">
                  <div>
                    <dt className="text-muted">{t('preferred')}</dt>
                    <dd dir="auto" className="text-start">
                      {d.preferred}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted">{t('requested')}</dt>
                    <dd dir="auto" className="text-start">
                      {d.requested}
                    </dd>
                  </div>
                  {d.note && (
                    <dd dir="auto" className="text-start text-muted">
                      {d.note}
                    </dd>
                  )}
                </dl>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto rounded-md border border-line sm:block">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th className={thClass}>{t('term')}</th>
                  <th className={thClass}>{t('preferred')}</th>
                  <th className={thClass}>{t('requested')}</th>
                  <th className={thClass}>{t('note')}</th>
                </tr>
              </thead>
              <tbody>
                {a.differences.map((d, i) => (
                  <tr key={i}>
                    <td dir="auto" className={cx(tdClass, 'font-medium')}>
                      {d.term}
                    </td>
                    <td dir="auto" className={tdClass}>
                      {d.preferred}
                    </td>
                    <td dir="auto" className={tdClass}>
                      {d.requested}
                    </td>
                    <td dir="auto" className={cx(tdClass, 'text-sm text-muted')}>
                      {d.note}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <TextList title={t('constraints')} items={a.constraints} />

      <div className="flex flex-col gap-3">
        <SubHeading>{t('alternatives')}</SubHeading>
        {a.alternatives.map((alt, i) => (
          <article
            key={i}
            className="flex flex-col gap-3 rounded-md border border-line bg-panel p-4"
          >
            <header className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="font-semibold">
                <span className="text-muted">{t('alternative', { n: i + 1 })} · </span>
                <span {...tp}>{alt.label}</span>
              </h4>
              <Badge tone={RISK_TONE[alt.risk]}>
                {t('risk', { level: t(`risks.${alt.risk}`) })}
              </Badge>
            </header>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {lines(alt.terms).map((l, j) => (
                <li key={j}>{l}</li>
              ))}
            </ul>
            <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-muted">{t('total')}</dt>
                <dd className="font-semibold">
                  <CostCell value={alt.cost.totalUpperBound} currency={alt.cost.currency} />
                </dd>
              </div>
              {alt.deltaVsPreferred !== null && (
                <div>
                  <dt className="text-muted">{t('vsPreferred')}</dt>
                  <dd className="tabular-nums">
                    {signed(alt.deltaVsPreferred, alt.cost.currency)}
                  </dd>
                </div>
              )}
              {alt.deltaVsRequested !== null && (
                <div>
                  <dt className="text-muted">{t('vsRequested')}</dt>
                  <dd className="tabular-nums">
                    {signed(alt.deltaVsRequested, alt.cost.currency)}
                  </dd>
                </div>
              )}
            </dl>
            <CostNotes costs={[alt.cost]} />
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              {(
                [
                  ['rationale', alt.rationale],
                  ['tradeoffs', alt.tradeoffs],
                  ['impact', alt.financialImpact],
                  ['riskExplanation', alt.riskExplanation],
                ] as const
              )
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <div key={k}>
                    <dt className="font-medium">{t(k)}</dt>
                    <dd {...tp} className="mt-0.5 text-start text-muted">
                      {v}
                    </dd>
                  </div>
                ))}
            </dl>
            {applied
              .filter((x) => x.detail.alternative === i)
              .map((x) => (
                <AppliedNote key={x.id} x={x} />
              ))}
            <div>
              {canApply ? (
                <Button size="sm" onClick={() => setApplying(i)}>
                  {t('apply')}
                </Button>
              ) : (
                <p className="text-[0.8125rem] text-muted">{t('cannotApply')}</p>
              )}
            </div>
          </article>
        ))}
      </div>

      {a.recommendation && (
        <div className="flex flex-col gap-1.5">
          <SubHeading>{t('recommendation')}</SubHeading>
          <PlainText text={a.recommendation} />
        </div>
      )}
      <ClaimsList claims={a.claims} messageId={m.id} />
      <TextList title={ta('gaps')} items={a.gaps} />
      {applying !== null && a.alternatives[applying] && (
        <ApplyOfferDialog
          m={m}
          index={applying}
          label={a.alternatives[applying]!.label}
          conversationId={conversationId}
          defaultContractId={typeof context.contractId === 'string' ? context.contractId : null}
          onClose={() => setApplying(null)}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------
// Player Investment Analyst: scenarios, never guarantees
// ------------------------------------------------------------------------------------------

export function ScenarioCaveat() {
  const t = useTranslations('assistants.analyst');
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

export function AnalystView({ m, a }: { m: AssistantMessageDto; a: AnalystAnswer }) {
  const t = useTranslations('assistants.analyst');
  const ta = useTranslations('assistants');
  return (
    <div className="flex flex-col gap-5">
      <ScenarioCaveat />
      <PlainText text={a.summary} />
      <dl className="grid gap-4 sm:grid-cols-2">
        {(['performance', 'cost', 'risk', 'potentialReturn'] as const)
          .filter((k) => a[k])
          .map((k) => (
            <div key={k} className="rounded-md border border-line bg-panel p-3">
              <dt className="text-sm font-semibold">{t(k)}</dt>
              <dd className="mt-1 text-sm">
                <PlainText text={a[k]} />
              </dd>
            </div>
          ))}
      </dl>
      {a.scenarios.length > 0 && (
        <div className="flex flex-col gap-2">
          <SubHeading>{t('scenarios')}</SubHeading>
          <div className="grid gap-3 lg:grid-cols-3">
            {a.scenarios.map((s) => (
              <article
                key={s.name}
                className="flex flex-col gap-2 rounded-md border border-line bg-panel p-3 text-sm"
              >
                <h4 className="font-semibold">{t(`scenarioNames.${s.name}`)}</h4>
                <PlainText text={s.narrative} />
                <dl className="flex flex-col gap-1">
                  {s.estimatedCost && (
                    <div>
                      <dt className="text-muted">{t('estimatedCost')}</dt>
                      <dd>
                        <PlainText text={s.estimatedCost} />
                      </dd>
                    </div>
                  )}
                  {s.potentialReturn && (
                    <div>
                      <dt className="text-muted">{t('potentialReturn')}</dt>
                      <dd>
                        <PlainText text={s.potentialReturn} />
                      </dd>
                    </div>
                  )}
                </dl>
                <TextList title={t('assumptions')} items={s.assumptions} />
                <TextList title={t('keyRisks')} items={s.keyRisks} />
              </article>
            ))}
          </div>
        </div>
      )}
      <ClaimsList claims={a.claims} messageId={m.id} />
      <TextList title={ta('gaps')} items={a.gaps} />
    </div>
  );
}
