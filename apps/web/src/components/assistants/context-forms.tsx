'use client';

import {
  type AssistantKey,
  type ContractOfferTermsDto,
  type ContractSummaryDto,
  CURRENCIES,
  EMAIL_TONES,
  offerCost,
  type OfferTerms,
  offerTermsSchema,
  PAY_FREQUENCIES,
  type PayFrequency,
  type RosterMemberDto,
  type TeamDto,
} from '@esports/shared';
import { useQuery } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Button, ErrorBanner, SelectField, TextArea, TextField } from '@/components/ui';
import { api } from '@/lib/api';
import { EMAIL_RE } from '@/lib/assistants';
import { useFinanceLabels } from '@/lib/finance';
import { useCan } from '@/lib/session';
import { CostNotes, CostTable } from './proposals';

// ------------------------------------------------------------------------------------------
// Form state (strings while editing) <-> stored context (validated by the API per assistant)
// ------------------------------------------------------------------------------------------

interface TermsForm {
  salaryAmount: string;
  currency: string;
  frequency: PayFrequency;
  durationMonths: string;
  signingBonus: string;
  bonuses: { description: string; amount: string }[];
  revenueSharePercent: string;
  buyoutAmount: string;
  otherTerms: string;
}

interface OfferForm {
  preferred: TermsForm;
  requested: TermsForm;
  contractId: string;
  counterparty: string;
  notes: string;
}
interface AnalystForm {
  teamId: string;
  rosterMemberId: string;
  profile: string;
  evidence: string;
}
interface EmailForm {
  recipientName: string;
  recipientEmail: string;
  recipientRole: string;
  gameOrTeam: string;
  purpose: string;
  tone: string;
}
interface FormalForm {
  recipient: string;
  sender: string;
  purpose: string;
}

export type ContextForm =
  | { assistant: 'general' }
  | { assistant: 'offer_optimizer'; offer: OfferForm }
  | { assistant: 'player_analyst'; analyst: AnalystForm }
  | { assistant: 'email'; email: EmailForm }
  | { assistant: 'formal_message'; formal: FormalForm };

const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const orNull = (s: string) => (s.trim() ? s.trim() : null);

function termsForm(v: unknown): TermsForm {
  const o = obj(v);
  const freq = str(o.frequency) as PayFrequency;
  return {
    salaryAmount: str(o.salaryAmount),
    currency: str(o.currency) || 'SAR',
    frequency: PAY_FREQUENCIES.includes(freq) ? freq : 'monthly',
    durationMonths: str(o.durationMonths),
    signingBonus: str(o.signingBonus),
    bonuses: Array.isArray(o.bonuses)
      ? o.bonuses.map((b) => ({ description: str(obj(b).description), amount: str(obj(b).amount) }))
      : [],
    revenueSharePercent: str(o.revenueSharePercent),
    buyoutAmount: str(o.buyoutAmount),
    otherTerms: str(o.otherTerms),
  };
}

function termsValue(f: TermsForm) {
  const months = f.durationMonths.trim();
  return {
    salaryAmount: orNull(f.salaryAmount),
    currency: f.currency,
    frequency: f.frequency,
    durationMonths: months ? (/^\d+$/.test(months) ? Number(months) : months) : null,
    signingBonus: orNull(f.signingBonus),
    bonuses: f.bonuses
      .filter((b) => b.description.trim() || b.amount.trim())
      .map((b) => ({ description: b.description.trim(), amount: orNull(b.amount) })),
    revenueSharePercent: orNull(f.revenueSharePercent),
    buyoutAmount: orNull(f.buyoutAmount),
    otherTerms: orNull(f.otherTerms),
  };
}

