'use client';

import {
  CURRENCIES,
  type GameDto,
  type TeamDto,
  type TournamentDto,
  tournamentInputSchema,
  TOURNAMENT_STATUSES,
} from '@esports/shared';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
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
  todayIso,
  useFinanceLabels,
  useFinanceLocale,
  useTournaments,
} from '@/lib/finance';
import { invalidFields } from '@/lib/form';
import { useAction } from '@/lib/mutation';
import { useCan } from '@/lib/session';

const STALE_DAYS = 90;
const TEXT_FIELDS = [
  'organizer',
  'region',
  'eligibility',
  'qualification',
  'travelRequirements',
  'historicalResults',
  'sponsorCoverage',
  'notes',
] as const;

type Form = Record<
  | (typeof TEXT_FIELDS)[number]
  | 'name'
  | 'gameId'
  | 'startDate'
  | 'endDate'
  | 'status'
  | 'entryFeeAmount'
  | 'entryFeeCurrency'
  | 'prizePoolAmount'
  | 'prizePoolCurrency'
  | 'sourceUrl'
  | 'lastVerifiedOn',
  string
> & {
  placementRewards: { placement: string; amount: string; currency: string }[];
  teamIds: string[];
};

const daysSince = (iso: string) =>
  Math.floor((Date.now() - new Date(`${iso}T00:00:00Z`).getTime()) / 86_400_000);

