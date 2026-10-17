'use client';

import {
  buildFinancialReport,
  EXPORT_FORMATS,
  type ExportFormat,
  type FinancialReport,
  footnoteText,
  formatMonth,
  monthOf,
  SCENARIO_NAMES,
  type ScenarioInputs,
  scenarioInputsSchema,
  type ScenarioName,
  type ScenarioSet,
  type ScopeKind,
} from '@esports/shared';
import { useQuery } from '@tanstack/react-query';
import { Download, RotateCcw, Save } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { ColumnChart, Legend, LineChart } from '@/components/finance/charts';
import { FinanceNav } from '@/components/finance/finance-nav';
import { Money } from '@/components/finance/money';
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
  thEndClass,
  useErrorText,
  useToast,
} from '@/components/ui';
import { api, apiDelete, apiPut } from '@/lib/api';
import {
  downloadPost,
  formatDay,
  useFinanceLabels,
  useFinanceLocale,
  useFinanceScopes,
  useMoney,
} from '@/lib/finance';
import { useAction } from '@/lib/mutation';
import { useCan, useCovers } from '@/lib/session';

const COST = 'var(--series-2)';
const REVENUE = 'var(--series-1)';
const SCENARIO_COLOR: Record<ScenarioName, string> = {
  base: 'var(--series-1)',
  pessimistic: 'var(--series-2)',
  optimistic: 'var(--series-3)',
};
const SCENARIO_FIELDS = ['monthlyRevenue', 'monthlyCost', 'oneOffRevenue', 'oneOffCost'] as const;

type Draft = Record<ScenarioName, Record<keyof ScenarioInputs, string>>;

const toDraft = (s: ScenarioSet): Draft =>
  Object.fromEntries(
    SCENARIO_NAMES.map((n) => [
      n,
      {
        ...Object.fromEntries(SCENARIO_FIELDS.map((f) => [f, s[n][f]])),
        horizonMonths: String(s[n].horizonMonths),
      },
    ]),
  ) as Draft;

/** The draft as valid scenario inputs, or null for any scenario that doesn't validate yet. */
function fromDraft(d: Draft): Partial<ScenarioSet> {
  const out: Partial<ScenarioSet> = {};
  for (const n of SCENARIO_NAMES) {
    const parsed = scenarioInputsSchema.safeParse({
      ...d[n],
      horizonMonths: Number(d[n].horizonMonths),
    });
    if (parsed.success) out[n] = parsed.data;
  }
  return out;
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-line bg-panel px-5 py-4">
      <span className="text-sm text-muted">{label}</span>
      <span className="truncate text-2xl font-semibold text-ink">{value}</span>
      {note && <span className="text-[0.8125rem] text-muted">{note}</span>}
    </div>
  );
}

