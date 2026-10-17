'use client';

import { CURRENCIES, type FinanceSettingsDto, type SeasonDto } from '@esports/shared';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { FinanceNav } from '@/components/finance/finance-nav';
import { CurrencyFlag, CurrencyLabel } from '@/components/finance/money';
import {
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorBanner,
  PageHeader,
  Section,
  SelectField,
  Spinner,
  TextField,
} from '@/components/ui';
import { apiDelete, apiPatch, apiPost } from '@/lib/api';
import { formatDay, useFinanceLocale, useFinanceSettings, useSeasons } from '@/lib/finance';
import { useAction } from '@/lib/mutation';
import { useCan } from '@/lib/session';

function SeasonDialog({ season, onClose }: { season: SeasonDto | null; onClose: () => void }) {
  const t = useTranslations('finance.settings');
  const tc = useTranslations('common');
  const [form, setForm] = useState({
    name: season?.name ?? '',
    startDate: season?.startDate ?? '',
    endDate: season?.endDate ?? '',
  });
  const save = useAction(
    () =>
      season ? apiPatch(`/finance/seasons/${season.id}`, form) : apiPost('/finance/seasons', form),
    {
      invalidate: [['finance']],
      success: season ? t('seasonSaved') : t('seasonCreated'),
      onSuccess: onClose,
    },
  );
  const ok = form.name.trim() && form.startDate && form.endDate && form.startDate <= form.endDate;
  return (
    <Dialog
      open
      onClose={onClose}
      title={season ? t('editSeason') : t('newSeason')}
      lead={t('seasonLead')}
      footer={
        <>
          <Button onClick={onClose}>{tc('cancel')}</Button>
          <Button
            variant="primary"
            disabled={!ok || save.isPending}
            onClick={() => save.mutate(undefined)}
          >
            {save.isPending ? tc('saving') : season ? tc('saveChanges') : tc('create')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <ErrorBanner error={save.error} />
        <TextField
          label={tc('name')}
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          autoFocus
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label={t('startDate')}
            type="date"
            value={form.startDate}
            onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))}
          />
          <TextField
            label={t('endDate')}
            type="date"
            value={form.endDate}
            onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))}
          />
        </div>
      </div>
    </Dialog>
  );
}