function TournamentDialog({
  tournament,
  onClose,
}: {
  tournament: TournamentDto | null;
  onClose: () => void;
}) {
  const t = useTranslations('tournaments');
  const tc = useTranslations('common');
  const L = useFinanceLabels();
  const can = useCan();
  const games = useQuery({
    queryKey: ['games'],
    queryFn: () => api<GameDto[]>('/games'),
    enabled: can('games.view'),
  });
  const teams = useQuery({
    queryKey: ['teams'],
    queryFn: () => api<TeamDto[]>('/teams'),
    enabled: can('teams.view'),
  });
  const [form, setForm] = useState<Form>(() => ({
    name: tournament?.name ?? '',
    gameId: tournament?.gameId ?? '',
    startDate: tournament?.startDate ?? '',
    endDate: tournament?.endDate ?? '',
    status: tournament?.status ?? 'researching',
    entryFeeAmount: tournament?.entryFeeAmount ?? '',
    entryFeeCurrency: tournament?.entryFeeCurrency ?? 'USD',
    prizePoolAmount: tournament?.prizePoolAmount ?? '',
    prizePoolCurrency: tournament?.prizePoolCurrency ?? 'USD',
    sourceUrl: tournament?.sourceUrl ?? '',
    lastVerifiedOn: tournament?.lastVerifiedOn ?? '',
    ...(Object.fromEntries(TEXT_FIELDS.map((f) => [f, tournament?.[f] ?? ''])) as Record<
      (typeof TEXT_FIELDS)[number],
      string
    >),
    placementRewards: tournament?.placementRewards.map((p) => ({ ...p })) ?? [],
    teamIds: tournament?.teams.map((x) => x.id) ?? [],
  }));
  const [touched, setTouched] = useState(false);
  const set = (k: keyof Form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const body = () => ({
    name: form.name.trim(),
    gameId: form.gameId || null,
    startDate: form.startDate || null,
    endDate: form.endDate || null,
    status: form.status,
    entryFeeAmount: orNull(form.entryFeeAmount),
    entryFeeCurrency: form.entryFeeAmount.trim() ? form.entryFeeCurrency : null,
    prizePoolAmount: orNull(form.prizePoolAmount),
    prizePoolCurrency: form.prizePoolAmount.trim() ? form.prizePoolCurrency : null,
    sourceUrl: orNull(form.sourceUrl),
    lastVerifiedOn: form.lastVerifiedOn || null,
    ...Object.fromEntries(TEXT_FIELDS.map((f) => [f, orNull(form[f])])),
    placementRewards: form.placementRewards.filter((p) => p.placement.trim() || p.amount.trim()),
    teamIds: form.teamIds,
  });
  const invalid = invalidFields(tournamentInputSchema, body());
  const save = useAction(
    () =>
      tournament
        ? apiPatch(`/tournaments/${tournament.id}`, body())
        : apiPost('/tournaments', body()),
    {
      invalidate: [['tournaments']],
      success: tournament ? t('saved') : t('created'),
      onSuccess: onClose,
    },
  );
  const err = (f: string, m: string) => (touched && invalid.has(f) ? m : null);
  const currencySelect = (k: 'entryFeeCurrency' | 'prizePoolCurrency', label: string) => (
    <SelectField label={label} value={form[k]} onChange={set(k)}>
      {CURRENCIES.map((c) => (
        <option key={c.code} value={c.code}>
          {c.code}
        </option>
      ))}
    </SelectField>
  );

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={tournament ? t('edit') : t('new')}
      lead={t('manualNotice')}
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
            {save.isPending ? tc('saving') : tournament ? tc('saveChanges') : tc('create')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <ErrorBanner error={save.error} />
        {touched && invalid.size > 0 && (
          <p className="text-sm text-brick" role="alert">
            {t('fixFields')}
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label={tc('name')}
            value={form.name}
            onChange={set('name')}
            autoFocus
            error={err('name', tc('required'))}
          />
          <TextField
            label={t('organizer')}
            optional
            value={form.organizer}
            onChange={set('organizer')}
          />
          {can('games.view') && (
            <SelectField label={t('game')} optional value={form.gameId} onChange={set('gameId')}>
              <option value="">{tc('none')}</option>
              {(games.data ?? []).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </SelectField>
          )}
          <TextField label={t('region')} optional value={form.region} onChange={set('region')} />
          <TextField
            label={t('startDate')}
            optional
            type="date"
            value={form.startDate}
            onChange={set('startDate')}
          />
          <TextField
            label={t('endDate')}
            optional
            type="date"
            value={form.endDate}
            onChange={set('endDate')}
          />
          <SelectField label={tc('status')} value={form.status} onChange={set('status')}>
            {TOURNAMENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {L.tournamentStatus[s]}
              </option>
            ))}
          </SelectField>
        </div>

        <fieldset className="grid gap-4 rounded-md border border-line p-4 sm:grid-cols-2">
          <legend className="px-1 text-sm font-medium">{t('money')}</legend>
          <TextField
            label={t('entryFee')}
            optional
            inputMode="decimal"
            className="ltr-text"
            value={form.entryFeeAmount}
            onChange={set('entryFeeAmount')}
            error={err('entryFeeAmount', t('amountInvalid'))}
          />
          {currencySelect('entryFeeCurrency', t('currency'))}
          <TextField
            label={t('prizePool')}
            optional
            inputMode="decimal"
            className="ltr-text"
            value={form.prizePoolAmount}
            onChange={set('prizePoolAmount')}
            error={err('prizePoolAmount', t('amountInvalid'))}
          />
          {currencySelect('prizePoolCurrency', t('currency'))}
          <div className="flex flex-col gap-2 sm:col-span-2">
            <span className="text-sm font-medium">{t('placementRewards')}</span>
            {form.placementRewards.map((p, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_6rem_auto] items-end gap-2">
                <TextField
                  label={t('placement')}
                  value={p.placement}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      placementRewards: f.placementRewards.map((x, j) =>
                        j === i ? { ...x, placement: e.target.value } : x,
                      ),
                    }))
                  }
                />
                <TextField
                  label={t('amount')}
                  inputMode="decimal"
                  className="ltr-text"
                  value={p.amount}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      placementRewards: f.placementRewards.map((x, j) =>
                        j === i ? { ...x, amount: e.target.value } : x,
                      ),
                    }))
                  }
                />
                <SelectField
                  label={t('currency')}
                  value={p.currency}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      placementRewards: f.placementRewards.map((x, j) =>
                        j === i ? { ...x, currency: e.target.value } : x,
                      ),
                    }))
                  }
                >
                  {CURRENCIES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code}
                    </option>
                  ))}
                </SelectField>
                <Button
                  variant="ghost"
                  aria-label={tc('remove')}
                  onClick={() =>
                    setForm((f) => ({
                      ...f,
                      placementRewards: f.placementRewards.filter((_, j) => j !== i),
                    }))
                  }
                >
                  <X className="size-4" aria-hidden="true" />
                </Button>
              </div>
            ))}
            <div>
              <Button
                size="sm"
                onClick={() =>
                  setForm((f) => ({
                    ...f,
                    placementRewards: [
                      ...f.placementRewards,
                      { placement: '', amount: '', currency: f.prizePoolCurrency },
                    ],
                  }))
                }
              >
                <Plus className="size-4" aria-hidden="true" />
                {t('addPlacement')}
              </Button>
            </div>
          </div>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <TextArea
            label={t('eligibility')}
            optional
            value={form.eligibility}
            onChange={set('eligibility')}
          />
          <TextArea
            label={t('qualification')}
            optional
            value={form.qualification}
            onChange={set('qualification')}
          />
          <TextArea
            label={t('travelRequirements')}
            optional
            value={form.travelRequirements}
            onChange={set('travelRequirements')}
          />
          <TextArea
            label={t('sponsorCoverage')}
            optional
            value={form.sponsorCoverage}
            onChange={set('sponsorCoverage')}
          />
        </div>
        <TextArea
          label={t('historicalResults')}
          optional
          value={form.historicalResults}
          onChange={set('historicalResults')}
        />

        <fieldset className="grid gap-4 rounded-md border border-line p-4 sm:grid-cols-2">
          <legend className="px-1 text-sm font-medium">{t('sourceSection')}</legend>
          <TextField
            label={t('sourceUrl')}
            optional
            type="url"
            className="ltr-text"
            placeholder="https://"
            value={form.sourceUrl}
            onChange={set('sourceUrl')}
            error={err('sourceUrl', t('urlInvalid'))}
          />
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <TextField
                label={t('lastVerifiedOn')}
                optional
                type="date"
                value={form.lastVerifiedOn}
                onChange={set('lastVerifiedOn')}
              />
            </div>
            <Button onClick={() => setForm((f) => ({ ...f, lastVerifiedOn: todayIso() }))}>
              {t('verifiedToday')}
            </Button>
          </div>
        </fieldset>

        {can('teams.view') && (teams.data ?? []).length > 0 && (
          <fieldset>
            <legend className="mb-2 text-sm font-medium">{t('teams')}</legend>
            <div className="flex flex-wrap gap-2">
              {(teams.data ?? []).map((tm) => (
                <label
                  key={tm.id}
                  className="inline-flex items-center gap-2 rounded-md border border-line px-3 py-1.5 text-sm"
                >
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--turf)]"
                    checked={form.teamIds.includes(tm.id)}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        teamIds: e.target.checked
                          ? [...f.teamIds, tm.id]
                          : f.teamIds.filter((x) => x !== tm.id),
                      }))
                    }
                  />
                  {tm.name}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <TextArea label={t('notes')} optional value={form.notes} onChange={set('notes')} />
      </div>
    </Dialog>
  );
}