function ShareList({
  rows,
  color,
  currency,
}: {
  rows: FinancialReport['costsByCategory'];
  color: string;
  currency: string;
}) {
  const L = useFinanceLabels();
  const t = useTranslations('finance.report');
  if (!rows.length) return <EmptyState title={t('nothingYet')} />;
  return (
    <ul className="divide-y divide-line">
      {rows.map((r) => (
        <li key={r.category} className="flex flex-col gap-1.5 px-5 py-3">
          <div className="flex items-baseline justify-between gap-3">
            <span>{L.category[r.category] ?? r.category}</span>
            <span className="flex items-baseline gap-3">
              <Money amount={r.amount} currency={currency} className="font-medium" />
              <span className="w-12 text-end text-sm text-muted tabular-nums">
                {r.sharePercent}%
              </span>
            </span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-panel-2" aria-hidden="true">
            <div
              className="h-full rounded-full"
              style={{ width: `${Math.min(100, Number(r.sharePercent))}%`, background: color }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function FinanceReportPage() {
  const t = useTranslations('finance');
  const tc = useTranslations('common');
  const L = useFinanceLabels();
  const R = L.report;
  const fl = useFinanceLocale();
  const fmt = useMoney();
  const can = useCan();
  const covers = useCovers();
  const toast = useToast();
  const errorText = useErrorText();
  const scopes = useFinanceScopes();

  const [scopeKey, setScopeKey] = useState<string>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [rateMode, setRateMode] = useState<'snapshot' | 'current'>('snapshot');
  const [showTable, setShowTable] = useState(false);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);

  // Deep link: /dashboard/finance?scope=team&id=…
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const kind = p.get('scope');
    if (kind) setScopeKey(`${kind}:${p.get('id') ?? ''}`);
  }, []);
  const options = scopes.data ?? [];
  const selected =
    options.find((o) => `${o.kind}:${o.id ?? ''}` === scopeKey) ?? options[0] ?? null;

  const qs = new URLSearchParams();
  if (selected) {
    qs.set('scope', selected.kind);
    if (selected.id) qs.set('scopeId', selected.id);
  }
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  qs.set('rateMode', rateMode);
  const report = useQuery({
    queryKey: ['finance', 'report', qs.toString()],
    queryFn: () => api<FinancialReport>(`/finance/reports?${qs.toString()}`),
    enabled: !!selected,
    placeholderData: (prev) => prev,
  });
  const r = report.data;

  // Scenario inputs: editable, recomputed live with the same engine the server and exports use.
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => {
    if (r)
      setDraft(
        toDraft(
          Object.fromEntries(SCENARIO_NAMES.map((n) => [n, r.scenarios[n].inputs])) as ScenarioSet,
        ),
      );
  }, [r]);
  const valid = draft ? fromDraft(draft) : {};
  const effective: ScenarioSet | null = r
    ? (Object.fromEntries(
        SCENARIO_NAMES.map((n) => [n, valid[n] ?? r.scenarios[n].inputs]),
      ) as ScenarioSet)
    : null;
  const live = useMemo(() => {
    if (!r || !effective) return r;
    const missing = r.footnotes.find((f) => f.key === 'current_rate_missing')?.params?.currencies;
    return buildFinancialReport({
      baseCurrency: r.baseCurrency,
      scope: r.scope,
      period: r.period,
      rateMode: r.rateMode,
      asOf: r.asOf,
      entries: r.entries,
      scenarios: effective,
      scenarioDefaults: r.scenarioDefaults,
      usedPayrollProjection: r.footnotes.some((f) => f.key === 'payroll_projection'),
      payrollExcluded: {
        notPeriodic: Number(
          r.footnotes.find((f) => f.key === 'payroll_not_periodic')?.params?.count ?? 0,
        ),
        noRate:
          r.footnotes.find((f) => f.key === 'payroll_no_rate')?.params?.currencies?.split(', ') ??
          [],
      },
      missingCurrentRates: missing ? missing.split(', ') : [],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r, JSON.stringify(effective)]);
  const dirty =
    !!r &&
    !!effective &&
    JSON.stringify(effective) !==
      JSON.stringify(Object.fromEntries(SCENARIO_NAMES.map((n) => [n, r.scenarios[n].inputs])));
  const invalidScenario = !!draft && SCENARIO_NAMES.some((n) => !valid[n]);

  const scopeTeam =
    selected?.kind === 'team' && selected.id
      ? { id: selected.id, departmentId: selected.departmentId ?? null }
      : null;
  const canAt = (perm: 'finance.edit' | 'finance.export') =>
    scopeTeam ? covers.team(perm, scopeTeam) : covers.department(perm, null);

  const saveScenarios = useAction(
    () =>
      apiPut('/finance/scenarios', {
        scope: selected!.kind,
        scopeId: selected!.id,
        scenarios: effective,
      }),
    { invalidate: [['finance', 'report']], success: t('scenarios.saved') },
  );
  const resetScenarios = useAction(
    () =>
      apiDelete(
        `/finance/scenarios?scope=${selected!.kind}${selected!.id ? `&scopeId=${selected!.id}` : ''}`,
      ),
    { invalidate: [['finance', 'report']], success: t('scenarios.resetDone') },
  );

  const doExport = async (format: ExportFormat) => {
    if (!selected || !effective) return;
    setExporting(format);
    try {
      await downloadPost('/finance/reports/export', {
        query: {
          scope: selected.kind,
          scopeId: selected.id ?? undefined,
          from: from || undefined,
          to: to || undefined,
          rateMode,
        },
        scenarios: effective,
        format,
        locale: fl,
      });
    } catch (e) {
      toast(errorText(e));
    } finally {
      setExporting(null);
    }
  };

  if (!can('finance.view')) {
    return (
      <>
        <PageHeader title={t('title')} lead={t('report.noAccess')} />
        <FinanceNav />
      </>
    );
  }

  const kinds: ScopeKind[] = ['organization', 'team', 'tournament', 'season'];
  const months = live?.monthly ?? [];
  const monthLabels = months.map((m) => formatMonth(m.month, fl));
  const be = live?.breakEven;
  const projectionStart = live
    ? (() => {
        const asOfMonth = monthOf(live.asOf);
        const last = live.monthly.at(-1)?.month ?? asOfMonth;
        return last > asOfMonth ? last : asOfMonth;
      })()
    : null;

  return (
    <>
      <PageHeader title={t('title')} lead={t('report.lead')} />
      <FinanceNav />

      {/* One row of filters scoping everything below. */}
      <div className="mb-6 flex flex-wrap items-end gap-3">
        <label className="flex min-w-[14rem] flex-col gap-1 text-sm">
          <span className="text-muted">{R.scope}</span>
          <select
            value={selected ? `${selected.kind}:${selected.id ?? ''}` : ''}
            onChange={(e) => setScopeKey(e.target.value)}
            className="h-10 rounded-md border border-line-strong bg-panel px-2"
          >
            {kinds.map((k) => {
              const group = options.filter((o) => o.kind === k);
              if (!group.length) return null;
              return (
                <optgroup key={k} label={L.scopeKind[k]}>
                  {group.map((o) => (
                    <option key={`${o.kind}:${o.id ?? ''}`} value={`${o.kind}:${o.id ?? ''}`}>
                      {o.name}
                    </option>
                  ))}
                </optgroup>
              );
            })}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">{t('report.from')}</span>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="h-10 rounded-md border border-line-strong bg-panel px-2"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">{t('report.to')}</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="h-10 rounded-md border border-line-strong bg-panel px-2"
          />
        </label>
        <fieldset className="flex flex-col gap-1 text-sm">
          <legend className="mb-1 text-muted">{R.rates}</legend>
          <div className="inline-flex h-10 rounded-md border border-line-strong p-0.5">
            {(['snapshot', 'current'] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={rateMode === m}
                onClick={() => setRateMode(m)}
                className={`rounded px-3 ${rateMode === m ? 'bg-turf text-turf-ink' : 'text-ink hover:bg-panel-2'}`}
              >
                {t(`report.rateMode.${m}`)}
              </button>
            ))}
          </div>
        </fieldset>
        {canAt('finance.export') && live && (
          <div className="flex flex-col gap-1 text-sm">
            <span className="text-muted">{t('report.export')}</span>
            <div className="flex flex-wrap gap-1.5">
              {EXPORT_FORMATS.map((f) => (
                <Button
                  key={f}
                  disabled={!!exporting || invalidScenario}
                  onClick={() => doExport(f)}
                >
                  <Download className="size-4" aria-hidden="true" />
                  {exporting === f ? tc('loading') : t(`report.formats.${f}`)}
                </Button>
              ))}
            </div>
          </div>
        )}
      </div>

      {!selected && !scopes.isLoading ? (
        <EmptyState title={t('report.noScopes')} />
      ) : report.isLoading || !live ? (
        report.error ? (
          <ErrorBanner error={report.error} />
        ) : (
          <Spinner />
        )
      ) : (
        <div className={`flex flex-col gap-8 ${report.isFetching ? 'opacity-70' : ''}`}>
          {rateMode === 'current' && (
            <p
              className="rounded-md border border-amber/40 bg-amber-soft px-4 py-3 text-sm text-ink"
              role="note"
            >
              {footnoteText(fl, 'rates_current')}
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label={R.totalCost} value={fmt(live.totals.cost, live.baseCurrency)} />
            <Stat
              label={R.realizedRevenue}
              value={fmt(live.totals.realizedRevenue, live.baseCurrency)}
            />
            <Stat
              label={t('report.netShort')}
              value={fmt(live.totals.net, live.baseCurrency)}
              note={t('report.netNote')}
            />
            <Stat
              label={R.paybackMonths}
              value={
                be?.status === 'covered'
                  ? String(be.paybackMonths)
                  : be?.status === 'no_costs'
                    ? '—'
                    : R.notReached
              }
              note={
                be?.status === 'covered' && be.firstBreakEvenMonth
                  ? t('report.brokeEvenIn', { month: formatMonth(be.firstBreakEvenMonth, fl) })
                  : be?.status === 'not_covered'
                    ? t('report.stillNeeded', { amount: fmt(be.revenueNeeded, live.baseCurrency) })
                    : undefined
              }
            />
          </div>

          <Section
            title={R.monthly}
            lead={t('report.monthlyLead')}
            actions={
              <Button
                size="sm"
                variant="ghost"
                aria-pressed={showTable}
                onClick={() => setShowTable((v) => !v)}
              >
                {showTable ? t('report.showChart') : t('report.showTable')}
              </Button>
            }
          >
            {!months.length ? (
              <EmptyState title={t('report.nothingYet')} lead={t('report.nothingYetLead')} />
            ) : showTable ? (
              <div className="relative overflow-x-auto">
                <table className={tableClass}>
                  <thead>
                    <tr>
                      <th className={thClass}>{R.month}</th>
                      <th className={thEndClass}>{R.cost}</th>
                      <th className={thEndClass}>{R.revenue}</th>
                      <th className={thEndClass}>{R.monthNet}</th>
                      <th className={thEndClass}>{R.cumulative}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {months.map((m) => (
                      <tr key={m.month}>
                        <td className={tdClass}>{formatMonth(m.month, fl)}</td>
                        <td className={`${tdClass} text-end`}>
                          <Money amount={m.cost} currency={live.baseCurrency} />
                        </td>
                        <td className={`${tdClass} text-end`}>
                          <Money amount={m.revenue} currency={live.baseCurrency} />
                        </td>
                        <td className={`${tdClass} text-end`}>
                          <Money amount={m.net} currency={live.baseCurrency} />
                        </td>
                        <td className={`${tdClass} text-end font-medium`}>
                          <Money amount={m.cumulativeNet} currency={live.baseCurrency} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="flex flex-col gap-6 px-5 py-5">
                <div className="flex flex-col gap-3">
                  <Legend
                    shape="rect"
                    items={[
                      { label: R.cost, color: COST },
                      { label: R.revenue, color: REVENUE },
                    ]}
                  />
                  <ColumnChart
                    label={t('report.monthlyChart')}
                    labels={monthLabels}
                    format={(n) => fmt(String(n), live.baseCurrency)}
                    series={[
                      {
                        key: 'cost',
                        label: R.cost,
                        color: COST,
                        values: months.map((m) => Number(m.cost)),
                      },
                      {
                        key: 'revenue',
                        label: R.revenue,
                        color: REVENUE,
                        values: months.map((m) => Number(m.revenue)),
                      },
                    ]}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <h3 className="text-sm font-medium">{R.cumulative}</h3>
                  <LineChart
                    label={t('report.cumulativeChart')}
                    labels={monthLabels}
                    format={(n) => fmt(String(n), live.baseCurrency)}
                    height={180}
                    endLabels={false}
                    marker={
                      be?.firstBreakEvenMonth
                        ? {
                            index: months.findIndex((m) => m.month === be.firstBreakEvenMonth),
                            caption: R.firstBreakEvenMonth,
                          }
                        : null
                    }
                    series={[
                      {
                        key: 'cum',
                        label: R.cumulative,
                        color: REVENUE,
                        values: months.map((m) => Number(m.cumulativeNet)),
                      },
                    ]}
                  />
                </div>
              </div>
            )}
          </Section>

          <div className="grid gap-8 lg:grid-cols-2">
            <Section title={R.costsByCategory}>
              <ShareList rows={live.costsByCategory} color={COST} currency={live.baseCurrency} />
            </Section>
            <Section title={R.revenueByCategory}>
              <ShareList
                rows={live.revenueByCategory}
                color={REVENUE}
                currency={live.baseCurrency}
              />
            </Section>
          </div>

          {live.byTeam && live.byTeam.length > 0 && (
            <Section title={R.byTeam}>
              <div className="relative overflow-x-auto">
                <table className={tableClass}>
                  <thead>
                    <tr>
                      <th className={thClass}>{R.team}</th>
                      <th className={thEndClass}>{R.cost}</th>
                      <th className={thEndClass}>{R.revenue}</th>
                      <th className={thEndClass}>{R.monthNet}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {live.byTeam.map((row) => (
                      <tr key={row.teamId ?? 'org'}>
                        <td className={tdClass}>
                          {row.teamName ?? <span className="text-muted">{R.noTeam}</span>}
                        </td>
                        <td className={`${tdClass} text-end`}>
                          <Money amount={row.cost} currency={live.baseCurrency} />
                        </td>
                        <td className={`${tdClass} text-end`}>
                          <Money amount={row.revenue} currency={live.baseCurrency} />
                        </td>
                        <td className={`${tdClass} text-end font-medium`}>
                          <Money amount={row.net} currency={live.baseCurrency} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          <div className="grid gap-8 lg:grid-cols-2">
            <Section title={R.breakEven} lead={footnoteText(fl, 'break_even_definition')}>
              <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 px-5 py-4 text-[0.9375rem]">
                {be?.status === 'no_costs' ? (
                  <>
                    <dt className="text-muted">{R.firstCostMonth}</dt>
                    <dd>{R.noCosts}</dd>
                  </>
                ) : (
                  <>
                    <dt className="text-muted">{R.firstCostMonth}</dt>
                    <dd>{be?.firstCostMonth ? formatMonth(be.firstCostMonth, fl) : '—'}</dd>
                    <dt className="text-muted">{R.firstBreakEvenMonth}</dt>
                    <dd>
                      {be?.firstBreakEvenMonth
                        ? formatMonth(be.firstBreakEvenMonth, fl)
                        : R.notReached}
                    </dd>
                    <dt className="text-muted">{R.paybackMonths}</dt>
                    <dd className="tabular-nums">{be?.paybackMonths ?? R.notReached}</dd>
                    <dt className="text-muted">{R.currentPosition}</dt>
                    <dd>
                      <Money amount={be?.currentPosition} currency={live.baseCurrency} />
                    </dd>
                    <dt className="text-muted">{R.revenueNeeded}</dt>
                    <dd>
                      <Money amount={be?.revenueNeeded} currency={live.baseCurrency} />
                    </dd>
                  </>
                )}
              </dl>
            </Section>
            <Section title={R.projections} lead={footnoteText(fl, 'projections_separate')}>
              <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 px-5 py-4">
                <dt className="text-muted">{R.certainUnrealized}</dt>
                <dd>
                  <Money amount={live.projections.certain} currency={live.baseCurrency} />
                </dd>
                <dt className="text-muted">{R.uncertainUnrealized}</dt>
                <dd>
                  <Money amount={live.projections.uncertain} currency={live.baseCurrency} />
                </dd>
              </dl>
              {live.projections.items.length > 0 && (
                <ul className="divide-y divide-line border-t border-line">
                  {live.projections.items.map((p) => (
                    <li
                      key={p.id}
                      className="flex flex-wrap items-baseline justify-between gap-2 px-5 py-2.5 text-sm"
                    >
                      <span>
                        {formatDay(p.date, fl)} · {L.category[p.category] ?? p.category}
                        {p.description ? ` · ${p.description}` : ''}
                      </span>
                      <span className="flex items-center gap-2">
                        <Badge tone={p.certainty === 'certain' ? 'turf' : 'amber'}>
                          {p.certainty ? L.certainty[p.certainty] : ''}
                        </Badge>
                        <Money amount={p.baseAmount} currency={live.baseCurrency} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>

          <Section
            title={R.scenarios}
            lead={footnoteText(fl, 'scenario_definition')}
            actions={
              <div className="flex flex-wrap items-center gap-2">
                {(dirty || live.scenariosCustomized) && (
                  <Badge tone="amber">
                    {dirty ? t('scenarios.unsaved') : t('scenarios.customized')}
                  </Badge>
                )}
                {canAt('finance.edit') && (
                  <>
                    <Button
                      size="sm"
                      disabled={!dirty || invalidScenario || saveScenarios.isPending}
                      onClick={() => saveScenarios.mutate(undefined)}
                    >
                      <Save className="size-4" aria-hidden="true" />
                      {t('scenarios.save')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={resetScenarios.isPending || (!live.scenariosCustomized && !dirty)}
                      onClick={() =>
                        live.scenariosCustomized
                          ? resetScenarios.mutate(undefined)
                          : r && setDraft(toDraft(r.scenarioDefaults))
                      }
                    >
                      <RotateCcw className="size-4" aria-hidden="true" />
                      {t('scenarios.reset')}
                    </Button>
                  </>
                )}
              </div>
            }
          >
            <div className="flex flex-col gap-6 px-5 py-5">
              <ErrorBanner error={saveScenarios.error ?? resetScenarios.error} />
              {draft && (
                <div className="relative overflow-x-auto">
                  <table className={tableClass}>
                    <thead>
                      <tr>
                        <th className={thClass}>
                          <span className="sr-only">{R.item}</span>
                        </th>
                        {SCENARIO_NAMES.map((n) => (
                          <th key={n} className={thClass}>
                            <span className="inline-flex items-center gap-2">
                              <span
                                aria-hidden="true"
                                className="inline-block h-0.5 w-4 rounded"
                                style={{ background: SCENARIO_COLOR[n] }}
                              />
                              {L.scenario[n]}
                            </span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {([...SCENARIO_FIELDS, 'horizonMonths'] as const).map((field) => (
                        <tr key={field}>
                          <th
                            scope="row"
                            className={`${tdClass} text-start font-normal text-muted`}
                          >
                            {R[field]}
                          </th>
                          {SCENARIO_NAMES.map((n) => {
                            const bad =
                              !valid[n] &&
                              !scenarioInputsSchema.shape[field].safeParse(
                                field === 'horizonMonths'
                                  ? Number(draft[n][field])
                                  : draft[n][field],
                              ).success;
                            return (
                              <td key={n} className={tdClass}>
                                <input
                                  aria-label={`${L.scenario[n]}: ${R[field]}`}
                                  aria-invalid={bad || undefined}
                                  inputMode={field === 'horizonMonths' ? 'numeric' : 'decimal'}
                                  disabled={!canAt('finance.edit') && !canAt('finance.export')}
                                  value={draft[n][field]}
                                  onChange={(e) =>
                                    setDraft((d) =>
                                      d
                                        ? {
                                            ...d,
                                            [n]: {
                                              ...d[n],
                                              [field]: e.target.value.replace(',', '.'),
                                            },
                                          }
                                        : d,
                                    )
                                  }
                                  className={`ltr-text h-9 w-full min-w-[7rem] rounded-md border bg-panel px-2 tabular-nums ${bad ? 'border-brick' : 'border-line-strong'}`}
                                />
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                      {(
                        [
                          [
                            'startPosition',
                            (n: ScenarioName) => (
                              <Money
                                amount={live.scenarios[n].startPosition}
                                currency={live.baseCurrency}
                              />
                            ),
                          ],
                          [
                            'monthlyNetInput',
                            (n: ScenarioName) => (
                              <Money
                                amount={live.scenarios[n].monthlyNet}
                                currency={live.baseCurrency}
                              />
                            ),
                          ],
                          ['outcome', (n: ScenarioName) => L.outcome[live.scenarios[n].outcome]],
                          [
                            'breakEvenMonth',
                            (n: ScenarioName) =>
                              live.scenarios[n].breakEvenMonth
                                ? formatMonth(live.scenarios[n].breakEvenMonth!, fl)
                                : live.scenarios[n].outcome === 'beyond_horizon'
                                  ? t('scenarios.monthsAway', {
                                      count: live.scenarios[n].monthsToBreakEven ?? 0,
                                    })
                                  : '—',
                          ],
                          [
                            'endPosition',
                            (n: ScenarioName) => (
                              <Money
                                amount={live.scenarios[n].endPosition}
                                currency={live.baseCurrency}
                              />
                            ),
                          ],
                          [
                            'lowestPosition',
                            (n: ScenarioName) => (
                              <Money
                                amount={live.scenarios[n].lowestPosition}
                                currency={live.baseCurrency}
                              />
                            ),
                          ],
                          [
                            'requiredMonthlyRevenue',
                            (n: ScenarioName) => (
                              <Money
                                amount={live.scenarios[n].requiredMonthlyRevenue}
                                currency={live.baseCurrency}
                              />
                            ),
                          ],
                        ] as const
                      ).map(([key, cell]) => (
                        <tr key={key}>
                          <th
                            scope="row"
                            className={`${tdClass} text-start font-normal text-muted`}
                          >
                            {R[key]}
                          </th>
                          {SCENARIO_NAMES.map((n) => (
                            <td key={n} className={`${tdClass} font-medium`}>
                              {cell(n)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="flex flex-col gap-3">
                <Legend
                  shape="line"
                  items={SCENARIO_NAMES.map((n) => ({
                    label: L.scenario[n],
                    color: SCENARIO_COLOR[n],
                  }))}
                />
                {projectionStart && (
                  <LineChart
                    label={t('scenarios.chart')}
                    labels={live.scenarios.base.months.map((m) => formatMonth(m.month, fl))}
                    format={(n) => fmt(String(n), live.baseCurrency)}
                    series={SCENARIO_NAMES.map((n) => ({
                      key: n,
                      label: L.scenario[n],
                      color: SCENARIO_COLOR[n],
                      values: live.scenarios[n].months.map((m) => Number(m.position)),
                    }))}
                  />
                )}
                <p className="text-[0.8125rem] text-muted">
                  {footnoteText(
                    fl,
                    live.scenariosCustomized || dirty ? 'scenario_customized' : 'scenario_defaults',
                  )}
                </p>
              </div>
            </div>
          </Section>

          <Section title={t('report.howTitle')}>
            <ol className="flex list-decimal flex-col gap-2 py-4 ps-10 pe-5 text-sm text-muted">
              {live.footnotes.map((f) => (
                <li key={f.key}>{footnoteText(fl, f.key, f.params)}</li>
              ))}
            </ol>
            <p className="border-t border-line px-5 py-3 text-[0.8125rem] text-muted">
              {t('report.asOf', { date: formatDay(live.asOf, fl) })}
            </p>
          </Section>
        </div>
      )}
    </>
  );
}
