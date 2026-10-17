'use client';

import {
  CERTAINTIES,
  convertToBase,
  EXPENSE_CATEGORIES,
  expenseInputSchema,
  type LedgerEntryDto,
  money,
  OWNERSHIP_TYPES,
  type RateQuoteDto,
  RECURRENCES,
  REVENUE_CATEGORIES,
  revenueInputSchema,
  type RosterMemberDto,
  sum,
} from '@esports/shared';
import { useQuery } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorBanner,
  PageHeader,
  Section,
  SelectField,
  Spinner,
  TextArea,
  TextField,
  tableClass,
  tdClass,
  thClass,
  thEndClass,
} from '@/components/ui';
import { api, ApiError, apiDelete, apiPatch, apiPost } from '@/lib/api';
import {
  formatDay,
  orNull,
  todayIso,
  useFinanceLabels,
  useFinanceLocale,
  useFinanceScopes,
  useFinanceSettings,
  useMoney,
  useSeasons,
  useTournaments,
} from '@/lib/finance';
import { invalidFields } from '@/lib/form';
import { useAction } from '@/lib/mutation';
import { useCan, useCovers } from '@/lib/session';
import { FinanceNav } from './finance-nav';
import { CurrencyLabel, Money } from './money';

type Kind = 'expense' | 'revenue';
const PATH: Record<Kind, string> = { expense: '/finance/expenses', revenue: '/finance/revenue' };

interface TeamOption {
  id: string;
  name: string;
  departmentId: string | null;
}

interface FormState {
  level: 'organization' | 'team' | 'player';
  teamId: string;
  rosterMemberId: string;
  tournamentId: string;
  seasonId: string;
  category: string;
  date: string;
  amount: string;
  currency: string;
  rate: string;
  recurrence: string;
  ownership: string;
  counterparty: string;
  realized: boolean;
  certainty: string;
  taxAmount: string;
  taxJurisdiction: string;
  description: string;
}

function initialForm(
  kind: Kind,
  entry: LedgerEntryDto | null,
  base: string,
  teams: TeamOption[],
  orgAllowed: boolean,
): FormState {
  if (entry) {
    return {
      level: entry.rosterMemberId ? 'player' : entry.teamId ? 'team' : 'organization',
      teamId: entry.teamId ?? '',
      rosterMemberId: entry.rosterMemberId ?? '',
      tournamentId: entry.tournamentId ?? '',
      seasonId: '',
      category: entry.category,
      date: entry.date,
      amount: entry.amount,
      currency: entry.currency,
      rate: '',
      recurrence: entry.recurrence,
      ownership: entry.ownership ?? '',
      counterparty: entry.counterparty ?? '',
      realized: entry.realized,
      certainty: entry.certainty ?? 'certain',
      taxAmount: entry.taxAmount ?? '',
      taxJurisdiction: entry.taxJurisdiction ?? '',
      description: entry.description ?? '',
    };
  }
  return {
    level: orgAllowed && !teams.length ? 'organization' : teams.length ? 'team' : 'organization',
    teamId: teams[0]?.id ?? '',
    rosterMemberId: '',
    tournamentId: '',
    seasonId: '',
    category: kind === 'expense' ? 'equipment_operational' : 'sponsorship_fixed',
    date: todayIso(),
    amount: '',
    currency: base,
    rate: '',
    recurrence: 'one_time',
    ownership: '',
    counterparty: '',
    realized: true,
    certainty: 'certain',
    taxAmount: '',
    taxJurisdiction: '',
    description: '',
  };
}