export function initialForm(
  assistant: AssistantKey,
  context?: Record<string, unknown>,
): ContextForm {
  const c = context ?? {};
  switch (assistant) {
    case 'offer_optimizer':
      return {
        assistant,
        offer: {
          preferred: termsForm(c.preferred),
          requested: termsForm(c.requested),
          contractId: str(c.contractId),
          counterparty: str(c.counterparty),
          notes: str(c.notes),
        },
      };
    case 'player_analyst':
      return {
        assistant,
        analyst: {
          teamId: '',
          rosterMemberId: str(c.rosterMemberId),
          profile: str(c.profile),
          evidence: str(c.evidence),
        },
      };
    case 'email':
      return {
        assistant,
        email: {
          recipientName: str(c.recipientName),
          recipientEmail: str(c.recipientEmail),
          recipientRole: str(c.recipientRole),
          gameOrTeam: str(c.gameOrTeam),
          purpose: str(c.purpose),
          tone: str(c.tone),
        },
      };
    case 'formal_message':
      return {
        assistant,
        formal: { recipient: str(c.recipient), sender: str(c.sender), purpose: str(c.purpose) },
      };
    default:
      return { assistant: 'general' };
  }
}

export function contextValue(form: ContextForm): Record<string, unknown> {
  switch (form.assistant) {
    case 'offer_optimizer':
      return {
        preferred: termsValue(form.offer.preferred),
        requested: termsValue(form.offer.requested),
        contractId: orNull(form.offer.contractId),
        counterparty: orNull(form.offer.counterparty),
        notes: orNull(form.offer.notes),
      };
    case 'player_analyst':
      return {
        rosterMemberId: orNull(form.analyst.rosterMemberId),
        profile: orNull(form.analyst.profile),
        evidence: orNull(form.analyst.evidence),
      };
    case 'email':
      return {
        recipientName: orNull(form.email.recipientName),
        recipientEmail: orNull(form.email.recipientEmail),
        recipientRole: orNull(form.email.recipientRole),
        gameOrTeam: orNull(form.email.gameOrTeam),
        purpose: orNull(form.email.purpose),
        tone: orNull(form.email.tone),
      };
    case 'formal_message':
      return {
        recipient: orNull(form.formal.recipient),
        sender: orNull(form.formal.sender),
        purpose: orNull(form.formal.purpose),
      };
    default:
      return {};
  }
}

/** The platform's own cost calculation, or null while the terms don't validate. */
function previewCost(f: TermsForm) {
  const parsed = offerTermsSchema.safeParse(termsValue(f));
  return parsed.success ? offerCost(parsed.data as OfferTerms) : null;
}

/** A message key when the form can't be saved yet, or null. */
export function contextProblem(form: ContextForm): string | null {
  if (form.assistant === 'offer_optimizer') {
    for (const side of [form.offer.preferred, form.offer.requested])
      if (!offerTermsSchema.safeParse(termsValue(side)).success) return 'invalidTerms';
  }
  if (form.assistant === 'email') {
    const e = form.email.recipientEmail.trim();
    if (e && !EMAIL_RE.test(e)) return 'invalidEmail';
  }
  return null;
}

// ------------------------------------------------------------------------------------------
// Fields
// ------------------------------------------------------------------------------------------