export default function TournamentsPage() {
  const t = useTranslations('tournaments');
  const tc = useTranslations('common');
  const L = useFinanceLabels();
  const fl = useFinanceLocale();
  const can = useCan();
  const list = useTournaments();
  const [editing, setEditing] = useState<TournamentDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<TournamentDto | null>(null);
  const [status, setStatus] = useState('');
  const remove = useAction((id: string) => apiDelete(`/tournaments/${id}`), {
    invalidate: [['tournaments']],
    success: t('deleted'),
    onSuccess: () => setDeleting(null),
  });
  const rows = (list.data ?? []).filter((x) => !status || x.status === status);

  return (
    <>
      <PageHeader
        title={t('title')}
        lead={t('lead')}
        actions={
          can('tournaments.create') ? (
            <Button variant="primary" onClick={() => setEditing('new')}>
              <Plus className="size-4" aria-hidden="true" />
              {t('new')}
            </Button>
          ) : undefined
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2">
          <span className="text-muted">{tc('status')}</span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="h-8 rounded-md border border-line-strong bg-panel px-2"
          >
            <option value="">{t('allStatuses')}</option>
            {TOURNAMENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {L.tournamentStatus[s]}
              </option>
            ))}
          </select>
        </label>
        <span className="text-muted">{t('manualNotice')}</span>
      </div>
      {list.isLoading ? (
        <Spinner />
      ) : list.error ? (
        <ErrorBanner error={list.error} />
      ) : !rows.length ? (
        <div className="rounded-lg border border-line bg-panel">
          <EmptyState
            title={t('empty')}
            lead={can('tournaments.create') ? t('emptyLead') : undefined}
          />
        </div>
      ) : (
        <ul className="flex flex-col gap-4">
          {rows.map((x) => {
            const age = x.lastVerifiedOn ? daysSince(x.lastVerifiedOn) : null;
            const stale = age === null || age > STALE_DAYS;
            return (
              <li key={x.id} className="rounded-lg border border-line bg-panel p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-lg font-semibold">{x.name}</h2>
                    <p className="text-sm text-muted">
                      {[
                        x.organizer,
                        x.gameName,
                        x.region,
                        x.startDate
                          ? `${formatDay(x.startDate, fl)}${x.endDate ? ` – ${formatDay(x.endDate, fl)}` : ''}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <Badge
                      tone={
                        x.status === 'declined'
                          ? 'neutral'
                          : x.status === 'researching'
                            ? 'amber'
                            : 'turf'
                      }
                    >
                      {L.tournamentStatus[x.status]}
                    </Badge>
                    {can('tournaments.edit') && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditing(x)}
                        aria-label={`${tc('edit')} ${x.name}`}
                      >
                        <Pencil className="size-4" aria-hidden="true" />
                      </Button>
                    )}
                    {can('tournaments.delete') && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setDeleting(x)}
                        aria-label={`${tc('delete')} ${x.name}`}
                      >
                        <Trash2 className="size-4" aria-hidden="true" />
                      </Button>
                    )}
                  </div>
                </div>
                <dl className="mt-4 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <dt className="text-muted">{t('prizePool')}</dt>
                    <dd className="font-medium">
                      {x.prizePoolAmount ? (
                        <Money amount={x.prizePoolAmount} currency={x.prizePoolCurrency!} />
                      ) : (
                        '—'
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted">{t('entryFee')}</dt>
                    <dd className="font-medium">
                      {x.entryFeeAmount ? (
                        <Money amount={x.entryFeeAmount} currency={x.entryFeeCurrency!} />
                      ) : (
                        '—'
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted">{t('teams')}</dt>
                    <dd>{x.teams.length ? x.teams.map((tm) => tm.name).join(', ') : '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">{t('source')}</dt>
                    <dd className="flex flex-col gap-1">
                      {x.sourceUrl ? (
                        <a
                          href={x.sourceUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="ltr-text inline-flex items-center gap-1 truncate underline"
                        >
                          {new URL(x.sourceUrl).hostname}
                          <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
                        </a>
                      ) : (
                        <span className="text-muted">{t('noSource')}</span>
                      )}
                      <span className={stale ? 'text-amber-ink' : 'text-muted'}>
                        {x.lastVerifiedOn
                          ? t('verifiedOn', { date: formatDay(x.lastVerifiedOn, fl) })
                          : t('neverVerified')}
                        {stale && x.lastVerifiedOn ? ` · ${t('stale')}` : ''}
                      </span>
                    </dd>
                  </div>
                </dl>
                {x.placementRewards.length > 0 && (
                  <details className="mt-3 text-sm">
                    <summary className="cursor-pointer text-muted">{t('placementRewards')}</summary>
                    <ul className="mt-2 flex flex-col gap-1">
                      {x.placementRewards.map((p, i) => (
                        <li key={i} className="flex justify-between gap-4 sm:max-w-sm">
                          <span>{p.placement}</span>
                          <Money amount={p.amount} currency={p.currency} />
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {(x.eligibility ||
                  x.qualification ||
                  x.travelRequirements ||
                  x.sponsorCoverage ||
                  x.historicalResults ||
                  x.notes) && (
                  <details className="mt-2 text-sm">
                    <summary className="cursor-pointer text-muted">{t('details')}</summary>
                    <dl className="mt-2 grid gap-3 sm:grid-cols-2">
                      {(
                        [
                          'eligibility',
                          'qualification',
                          'travelRequirements',
                          'sponsorCoverage',
                          'historicalResults',
                          'notes',
                        ] as const
                      ).map((f) =>
                        x[f] ? (
                          <div key={f}>
                            <dt className="text-muted">{t(f)}</dt>
                            <dd className="whitespace-pre-line">{x[f]}</dd>
                          </div>
                        ) : null,
                      )}
                    </dl>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {editing && (
        <TournamentDialog
          tournament={editing === 'new' ? null : editing}
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
