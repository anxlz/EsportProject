'use client';

import {
  budgetInputSchema,
  type BudgetDto,
  type BudgetVarianceLine,
  EXPENSE_CATEGORIES,
} from '@esports/shared';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Meter } from '@/components/finance/charts';
import { FinanceNav } from '@/components/finance/finance-nav';
import { Money } from '@/components/finance/money';
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorBanner,
  PageHeader,
  SelectField,
  Spinner,
  TextArea,
  TextField,
} from '@/components/ui';
import { api, apiDelete, apiPatch, apiPost } from '@/lib/api';
import {
  formatDay,
  orNull,
  useFinanceLabels,
  useFinanceLocale,
  useFinanceScopes,
  useFinanceSettings,
  useSeasons,
  useTournaments,
} from '@/lib/finance';
import { invalidFields } from '@/lib/form';
import { useAction } from '@/lib/mutation';
import { useCan, useCovers } from '@/lib/session';

interface Form {
  name: string;
  teamId: string;
  tournamentId: string;
  seasonId: string;
  periodStart: string;
  periodEnd: string;
  total: string;
  notes: string;
  lines: { category: string; amount: string }[];
}

function BudgetDialog({ budget, onClose }: { budget: BudgetDto | null; onClose: () => void }) {
  const t = useTranslations('finance.budgets');
  const tc = useTranslations('common');
  const L = useFinanceLabels();
  const covers = useCovers();
  const can = useCan();
  const scopes = useFinanceScopes();
  const seasons = useSeasons();
  const tournaments = useTournaments();
  const settings = useFinanceSettings();
  const teams = (scopes.data ?? [])
    .filter((s) => s.kind === 'team' && s.id)
    .filter(
      (s) =>
        covers.team('budgets.manage', { id: s.id!, departmentId: s.departmentId ?? null }) ||
        s.id === budget?.teamId,
    );
  const orgAllowed = covers.department('budgets.manage', null);
  const [form, setForm] = useState<Form>(() => ({
    name: budget?.name ?? '',
    teamId: budget?.teamId ?? (orgAllowed ? '' : (teams[0]?.id ?? '')),
    tournamentId: budget?.tournamentId ?? '',
    seasonId: budget?.seasonId ?? '',
    periodStart: budget?.periodStart ?? '',
    periodEnd: budget?.periodEnd ?? '',
    total: budget ? budget.variance.total.planned : '',
    notes: budget?.notes ?? '',
    lines: budget
      ? budget.variance.lines.map((l) => ({ category: l.category!, amount: l.planned }))
      : [],
  }));
  const [touched, setTouched] = useState(false);
  const body = () => ({
    name: form.name.trim(),
    teamId: form.teamId || null,
    tournamentId: form.tournamentId || null,
    seasonId: form.seasonId || null,
    periodStart: form.periodStart || null,
    periodEnd: form.periodEnd || null,
    total: form.total.trim(),
    notes: orNull(form.notes),
    lines: form.lines
      .filter((l) => l.amount.trim())
      .map((l) => ({ category: l.category, amount: l.amount.trim() })),
  });
  const invalid = invalidFields(budgetInputSchema, body());
  const save = useAction(
    () =>
      budget
        ? apiPatch(`/finance/budgets/${budget.id}`, body())
        : apiPost('/finance/budgets', body()),
    {
      invalidate: [['finance', 'budgets']],
      success: budget ? t('saved') : t('created'),
      onSuccess: onClose,
    },
  );
  const set = (k: keyof Form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const unused = EXPENSE_CATEGORIES.filter((c) => !form.lines.some((l) => l.category === c));
  const base = settings.data?.baseCurrency ?? '';

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={budget ? t('edit') : t('new')}
      footer={
        <>
          <Button onClick={onClose}>{tc('cancel')}</Button>
          <Button
            variant="primary"
            disabled={save.isPending}
            onClick={() => {
              setTouched(true);
              if (!invalid.size) save.mutate(undefined);
            }}
          >
            {save.isPending ? tc('saving') : budget ? tc('saveChanges') : tc('create')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <ErrorBanner error={save.error} />
        <TextField
          label={tc('name')}
          value={form.name}
          onChange={set('name')}
          autoFocus
          error={touched && invalid.has('name') ? tc('required') : null}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label={t('team')}
            value={form.teamId}
            onChange={set('teamId')}
            hint={t('teamHint')}
          >
            {orgAllowed && <option value="">{t('wholeOrganization')}</option>}
            {teams.map((tm) => (
              <option key={tm.id} value={tm.id!}>
                {tm.name}
              </option>
            ))}
          </SelectField>
          <TextField
            label={t('total', { currency: base })}
            inputMode="decimal"
            className="ltr-text"
            value={form.total}
            onChange={(e) => setForm((f) => ({ ...f, total: e.target.value.replace(',', '.') }))}
            error={touched && invalid.has('total') ? t('amountInvalid') : null}
          />
          {can('tournaments.view') && (
            <SelectField
              label={t('tournament')}
              optional
              value={form.tournamentId}
              onChange={set('tournamentId')}
            >
              <option value="">{tc('none')}</option>
              {(tournaments.data ?? []).map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </SelectField>
          )}
          <SelectField
            label={t('season')}
            optional
            value={form.seasonId}
            onChange={set('seasonId')}
          >
            <option value="">{tc('none')}</option>
            {(seasons.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </SelectField>
          <TextField
            label={t('periodStart')}
            optional
            type="date"
            value={form.periodStart}
            onChange={set('periodStart')}
          />
          <TextField
            label={t('periodEnd')}
            optional
            type="date"
            value={form.periodEnd}
            onChange={set('periodEnd')}
            error={touched && invalid.has('') ? t('datesInvalid') : null}
          />
        </div>

        <fieldset className="flex flex-col gap-3">
          <legend className="text-sm font-medium">{t('lines')}</legend>
          <p className="text-[0.8125rem] text-muted">{t('linesHint')}</p>
          {form.lines.map((l, i) => (
            <div key={l.category} className="flex items-end gap-2">
              <div className="flex-1">
                <TextField
                  label={L.category[l.category] ?? l.category}
                  inputMode="decimal"
                  className="ltr-text"
                  value={l.amount}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      lines: f.lines.map((x, j) =>
                        j === i ? { ...x, amount: e.target.value.replace(',', '.') } : x,
                      ),
                    }))
                  }
                />
              </div>
              <Button
                variant="ghost"
                aria-label={`${tc('remove')} ${L.category[l.category] ?? l.category}`}
                onClick={() => setForm((f) => ({ ...f, lines: f.lines.filter((_, j) => j !== i) }))}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </div>
          ))}
          {unused.length > 0 && (
            <label className="flex max-w-sm flex-col gap-1 text-sm">
              <span className="text-muted">{t('addLine')}</span>
              <select
                value=""
                onChange={(e) =>
                  e.target.value &&
                  setForm((f) => ({
                    ...f,
                    lines: [...f.lines, { category: e.target.value, amount: '' }],
                  }))
                }
                className="h-10 rounded-md border border-line-strong bg-panel px-2"
              >
                <option value="">{t('chooseCategory')}</option>
                {unused.map((c) => (
                  <option key={c} value={c}>
                    {L.category[c]}
                  </option>
                ))}
              </select>
            </label>
          )}
        </fieldset>
        <TextArea label={t('notes')} optional value={form.notes} onChange={set('notes')} />
      </div>
    </Dialog>
  );
}

function VarianceRow({
  line,
  label,
  currency,
}: {
  line: BudgetVarianceLine;
  label: string;
  currency: string;
}) {
  const t = useTranslations('finance.budgets');
  const pct = Number(line.usedPercent);
  return (
    <Meter percent={pct} label={`${label}: ${line.usedPercent}%`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
        <span className="flex items-center gap-1.5">
          {line.over ? (
            <AlertTriangle className="size-4 text-brick" aria-hidden="true" />
          ) : (
            <CheckCircle2 className="size-4 text-turf" aria-hidden="true" />
          )}
          <span className={line.category ? '' : 'font-medium'}>{label}</span>
          {line.over && <span className="text-brick">{t('over')}</span>}
        </span>
        <span className="text-muted">
          <Money amount={line.actual} currency={currency} className="font-medium text-ink" /> /{' '}
          <Money amount={line.planned} currency={currency} />
          <span className="ms-2 tabular-nums">{line.usedPercent}%</span>
          <span className="ms-2">
            {line.over ? t('overBy') : t('remaining')}{' '}
            <Money amount={line.variance.replace(/^-/, '')} currency={currency} />
          </span>
        </span>
      </div>
    </Meter>
  );
}

export default function BudgetsPage() {
  const t = useTranslations('finance.budgets');
  const tf = useTranslations('finance');
  const tc = useTranslations('common');
  const L = useFinanceLabels();
  const fl = useFinanceLocale();
  const can = useCan();
  const covers = useCovers();
  const scopes = useFinanceScopes();
  const [editing, setEditing] = useState<BudgetDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<BudgetDto | null>(null);
  const list = useQuery({
    queryKey: ['finance', 'budgets'],
    queryFn: () => api<BudgetDto[]>('/finance/budgets'),
    enabled: can('finance.view'),
  });
  const remove = useAction((id: string) => apiDelete(`/finance/budgets/${id}`), {
    invalidate: [['finance', 'budgets']],
    success: t('deleted'),
    onSuccess: () => setDeleting(null),
  });
  const manageable = (b: BudgetDto) => {
    if (!b.teamId) return covers.department('budgets.manage', null);
    const s = scopes.data?.find((x) => x.id === b.teamId);
    return covers.team('budgets.manage', { id: b.teamId, departmentId: s?.departmentId ?? null });
  };
  const budgets = list.data ?? [];

  return (
    <>
      <PageHeader
        title={tf('title')}
        lead={t('lead')}
        actions={
          can('budgets.manage') ? (
            <Button variant="primary" onClick={() => setEditing('new')}>
              <Plus className="size-4" aria-hidden="true" />
              {t('new')}
            </Button>
          ) : undefined
        }
      />
      <FinanceNav />
      {list.isLoading ? (
        <Spinner />
      ) : list.error ? (
        <ErrorBanner error={list.error} />
      ) : !budgets.length ? (
        <div className="rounded-lg border border-line bg-panel">
          <EmptyState
            title={t('empty')}
            lead={can('budgets.manage') ? t('emptyLead') : undefined}
          />
        </div>
      ) : (
        <ul className="grid gap-4 lg:grid-cols-2">
          {budgets.map((b) => (
            <li
              key={b.id}
              className="flex min-w-0 flex-col gap-4 rounded-lg border border-line bg-panel p-5"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="font-semibold">{b.name}</h2>
                  <p className="text-sm text-muted">
                    {[
                      b.teamName ?? t('wholeOrganization'),
                      b.tournamentName,
                      b.seasonName,
                      b.periodStart || b.periodEnd
                        ? `${b.periodStart ? formatDay(b.periodStart, fl) : '…'} – ${b.periodEnd ? formatDay(b.periodEnd, fl) : '…'}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <Badge tone={b.over ? 'brick' : 'turf'}>
                    {b.over ? t('statusOver') : t('statusOk')}
                  </Badge>
                  {manageable(b) && (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditing(b)}
                        aria-label={`${tc('edit')} ${b.name}`}
                      >
                        <Pencil className="size-4" aria-hidden="true" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setDeleting(b)}
                        aria-label={`${tc('delete')} ${b.name}`}
                      >
                        <Trash2 className="size-4" aria-hidden="true" />
                      </Button>
                    </>
                  )}
                </div>
              </div>
              <VarianceRow line={b.variance.total} label={t('totalLine')} currency={b.currency} />
              {b.variance.lines.length > 0 && (
                <div className="flex flex-col gap-3 border-t border-line pt-4">
                  {b.variance.lines.map((l) => (
                    <VarianceRow
                      key={l.category}
                      line={l}
                      label={L.category[l.category!] ?? l.category!}
                      currency={b.currency}
                    />
                  ))}
                </div>
              )}
              {b.notes && <p className="text-sm text-muted">{b.notes}</p>}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-4 text-sm text-muted">{t('alertsNote')}</p>

      {editing && (
        <BudgetDialog
          budget={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        title={t('delete')}
        body={deleting ? t('deleteConfirm', { name: deleting.name }) : ''}
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