function CurrencySettings({ settings }: { settings: FinanceSettingsDto }) {
  const t = useTranslations('finance.settings');
  const tc = useTranslations('common');
  const locale = useLocale();
  const can = useCan();
  const editable = can('finance.configure');
  const [base, setBase] = useState(settings.baseCurrency);
  const [enabled, setEnabled] = useState<string[]>(settings.enabledCurrencies);
  useEffect(() => {
    setBase(settings.baseCurrency);
    setEnabled(settings.enabledCurrencies);
  }, [settings]);
  const save = useAction(
    () => apiPatch('/finance/settings', { baseCurrency: base, enabledCurrencies: enabled }),
    {
      invalidate: [['finance']],
      success: t('saved'),
    },
  );
  const changed =
    base !== settings.baseCurrency ||
    [...enabled].sort().join() !== [...settings.enabledCurrencies].sort().join();
  const name = (c: (typeof CURRENCIES)[number]) => (locale === 'ar' ? c.nameAr : c.nameEn);

  return (
    <Section
      title={t('currencies')}
      lead={t('currenciesLead')}
      actions={
        editable ? (
          <Button
            variant="primary"
            size="sm"
            disabled={!changed || save.isPending}
            onClick={() => save.mutate(undefined)}
          >
            {save.isPending ? tc('saving') : tc('saveChanges')}
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-5 px-5 py-5">
        <ErrorBanner error={save.error} />
        <div className="max-w-sm">
          <SelectField
            label={t('baseCurrency')}
            value={base}
            disabled={!editable || settings.baseCurrencyLocked}
            hint={settings.baseCurrencyLocked ? t('baseLocked') : t('baseHint')}
            onChange={(e) => {
              setBase(e.target.value);
              setEnabled((xs) => (xs.includes(e.target.value) ? xs : [e.target.value, ...xs]));
            }}
          >
            {CURRENCIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} — {name(c)}
              </option>
            ))}
          </SelectField>
        </div>
        <fieldset>
          <legend className="mb-2 text-sm font-medium">{t('enabledCurrencies')}</legend>
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {CURRENCIES.map((c) => {
              const checked = enabled.includes(c.code);
              const isBase = c.code === base;
              return (
                <li key={c.code}>
                  <label className="flex items-center gap-2.5 rounded-md border border-line px-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--turf)]"
                      checked={checked}
                      disabled={!editable || isBase}
                      onChange={(e) =>
                        setEnabled((xs) =>
                          e.target.checked ? [...xs, c.code] : xs.filter((x) => x !== c.code),
                        )
                      }
                    />
                    <CurrencyFlag code={c.code} />
                    <span className="ltr-text font-medium">{c.code}</span>
                    <span className="truncate text-muted">{name(c)}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>
        <p className="text-sm text-muted">
          {settings.fxProvider === 'none' ? (
            t('fxNone')
          ) : (
            <>
              {t('fxProvider')}{' '}
              <a
                href={settings.fxAttribution?.url}
                className="underline"
                target="_blank"
                rel="noreferrer"
              >
                {settings.fxAttribution?.text}
              </a>
              . {t('fxSnapshot')}
            </>
          )}
        </p>
      </div>
    </Section>
  );
}

export default function FinanceSettingsPage() {
  const t = useTranslations('finance.settings');
  const tf = useTranslations('finance');
  const tc = useTranslations('common');
  const fl = useFinanceLocale();
  const can = useCan();
  const settings = useFinanceSettings();
  const seasons = useSeasons();
  const [editing, setEditing] = useState<SeasonDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<SeasonDto | null>(null);
  const remove = useAction((id: string) => apiDelete(`/finance/seasons/${id}`), {
    invalidate: [['finance']],
    success: t('seasonDeleted'),
    onSuccess: () => setDeleting(null),
  });
  const editable = can('finance.configure');

  return (
    <>
      <PageHeader title={tf('title')} lead={t('lead')} />
      <FinanceNav />
      <div className="flex flex-col gap-8">
        {settings.isLoading ? (
          <Spinner />
        ) : settings.data ? (
          <CurrencySettings settings={settings.data} />
        ) : (
          <ErrorBanner error={settings.error} />
        )}
        <Section
          title={t('seasons')}
          lead={t('seasonsLead')}
          actions={
            editable ? (
              <Button size="sm" onClick={() => setEditing('new')}>
                <Plus className="size-4" aria-hidden="true" />
                {t('newSeason')}
              </Button>
            ) : undefined
          }
        >
          {seasons.isLoading ? (
            <Spinner />
          ) : !seasons.data?.length ? (
            <EmptyState title={t('noSeasons')} />
          ) : (
            <ul className="divide-y divide-line">
              {seasons.data.map((s) => (
                <li
                  key={s.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
                >
                  <div>
                    <p className="font-medium">{s.name}</p>
                    <p className="text-sm text-muted">
                      {formatDay(s.startDate, fl)} – {formatDay(s.endDate, fl)}
                    </p>
                  </div>
                  {editable && (
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditing(s)}
                        aria-label={`${tc('edit')} ${s.name}`}
                      >
                        <Pencil className="size-4" aria-hidden="true" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setDeleting(s)}
                        aria-label={`${tc('delete')} ${s.name}`}
                      >
                        <Trash2 className="size-4" aria-hidden="true" />
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>
        {settings.data && (
          <p className="flex items-center gap-2 text-sm text-muted">
            {t('reportingIn')} <CurrencyLabel code={settings.data.baseCurrency} withName />
          </p>
        )}
      </div>
      {editing && (
        <SeasonDialog
          season={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        title={t('deleteSeason')}
        body={deleting ? t('deleteSeasonConfirm', { name: deleting.name }) : ''}
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