function TermsFields({
  legend,
  value,
  onChange,
}: {
  legend: string;
  value: TermsForm;
  onChange: (v: TermsForm) => void;
}) {
  const t = useTranslations('assistants.forms');
  const tc = useTranslations('common');
  const F = useFinanceLabels();
  const set = (patch: Partial<TermsForm>) => onChange({ ...value, ...patch });
  const amountProps = { inputMode: 'decimal' as const, dir: 'ltr' as const, optional: true };
  return (
    <fieldset className="flex min-w-0 flex-col gap-3 rounded-md border border-line p-4">
      <legend className="px-1 text-sm font-semibold">{legend}</legend>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_7rem]">
        <TextField
          label={t('salary')}
          {...amountProps}
          value={value.salaryAmount}
          onChange={(e) => set({ salaryAmount: e.target.value })}
        />
        <SelectField
          label={t('currency')}
          value={value.currency}
          onChange={(e) => set({ currency: e.target.value })}
        >
          {CURRENCIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.code}
            </option>
          ))}
        </SelectField>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          label={t('frequency')}
          value={value.frequency}
          onChange={(e) => set({ frequency: e.target.value as PayFrequency })}
        >
          {PAY_FREQUENCIES.map((f) => (
            <option key={f} value={f}>
              {F.payFrequency[f]}
            </option>
          ))}
        </SelectField>
        <TextField
          label={t('duration')}
          inputMode="numeric"
          dir="ltr"
          optional
          value={value.durationMonths}
          onChange={(e) => set({ durationMonths: e.target.value })}
        />
        <TextField
          label={t('signingBonus')}
          {...amountProps}
          value={value.signingBonus}
          onChange={(e) => set({ signingBonus: e.target.value })}
        />
        <TextField
          label={t('buyout')}
          {...amountProps}
          value={value.buyoutAmount}
          onChange={(e) => set({ buyoutAmount: e.target.value })}
        />
        <TextField
          label={t('revenueShare')}
          {...amountProps}
          value={value.revenueSharePercent}
          onChange={(e) => set({ revenueSharePercent: e.target.value })}
        />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">{t('bonuses')}</span>
        {value.bonuses.map((b, i) => (
          <div key={i} className="grid grid-cols-[minmax(0,1fr)_7rem_auto] items-end gap-2">
            <TextField
              label={t('bonusDescription')}
              value={b.description}
              onChange={(e) =>
                set({
                  bonuses: value.bonuses.map((x, j) =>
                    j === i ? { ...x, description: e.target.value } : x,
                  ),
                })
              }
            />
            <TextField
              label={t('bonusAmount')}
              inputMode="decimal"
              dir="ltr"
              value={b.amount}
              onChange={(e) =>
                set({
                  bonuses: value.bonuses.map((x, j) =>
                    j === i ? { ...x, amount: e.target.value } : x,
                  ),
                })
              }
            />
            <Button
              size="sm"
              variant="ghost"
              className="mb-1"
              aria-label={tc('remove')}
              onClick={() => set({ bonuses: value.bonuses.filter((_, j) => j !== i) })}
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </div>
        ))}
        {value.bonuses.length < 10 && (
          <div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => set({ bonuses: [...value.bonuses, { description: '', amount: '' }] })}
            >
              <Plus className="size-4" aria-hidden="true" />
              {t('addBonus')}
            </Button>
          </div>
        )}
      </div>
      <TextArea
        label={t('otherTerms')}
        optional
        dir="auto"
        rows={2}
        value={value.otherTerms}
        onChange={(e) => set({ otherTerms: e.target.value })}
      />
    </fieldset>
  );
}

function LoadFromContract({ onLoad }: { onLoad: (r: ContractOfferTermsDto) => void }) {
  const t = useTranslations('assistants.forms');
  const can = useCan();
  const visible = (
    ['contracts.view', 'contracts.create', 'contracts.edit', 'contracts.approve'] as const
  ).some(can);
  const list = useQuery({
    queryKey: ['contracts', 'list', 'assistant-all'],
    queryFn: () => api<ContractSummaryDto[]>('/contracts?limit=200'),
    enabled: visible,
  });
  const [error, setError] = useState<unknown>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  if (!visible || list.isError || !list.data?.length) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <SelectField
        label={t('loadFromContract')}
        optional
        value=""
        onChange={async (e) => {
          const id = e.target.value;
          if (!id) return;
          try {
            setError(null);
            const r = await api<ContractOfferTermsDto>(`/assistants/offer-terms/${id}`);
            onLoad(r);
            setLoaded(r.number);
          } catch (err) {
            setError(err);
          }
        }}
      >
        <option value="">—</option>
        {list.data.map((c) => (
          <option key={c.id} value={c.id}>
            {c.number} · {c.title || c.typeNameEn}
            {c.recipientName ? ` · ${c.recipientName}` : ''}
          </option>
        ))}
      </SelectField>
      {loaded && <p className="text-[0.8125rem] text-turf">{t('loaded', { number: loaded })}</p>}
      <ErrorBanner error={error} />
    </div>
  );
}