function EntryDialog({
  kind,
  entry,
  onClose,
}: {
  kind: Kind;
  entry: LedgerEntryDto | null;
  onClose: () => void;
}) {
  const t = useTranslations('finance');
  const tc = useTranslations('common');
  const te = useTranslations('errors');
  const fl = useFinanceLocale();
  const L = useFinanceLabels();
  const fmt = useMoney();
  const covers = useCovers();
  const can = useCan();
  const settings = useFinanceSettings();
  const scopes = useFinanceScopes();
  const seasons = useSeasons();
  const tournaments = useTournaments();
  const base = settings.data?.baseCurrency ?? 'USD';
  const perm = entry ? 'finance.edit' : 'finance.create';

  const teams: TeamOption[] = (scopes.data ?? [])
    .filter((s) => s.kind === 'team' && s.id)
    .map((s) => ({ id: s.id!, name: s.name, departmentId: s.departmentId ?? null }))
    .filter((tm) => covers.team(perm, tm) || tm.id === entry?.teamId);
  const orgAllowed = covers.department(perm, null) || (entry !== null && entry.teamId === null);

  const [form, setForm] = useState<FormState>(() =>
    initialForm(kind, entry, base, teams, orgAllowed),
  );
  const [touched, setTouched] = useState(false);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const roster = useQuery({
    queryKey: ['roster', form.teamId],
    queryFn: () => api<RosterMemberDto[]>(`/teams/${form.teamId}/roster`),
    enabled: form.level === 'player' && !!form.teamId,
  });

  // Keep the stored rate when editing and neither currency nor date changed (as the API does).
  const keepsStoredRate =
    !!entry && entry.currency === form.currency && entry.date === form.date && !form.rate;
  const needsRate = form.currency !== base && !keepsStoredRate && !form.rate;
  const quote = useQuery({
    queryKey: ['finance', 'rate', form.currency, form.date],
    queryFn: () => api<RateQuoteDto>(`/finance/rates?currency=${form.currency}&date=${form.date}`),
    enabled: needsRate && /^\d{4}-\d{2}-\d{2}$/.test(form.date),
  });
  const effectiveRate =
    form.currency === base
      ? '1'
      : form.rate || (keepsStoredRate ? entry!.rate : (quote.data?.rate ?? null));
  const preview = (() => {
    try {
      return effectiveRate && form.amount ? convertToBase(form.amount, effectiveRate, base) : null;
    } catch {
      return null;
    }
  })();

  const body = () => ({
    teamId: form.level === 'organization' ? null : form.teamId || null,
    rosterMemberId: form.level === 'player' ? form.rosterMemberId || null : null,
    tournamentId: form.tournamentId || null,
    seasonId: form.seasonId || null,
    description: orNull(form.description),
    date: form.date,
    amount: form.amount.trim(),
    currency: form.currency,
    rate: orNull(form.rate),
    recurrence: form.recurrence,
    taxAmount: orNull(form.taxAmount),
    taxJurisdiction: orNull(form.taxJurisdiction),
    category: form.category,
    ...(kind === 'expense'
      ? { ownership: form.ownership || null }
      : {
          counterparty: orNull(form.counterparty),
          realized: form.realized,
          certainty: form.certainty,
        }),
  });
  const invalid = invalidFields(
    kind === 'expense' ? expenseInputSchema : revenueInputSchema,
    body(),
  );
  const missingPlayer = form.level === 'player' && !form.rosterMemberId;
  const missingTeam = form.level !== 'organization' && !form.teamId;

  const save = useAction(
    () =>
      entry
        ? apiPatch<LedgerEntryDto>(`${PATH[kind]}/${entry.id}`, body())
        : apiPost<LedgerEntryDto>(PATH[kind], body()),
    {
      invalidate: [['finance']],
      success: entry ? t('ledger.saved') : t('ledger.created'),
      onSuccess: onClose,
    },
  );
  const rateError = save.error instanceof ApiError && save.error.code === 'fx_rate_required';
  const categories = kind === 'expense' ? EXPENSE_CATEGORIES : REVENUE_CATEGORIES;
  const enabled = settings.data?.enabledCurrencies ?? [base];
  const currencyOptions = enabled.includes(form.currency) ? enabled : [...enabled, form.currency];

  const submit = () => {
    setTouched(true);
    if (invalid.size || missingPlayer || missingTeam) return;
    save.mutate(undefined);
  };
  const err = (field: string, message: string) => (touched && invalid.has(field) ? message : null);

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={entry ? t(`ledger.${kind}.edit`) : t(`ledger.${kind}.new`)}
      footer={
        <>
          <Button onClick={onClose}>{tc('cancel')}</Button>
          <Button variant="primary" disabled={save.isPending} onClick={submit}>
            {save.isPending ? tc('saving') : entry ? tc('saveChanges') : tc('create')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {save.error && !rateError ? <ErrorBanner error={save.error} /> : null}

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-medium">{t('ledger.level')}</legend>
          <div className="flex flex-wrap gap-2" role="radiogroup">
            {(['organization', 'team', 'player'] as const).map((lv) => {
              const disabled = lv === 'organization' ? !orgAllowed : !teams.length;
              return (
                <label
                  key={lv}
                  className={`inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm ${form.level === lv ? 'border-turf bg-turf-soft' : 'border-line-strong'} ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
                >
                  <input
                    type="radio"
                    name="level"
                    className="accent-[var(--turf)]"
                    checked={form.level === lv}
                    disabled={disabled}
                    onChange={() => set('level', lv)}
                  />
                  {t(`level.${lv}`)}
                </label>
              );
            })}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {form.level !== 'organization' && (
              <SelectField
                label={t('ledger.team')}
                value={form.teamId}
                onChange={(e) =>
                  setForm((f) => ({ ...f, teamId: e.target.value, rosterMemberId: '' }))
                }
              >
                {teams.map((tm) => (
                  <option key={tm.id} value={tm.id}>
                    {tm.name}
                  </option>
                ))}
              </SelectField>
            )}
            {form.level === 'player' && (
              <SelectField
                label={t('ledger.player')}
                value={form.rosterMemberId}
                onChange={(e) => set('rosterMemberId', e.target.value)}
              >
                <option value="">
                  {roster.isLoading ? tc('loading') : t('ledger.choosePlayer')}
                </option>
                {(roster.data ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.fullName}
                    {m.handle ? ` (${m.handle})` : ''}
                  </option>
                ))}
              </SelectField>
            )}
          </div>
          {touched && (missingPlayer || missingTeam) && (
            <p className="text-[0.8125rem] text-brick" role="alert">
              {missingTeam ? t('ledger.chooseTeam') : t('ledger.choosePlayer')}
            </p>
          )}
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label={t('ledger.category')}
            value={form.category}
            onChange={(e) => set('category', e.target.value)}
          >
            {categories.map((c) => (
              <option key={c} value={c}>
                {L.category[c] ?? c}
              </option>
            ))}
          </SelectField>
          <TextField
            label={
              kind === 'revenue' && !form.realized ? t('ledger.expectedDate') : t('ledger.date')
            }
            type="date"
            value={form.date}
            onChange={(e) => set('date', e.target.value)}
            error={err('date', tc('required'))}
          />
          <TextField
            label={t('ledger.amount')}
            inputMode="decimal"
            className="ltr-text"
            value={form.amount}
            onChange={(e) => set('amount', e.target.value.replace(',', '.'))}
            error={err('amount', t('ledger.amountInvalid'))}
            hint={t('ledger.amountHint')}
          />
          <SelectField
            label={t('ledger.currency')}
            value={form.currency}
            onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value, rate: '' }))}
          >
            {currencyOptions.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </SelectField>
        </div>

        {form.currency !== base && (
          <div className="rounded-md border border-line bg-panel-2 p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label={t('ledger.rate', { from: form.currency, to: base })}
                optional
                inputMode="decimal"
                className="ltr-text"
                value={form.rate}
                placeholder={effectiveRate && !form.rate ? effectiveRate.replace(/\.?0+$/, '') : ''}
                onChange={(e) => set('rate', e.target.value.replace(',', '.'))}
                error={rateError ? te('fx_rate_required') : err('rate', t('ledger.rateInvalid'))}
              />
              <div className="flex flex-col justify-end gap-1 text-sm">
                <span className="text-muted">{t('ledger.inBase', { currency: base })}</span>
                <span className="text-lg font-semibold">{preview ? fmt(preview, base) : '—'}</span>
              </div>
            </div>
            <p className="mt-3 text-[0.8125rem] text-muted">
              {form.rate
                ? t('ledger.rateManual')
                : keepsStoredRate
                  ? t('ledger.rateStored', {
                      date: entry?.rateDate ? formatDay(entry.rateDate, fl) : '—',
                    })
                  : quote.isLoading
                    ? tc('loading')
                    : quote.data?.rate
                      ? t('ledger.rateProvider', {
                          date: formatDay(quote.data.rateDate ?? form.date, fl),
                          source: settings.data?.fxAttribution?.text ?? '',
                        })
                      : t('ledger.rateMissing')}
            </p>
          </div>
        )}

        {kind === 'revenue' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-3">
              <Checkbox
                label={t('ledger.realized')}
                hint={t('ledger.realizedHint')}
                checked={form.realized}
                onChange={(e) => set('realized', e.target.checked)}
              />
            </div>
            <SelectField
              label={t('ledger.certainty')}
              value={form.certainty}
              onChange={(e) => set('certainty', e.target.value)}
            >
              {CERTAINTIES.map((c) => (
                <option key={c} value={c}>
                  {L.certainty[c]}
                </option>
              ))}
            </SelectField>
            <TextField
              label={t('ledger.counterparty')}
              optional
              value={form.counterparty}
              onChange={(e) => set('counterparty', e.target.value)}
            />
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label={t('ledger.recurrence')}
            value={form.recurrence}
            onChange={(e) => set('recurrence', e.target.value)}
          >
            {RECURRENCES.map((r) => (
              <option key={r} value={r}>
                {L.recurrence[r]}
              </option>
            ))}
          </SelectField>
          {kind === 'expense' && (
            <SelectField
              label={t('ledger.ownership')}
              optional
              value={form.ownership}
              onChange={(e) => set('ownership', e.target.value)}
            >
              <option value="">{tc('none')}</option>
              {OWNERSHIP_TYPES.map((o) => (
                <option key={o} value={o}>
                  {L.ownership[o]}
                </option>
              ))}
            </SelectField>
          )}
          {can('tournaments.view') && (
            <SelectField
              label={t('ledger.tournament')}
              optional
              value={form.tournamentId}
              onChange={(e) => set('tournamentId', e.target.value)}
            >
              <option value="">{tc('none')}</option>
              {(tournaments.data ?? []).map((tr) => (
                <option key={tr.id} value={tr.id}>
                  {tr.name}
                </option>
              ))}
            </SelectField>
          )}
          <SelectField
            label={t('ledger.season')}
            value={form.seasonId}
            onChange={(e) => set('seasonId', e.target.value)}
            hint={t('ledger.seasonHint')}
          >
            <option value="">{t('ledger.seasonAuto')}</option>
            {(seasons.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </SelectField>
        </div>

        <TextArea
          label={t('ledger.description')}
          optional
          value={form.description}
          onChange={(e) => set('description', e.target.value)}
        />

        <details className="rounded-md border border-line px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium">{t('ledger.taxSection')}</summary>
          <p className="mt-2 text-[0.8125rem] text-muted">{t('ledger.taxNotice')}</p>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <TextField
              label={t('ledger.taxAmount', { currency: form.currency })}
              optional
              inputMode="decimal"
              className="ltr-text"
              value={form.taxAmount}
              onChange={(e) => set('taxAmount', e.target.value.replace(',', '.'))}
              error={err('taxAmount', t('ledger.amountInvalid'))}
            />
            <TextField
              label={t('ledger.taxJurisdiction')}
              optional
              value={form.taxJurisdiction}
              onChange={(e) => set('taxJurisdiction', e.target.value)}
            />
          </div>
        </details>
      </div>
    </Dialog>
  );
}

export function LedgerPage({ kind }: { kind: Kind }) {
  const t = useTranslations('finance');
  const tc = useTranslations('common');
  const fl = useFinanceLocale();
  const L = useFinanceLabels();
  const can = useCan();
  const covers = useCovers();
  const settings = useFinanceSettings();
  const scopes = useFinanceScopes();
  const base = settings.data?.baseCurrency ?? 'USD';

  const [teamFilter, setTeamFilter] = useState('');
  const [category, setCategory] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [editing, setEditing] = useState<LedgerEntryDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<LedgerEntryDto | null>(null);

  const qs = new URLSearchParams();
  if (teamFilter) qs.set('teamId', teamFilter);
  if (category) qs.set('category', category);
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  qs.set('limit', '500');
  const list = useQuery({
    queryKey: ['finance', kind, teamFilter, category, from, to],
    queryFn: () => api<LedgerEntryDto[]>(`${PATH[kind]}?${qs.toString()}`),
    enabled: can('finance.view'),
    placeholderData: (prev) => prev,
  });
  const remove = useAction((id: string) => apiDelete(`${PATH[kind]}/${id}`), {
    invalidate: [['finance']],
    success: t('ledger.deleted'),
    onSuccess: () => setDeleting(null),
  });

  const rows = useMemo(() => list.data ?? [], [list.data]);
  const totals = useMemo(() => {
    const realized = rows.filter((r) => r.realized).map((r) => r.baseAmount);
    const expected = rows.filter((r) => !r.realized).map((r) => r.baseAmount);
    return {
      realized: money(sum(realized), base),
      expected: money(sum(expected), base),
      expectedCount: expected.length,
    };
  }, [rows, base]);

  const teams = (scopes.data ?? []).filter((s) => s.kind === 'team');
  const categories = kind === 'expense' ? EXPENSE_CATEGORIES : REVENUE_CATEGORIES;
  const teamRef = (e: LedgerEntryDto) =>
    e.teamId
      ? { id: e.teamId, departmentId: teams.find((x) => x.id === e.teamId)?.departmentId ?? null }
      : null;
  const allowed = (perm: 'finance.edit' | 'finance.delete', e: LedgerEntryDto) => {
    const ref = teamRef(e);
    return ref ? covers.team(perm, ref) : covers.department(perm, null);
  };

  return (
    <>
      <PageHeader
        title={t('title')}
        lead={t(`ledger.${kind}.lead`)}
        actions={
          can('finance.create') ? (
            <Button variant="primary" onClick={() => setEditing('new')}>
              <Plus className="size-4" aria-hidden="true" />
              {t(`ledger.${kind}.new`)}
            </Button>
          ) : undefined
        }
      />
      <FinanceNav />

      {can('finance.view') ? (
        <Section
          title={t(`ledger.${kind}.title`)}
          actions={
            <div className="flex flex-wrap items-end gap-2 text-sm">
              <label className="flex flex-col gap-1">
                <span className="text-muted">{t('ledger.team')}</span>
                <select
                  value={teamFilter}
                  onChange={(e) => setTeamFilter(e.target.value)}
                  className="h-8 rounded-md border border-line-strong bg-panel px-2"
                >
                  <option value="">{t('ledger.allLevels')}</option>
                  {covers.department('finance.view', null) && (
                    <option value="none">{t('level.organization')}</option>
                  )}
                  {teams.map((tm) => (
                    <option key={tm.id} value={tm.id!}>
                      {tm.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-muted">{t('ledger.category')}</span>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="h-8 max-w-[14rem] rounded-md border border-line-strong bg-panel px-2"
                >
                  <option value="">{t('ledger.allCategories')}</option>
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {L.category[c] ?? c}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-muted">{t('report.from')}</span>
                <input
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  className="h-8 rounded-md border border-line-strong bg-panel px-2"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-muted">{t('report.to')}</span>
                <input
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  className="h-8 rounded-md border border-line-strong bg-panel px-2"
                />
              </label>
            </div>
          }
        >
          {list.isLoading ? (
            <Spinner />
          ) : list.error ? (
            <div className="p-5">
              <ErrorBanner error={list.error} />
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              title={t(`ledger.${kind}.empty`)}
              lead={can('finance.create') ? t(`ledger.${kind}.emptyLead`) : undefined}
            />
          ) : (
            <div className={list.isFetching ? 'opacity-70' : ''}>
              {/* Phone: one card per record. */}
              <ul className="divide-y divide-line sm:hidden">
                {rows.map((e) => (
                  <li key={e.id} className="flex flex-col gap-1.5 px-5 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium">{L.category[e.category] ?? e.category}</p>
                        <p className="text-sm text-muted">
                          {[
                            formatDay(e.date, fl),
                            e.teamName ?? t('level.organization'),
                            e.rosterMemberName,
                            e.tournamentName,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                        {e.description && <p className="text-sm">{e.description}</p>}
                      </div>
                      <div className="text-end">
                        <Money
                          amount={e.baseAmount}
                          currency={e.baseCurrency}
                          className="font-semibold"
                        />
                        {e.currency !== e.baseCurrency && (
                          <span className="block text-[0.8125rem] text-muted">
                            <Money amount={e.amount} currency={e.currency} />
                          </span>
                        )}
                        {kind === 'revenue' && (
                          <span className="mt-1 block">
                            <Badge tone={e.realized ? 'turf' : 'amber'}>
                              {e.realized ? t('ledger.received') : t('ledger.expected')}
                            </Badge>
                          </span>
                        )}
                      </div>
                    </div>
                    {(allowed('finance.edit', e) || allowed('finance.delete', e)) && (
                      <div className="-ms-2 flex gap-1">
                        {allowed('finance.edit', e) && (
                          <Button size="sm" variant="ghost" onClick={() => setEditing(e)}>
                            <Pencil className="size-4" aria-hidden="true" />
                            {tc('edit')}
                          </Button>
                        )}
                        {allowed('finance.delete', e) && (
                          <Button size="sm" variant="ghost" onClick={() => setDeleting(e)}>
                            <Trash2 className="size-4" aria-hidden="true" />
                            {tc('delete')}
                          </Button>
                        )}
                      </div>
                    )}
                  </li>
                ))}
                <li className="flex items-baseline justify-between gap-3 px-5 py-3 font-medium">
                  <span>
                    {kind === 'revenue' ? t('ledger.totalReceived') : t('ledger.totalShown')}
                  </span>
                  <Money amount={totals.realized} currency={base} className="font-semibold" />
                </li>
                {kind === 'revenue' && totals.expectedCount > 0 && (
                  <li className="flex items-baseline justify-between gap-3 px-5 py-3 text-muted">
                    <span>{t('ledger.totalExpected')}</span>
                    <Money amount={totals.expected} currency={base} />
                  </li>
                )}
              </ul>
              <div className="relative hidden overflow-x-auto sm:block">
                <table className={tableClass}>
                  <thead>
                    <tr>
                      <th className={thClass}>{t('ledger.date')}</th>
                      <th className={thClass}>{t('ledger.category')}</th>
                      <th className={thClass}>{t('ledger.levelCol')}</th>
                      <th className={thClass}>{t('ledger.description')}</th>
                      <th className={thEndClass}>{t('ledger.original')}</th>
                      <th className={thEndClass}>{t('ledger.inBase', { currency: base })}</th>
                      {kind === 'revenue' && <th className={thClass}>{tc('status')}</th>}
                      <th className={thClass}>
                        <span className="sr-only">{tc('actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((e) => (
                      <tr key={e.id}>
                        <td className={`${tdClass} whitespace-nowrap`}>{formatDay(e.date, fl)}</td>
                        <td className={tdClass}>{L.category[e.category] ?? e.category}</td>
                        <td className={tdClass}>
                          {e.teamName ?? (
                            <span className="text-muted">{t('level.organization')}</span>
                          )}
                          {e.rosterMemberName && (
                            <span className="block text-sm text-muted">{e.rosterMemberName}</span>
                          )}
                          {e.tournamentName && (
                            <span className="block text-sm text-muted">{e.tournamentName}</span>
                          )}
                        </td>
                        <td className={`${tdClass} max-w-[16rem]`}>
                          {e.description}
                          {e.taxAmount && (
                            <span className="block text-[0.8125rem] text-muted">
                              {t('ledger.taxRecorded')}:{' '}
                              <Money amount={e.taxAmount} currency={e.currency} />
                            </span>
                          )}
                        </td>
                        <td className={`${tdClass} text-end`}>
                          <Money amount={e.amount} currency={e.currency} />
                          {e.currency !== e.baseCurrency && (
                            <span
                              className="block text-[0.8125rem] text-muted"
                              title={t(`rateSource.${e.rateSource}`)}
                            >
                              <span className="ltr-text">× {e.rate.replace(/\.?0+$/, '')}</span>
                              {e.rateSource === 'manual' ? ` · ${t('rateSource.manual')}` : ''}
                            </span>
                          )}
                        </td>
                        <td className={`${tdClass} text-end font-medium`}>
                          <Money amount={e.baseAmount} currency={e.baseCurrency} />
                        </td>
                        {kind === 'revenue' && (
                          <td className={tdClass}>
                            <Badge tone={e.realized ? 'turf' : 'amber'}>
                              {e.realized ? t('ledger.received') : t('ledger.expected')}
                            </Badge>
                            {!e.realized && e.certainty && (
                              <span className="mt-1 block text-[0.8125rem] text-muted">
                                {L.certainty[e.certainty]}
                              </span>
                            )}
                          </td>
                        )}
                        <td className={`${tdClass} text-end whitespace-nowrap`}>
                          {allowed('finance.edit', e) && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setEditing(e)}
                              aria-label={`${tc('edit')} ${L.category[e.category] ?? e.category}`}
                            >
                              <Pencil className="size-4" aria-hidden="true" />
                            </Button>
                          )}
                          {allowed('finance.delete', e) && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setDeleting(e)}
                              aria-label={`${tc('delete')} ${L.category[e.category] ?? e.category}`}
                            >
                              <Trash2 className="size-4" aria-hidden="true" />
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td className={`${tdClass} font-medium`} colSpan={5}>
                        {kind === 'revenue' ? t('ledger.totalReceived') : t('ledger.totalShown')}
                      </td>
                      <td className={`${tdClass} text-end font-semibold`}>
                        <Money amount={totals.realized} currency={base} />
                      </td>
                      <td className={tdClass} colSpan={kind === 'revenue' ? 2 : 1} />
                    </tr>
                    {kind === 'revenue' && totals.expectedCount > 0 && (
                      <tr>
                        <td className={`${tdClass} text-muted`} colSpan={5}>
                          {t('ledger.totalExpected')}
                        </td>
                        <td className={`${tdClass} text-end text-muted`}>
                          <Money amount={totals.expected} currency={base} />
                        </td>
                        <td className={tdClass} colSpan={2} />
                      </tr>
                    )}
                  </tfoot>
                </table>
              </div>
            </div>
          )}
        </Section>
      ) : (
        <p className="text-muted">{t('ledger.createOnly')}</p>
      )}
      {settings.data && (
        <p className="mt-4 flex flex-wrap items-center gap-2 text-sm text-muted">
          {t('ledger.reportingCurrency')}: <CurrencyLabel code={base} withName />
        </p>
      )}

      {editing && (
        <EntryDialog
          kind={kind}
          entry={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        title={t(`ledger.${kind}.delete`)}
        body={t('ledger.deleteConfirm')}
        confirmLabel={tc('delete')}
        danger
        busy={remove.isPending}
        error={remove.error}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        onClose={() => {
          setDeleting(null);
          remove.reset();
        }}
      />
    </>
  );
}