function OfferFields({ value, onChange }: { value: OfferForm; onChange: (v: OfferForm) => void }) {
  const t = useTranslations('assistants.forms');
  const to = useTranslations('assistants.offer');
  const preferred = previewCost(value.preferred);
  const requested = previewCost(value.requested);
  return (
    <div className="flex flex-col gap-4">
      <LoadFromContract
        onLoad={(r) =>
          onChange({ ...value, preferred: termsForm(r.terms), contractId: r.contractId })
        }
      />
      <div className="grid gap-4 xl:grid-cols-2">
        <TermsFields
          legend={to('preferred')}
          value={value.preferred}
          onChange={(preferred) => onChange({ ...value, preferred })}
        />
        <TermsFields
          legend={to('requested')}
          value={value.requested}
          onChange={(requested) => onChange({ ...value, requested })}
        />
      </div>
      {preferred && requested ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">{to('costs')}</p>
          <CostTable
            columns={[
              { label: to('preferred'), cost: preferred },
              { label: to('requested'), cost: requested },
            ]}
          />
          <CostNotes costs={[preferred, requested]} />
        </div>
      ) : (
        <p role="alert" className="text-sm text-brick">
          {t('invalidTerms')}
        </p>
      )}
      <TextField
        label={t('counterparty')}
        optional
        dir="auto"
        value={value.counterparty}
        onChange={(e) => onChange({ ...value, counterparty: e.target.value })}
      />
      <TextArea
        label={t('notes')}
        optional
        dir="auto"
        rows={3}
        value={value.notes}
        onChange={(e) => onChange({ ...value, notes: e.target.value })}
      />
    </div>
  );
}

function AnalystFields({
  value,
  onChange,
}: {
  value: AnalystForm;
  onChange: (v: AnalystForm) => void;
}) {
  const t = useTranslations('assistants.forms');
  const can = useCan();
  const canPick = can('teams.view') && (can('rosters.view') || can('finance.view'));
  const teams = useQuery({
    queryKey: ['teams'],
    queryFn: () => api<TeamDto[]>('/teams'),
    enabled: canPick,
  });
  // An existing pick: find its team so both selects show it.
  const member = useQuery({
    queryKey: ['roster-member', value.rosterMemberId],
    queryFn: () => api<RosterMemberDto>(`/roster-members/${value.rosterMemberId}`),
    enabled: canPick && !!value.rosterMemberId && !value.teamId,
  });
  useEffect(() => {
    if (member.data && !value.teamId) onChange({ ...value, teamId: member.data.teamId });
  }, [member.data, value, onChange]);
  const roster = useQuery({
    queryKey: ['roster', value.teamId],
    queryFn: () => api<RosterMemberDto[]>(`/teams/${value.teamId}/roster`),
    enabled: canPick && !!value.teamId,
  });
  const showPicker = canPick && !teams.isError && (teams.data?.length ?? 0) > 0;
  return (
    <div className="flex flex-col gap-4">
      {showPicker && (
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField
            label={t('team')}
            optional
            value={value.teamId}
            onChange={(e) => onChange({ ...value, teamId: e.target.value, rosterMemberId: '' })}
          >
            <option value="">—</option>
            {(teams.data ?? []).map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </SelectField>
          <SelectField
            label={t('member')}
            optional
            hint={t('memberHint')}
            value={value.rosterMemberId}
            disabled={!value.teamId || roster.isError}
            onChange={(e) => onChange({ ...value, rosterMemberId: e.target.value })}
          >
            <option value="">{t('noMember')}</option>
            {(roster.data ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.handle ? `${r.handle} · ` : ''}
                {r.fullName}
              </option>
            ))}
          </SelectField>
        </div>
      )}
      <TextArea
        label={t('profile')}
        optional
        hint={t('profileHint')}
        dir="auto"
        rows={4}
        value={value.profile}
        onChange={(e) => onChange({ ...value, profile: e.target.value })}
      />
      <TextArea
        label={t('evidence')}
        optional
        hint={t('evidenceHint')}
        dir="auto"
        rows={5}
        value={value.evidence}
        onChange={(e) => onChange({ ...value, evidence: e.target.value })}
      />
    </div>
  );
}

function EmailFields({ value, onChange }: { value: EmailForm; onChange: (v: EmailForm) => void }) {
  const t = useTranslations('assistants.forms');
  const tc = useTranslations('common');
  const set = (patch: Partial<EmailForm>) => onChange({ ...value, ...patch });
  const badEmail = !!value.recipientEmail.trim() && !EMAIL_RE.test(value.recipientEmail.trim());
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <TextField
        label={t('recipientName')}
        optional
        dir="auto"
        value={value.recipientName}
        onChange={(e) => set({ recipientName: e.target.value })}
      />
      <TextField
        label={t('recipientEmail')}
        optional
        type="email"
        dir="ltr"
        value={value.recipientEmail}
        error={badEmail ? tc('invalidEmail') : null}
        onChange={(e) => set({ recipientEmail: e.target.value })}
      />
      <TextField
        label={t('recipientRole')}
        optional
        dir="auto"
        value={value.recipientRole}
        onChange={(e) => set({ recipientRole: e.target.value })}
      />
      <TextField
        label={t('gameOrTeam')}
        optional
        dir="auto"
        value={value.gameOrTeam}
        onChange={(e) => set({ gameOrTeam: e.target.value })}
      />
      <SelectField
        label={t('tone')}
        value={value.tone}
        onChange={(e) => set({ tone: e.target.value })}
      >
        <option value="">{t('anyTone')}</option>
        {EMAIL_TONES.map((x) => (
          <option key={x} value={x}>
            {t(`tones.${x}`)}
          </option>
        ))}
      </SelectField>
      <div className="sm:col-span-2">
        <TextArea
          label={t('purpose')}
          optional
          dir="auto"
          rows={3}
          value={value.purpose}
          onChange={(e) => set({ purpose: e.target.value })}
        />
      </div>
    </div>
  );
}

function FormalFields({
  value,
  onChange,
}: {
  value: FormalForm;
  onChange: (v: FormalForm) => void;
}) {
  const t = useTranslations('assistants.forms');
  const set = (patch: Partial<FormalForm>) => onChange({ ...value, ...patch });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <TextField
        label={t('recipient')}
        optional
        dir="auto"
        value={value.recipient}
        onChange={(e) => set({ recipient: e.target.value })}
      />
      <TextField
        label={t('sender')}
        optional
        dir="auto"
        value={value.sender}
        onChange={(e) => set({ sender: e.target.value })}
      />
      <div className="sm:col-span-2">
        <TextArea
          label={t('purpose')}
          optional
          dir="auto"
          rows={3}
          value={value.purpose}
          onChange={(e) => set({ purpose: e.target.value })}
        />
      </div>
    </div>
  );
}

export const hasContextForm = (assistant: AssistantKey) => assistant !== 'general';

export function ContextFields({
  form,
  onChange,
}: {
  form: ContextForm;
  onChange: (f: ContextForm) => void;
}) {
  switch (form.assistant) {
    case 'offer_optimizer':
      return <OfferFields value={form.offer} onChange={(offer) => onChange({ ...form, offer })} />;
    case 'player_analyst':
      return (
        <AnalystFields
          value={form.analyst}
          onChange={(analyst) => onChange({ ...form, analyst })}
        />
      );
    case 'email':
      return <EmailFields value={form.email} onChange={(email) => onChange({ ...form, email })} />;
    case 'formal_message':
      return (
        <FormalFields value={form.formal} onChange={(formal) => onChange({ ...form, formal })} />
      );
    default:
      return null;
  }
}
