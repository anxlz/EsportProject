'use client';

import {
  monthlyEquivalent,
  money,
  PAY_FREQUENCIES,
  ROSTER_ROLES,
  rosterMemberCreateSchema,
  type RosterMemberDto,
  type TeamDto,
} from '@esports/shared';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, BarChart3, Download, Pencil, Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Money } from '@/components/finance/money';
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
import { api, apiDelete, apiPatch, apiPost } from '@/lib/api';
import {
  formatDay,
  orNull,
  useFinanceLabels,
  useFinanceLocale,
  useFinanceSettings,
  useMoney,
} from '@/lib/finance';
import { invalidFields } from '@/lib/form';
import { useAction } from '@/lib/mutation';
import { useCovers } from '@/lib/session';

interface PayForm {
  enabled: boolean;
  currency: string;
  amount: string;
  offSeasonAmount: string;
  frequency: string;
  contractStart: string;
  contractEnd: string;
  signingBonus: string;
  notes: string;
}

function MemberDialog({
  team,
  member,
  onClose,
}: {
  team: { id: string; departmentId: string | null };
  member: RosterMemberDto | null;
  onClose: () => void;
}) {
  const t = useTranslations('roster');
  const tc = useTranslations('common');
  const L = useFinanceLabels();
  const covers = useCovers();
  const settings = useFinanceSettings();
  const canPay = covers.team('finance.edit', team);
  const seesPay = covers.team('finance.view', team);
  const c = member?.compensation ?? null;
  const [form, setForm] = useState({
    fullName: member?.fullName ?? '',
    handle: member?.handle ?? '',
    role: member?.role ?? 'starter',
    position: member?.position ?? '',
    nationality: member?.nationality ?? '',
    dateOfBirth: member?.dateOfBirth ?? '',
    email: member?.email ?? '',
    phone: member?.phone ?? '',
    joinedOn: member?.joinedOn ?? '',
    leftOn: member?.leftOn ?? '',
    active: member?.active ?? true,
    notes: member?.notes ?? '',
  });
  const [pay, setPay] = useState<PayForm>({
    enabled: !!c,
    currency: c?.currency ?? settings.data?.baseCurrency ?? 'USD',
    amount: c?.amount ?? '',
    offSeasonAmount: c?.offSeasonAmount ?? '',
    frequency: c?.frequency ?? 'monthly',
    contractStart: c?.contractStart ?? '',
    contractEnd: c?.contractEnd ?? '',
    signingBonus: c?.signingBonus ?? '',
    notes: c?.notes ?? '',
  });
  const [touched, setTouched] = useState(false);
  const payBody = () =>
    pay.enabled
      ? {
          currency: pay.currency,
          amount: pay.amount.trim(),
          offSeasonAmount: orNull(pay.offSeasonAmount),
          frequency: pay.frequency,
          contractStart: pay.contractStart || null,
          contractEnd: pay.contractEnd || null,
          signingBonus: orNull(pay.signingBonus),
          notes: orNull(pay.notes),
        }
      : null;
  const body = () => ({
    teamId: team.id,
    fullName: form.fullName.trim(),
    handle: orNull(form.handle),
    role: form.role,
    position: orNull(form.position),
    nationality: orNull(form.nationality),
    dateOfBirth: form.dateOfBirth || null,
    email: orNull(form.email),
    phone: orNull(form.phone),
    joinedOn: form.joinedOn || null,
    leftOn: form.leftOn || null,
    active: form.active,
    notes: orNull(form.notes),
    // Pay terms are only sent by someone allowed to change them.
    ...(canPay ? { compensation: payBody() } : {}),
  });
  const invalid = invalidFields(rosterMemberCreateSchema, body());
  const save = useAction(
    () => {
      const b = body();
      if (!member) return apiPost('/roster-members', b);
      const { teamId: _ignored, ...rest } = b;
      return apiPatch(`/roster-members/${member.id}`, rest);
    },
    {
      invalidate: [['roster', team.id], ['finance']],
      success: member ? t('saved') : t('created'),
      onSuccess: onClose,
    },
  );
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const setP = (k: keyof PayForm) => (e: { target: { value: string } }) =>
    setPay((p) => ({ ...p, [k]: e.target.value.replace(',', '.') }));
  const enabledCurrencies = settings.data?.enabledCurrencies ?? [pay.currency];

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={member ? t('edit') : t('new')}
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
            {save.isPending ? tc('saving') : member ? tc('saveChanges') : tc('create')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <ErrorBanner error={save.error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label={t('fullName')}
            value={form.fullName}
            onChange={set('fullName')}
            autoFocus
            error={touched && invalid.has('fullName') ? tc('required') : null}
          />
          <TextField label={t('handle')} optional value={form.handle} onChange={set('handle')} />
          <SelectField label={t('role')} value={form.role} onChange={set('role')}>
            {ROSTER_ROLES.map((r) => (
              <option key={r} value={r}>
                {L.rosterRole[r]}
              </option>
            ))}
          </SelectField>
          <TextField
            label={t('position')}
            optional
            value={form.position}
            onChange={set('position')}
          />
          <TextField
            label={t('nationality')}
            optional
            value={form.nationality}
            onChange={set('nationality')}
          />
          <TextField
            label={t('dateOfBirth')}
            optional
            type="date"
            value={form.dateOfBirth}
            onChange={set('dateOfBirth')}
          />
          <TextField
            label={tc('email')}
            optional
            type="email"
            className="ltr-text"
            value={form.email}
            onChange={set('email')}
            error={touched && invalid.has('email') ? tc('invalidEmail') : null}
          />
          <TextField
            label={t('phone')}
            optional
            type="tel"
            className="ltr-text"
            value={form.phone}
            onChange={set('phone')}
          />
          <TextField
            label={t('joinedOn')}
            optional
            type="date"
            value={form.joinedOn}
            onChange={set('joinedOn')}
          />
          <TextField
            label={t('leftOn')}
            optional
            type="date"
            value={form.leftOn}
            onChange={set('leftOn')}
          />
        </div>
        <Checkbox
          label={t('activeLabel')}
          hint={t('activeHint')}
          checked={form.active}
          onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))}
        />
        <TextArea label={t('notes')} optional value={form.notes} onChange={set('notes')} />

        {seesPay && (
          <fieldset
            className="flex flex-col gap-4 rounded-md border border-line p-4"
            disabled={!canPay}
          >
            <legend className="px-1 text-sm font-medium">{t('pay')}</legend>
            {!canPay && <p className="text-[0.8125rem] text-muted">{t('payReadOnly')}</p>}
            <Checkbox
              label={t('hasPay')}
              checked={pay.enabled}
              onChange={(e) => setPay((p) => ({ ...p, enabled: e.target.checked }))}
            />
            {pay.enabled && (
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  label={t('amount')}
                  inputMode="decimal"
                  className="ltr-text"
                  value={pay.amount}
                  onChange={setP('amount')}
                  error={
                    touched && invalid.has('compensation') && !pay.amount
                      ? t('amountInvalid')
                      : null
                  }
                />
                <SelectField label={t('currency')} value={pay.currency} onChange={setP('currency')}>
                  {(enabledCurrencies.includes(pay.currency)
                    ? enabledCurrencies
                    : [...enabledCurrencies, pay.currency]
                  ).map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </SelectField>
                <SelectField
                  label={t('frequency')}
                  value={pay.frequency}
                  onChange={setP('frequency')}
                >
                  {PAY_FREQUENCIES.map((f) => (
                    <option key={f} value={f}>
                      {L.payFrequency[f]}
                    </option>
                  ))}
                </SelectField>
                <TextField
                  label={t('offSeasonAmount')}
                  optional
                  hint={t('offSeasonHint')}
                  inputMode="decimal"
                  className="ltr-text"
                  value={pay.offSeasonAmount}
                  onChange={setP('offSeasonAmount')}
                />
                <TextField
                  label={t('contractStart')}
                  optional
                  type="date"
                  value={pay.contractStart}
                  onChange={setP('contractStart')}
                />
                <TextField
                  label={t('contractEnd')}
                  optional
                  type="date"
                  value={pay.contractEnd}
                  onChange={setP('contractEnd')}
                />
                <TextField
                  label={t('signingBonus')}
                  optional
                  inputMode="decimal"
                  className="ltr-text"
                  value={pay.signingBonus}
                  onChange={setP('signingBonus')}
                />
                <TextField
                  label={t('payNotes')}
                  optional
                  value={pay.notes}
                  onChange={setP('notes')}
                />
              </div>
            )}
            {touched && invalid.has('compensation') && (
              <p className="text-[0.8125rem] text-brick" role="alert">
                {t('payInvalid')}
              </p>
            )}
          </fieldset>
        )}
      </div>
    </Dialog>
  );
}

export default function TeamDetailPage() {
  const { teamId } = useParams<{ teamId: string }>();
  const t = useTranslations('roster');
  const tc = useTranslations('common');
  const L = useFinanceLabels();
  const fl = useFinanceLocale();
  const fmt = useMoney();
  const covers = useCovers();
  const team = useQuery({
    queryKey: ['teams', teamId],
    queryFn: () => api<TeamDto>(`/teams/${teamId}`),
  });
  const ref = team.data ? { id: team.data.id, departmentId: team.data.departmentId } : null;
  const roster = useQuery({
    queryKey: ['roster', teamId],
    queryFn: () => api<RosterMemberDto[]>(`/teams/${teamId}/roster`),
    enabled: !!ref && (covers.team('rosters.view', ref) || covers.team('finance.view', ref)),
  });
  const [editing, setEditing] = useState<RosterMemberDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<RosterMemberDto | null>(null);
  const remove = useAction((id: string) => apiDelete(`/roster-members/${id}`), {
    invalidate: [['roster', teamId]],
    success: t('deleted'),
    onSuccess: () => setDeleting(null),
  });

  if (team.isLoading) return <Spinner />;
  if (team.error || !team.data || !ref) return <ErrorBanner error={team.error} />;
  const seesPay = covers.team('finance.view', ref);
  const members = roster.data ?? [];
  const groups = [
    { key: 'players', roles: ['starter', 'substitute'] },
    { key: 'staff', roles: ['head_coach', 'assistant_coach', 'analyst', 'manager', 'staff'] },
  ];

  return (
    <>
      <Link
        href="/dashboard/teams"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"
      >
        <ArrowLeft className="size-4 rtl:-scale-x-100" aria-hidden="true" />
        {t('backToTeams')}
      </Link>
      <PageHeader
        title={team.data.name}
        lead={
          [team.data.gameName, team.data.departmentName, team.data.region]
            .filter(Boolean)
            .join(' · ') || undefined
        }
        actions={
          <>
            {seesPay && (
              <Link
                href={`/dashboard/finance?scope=team&id=${team.data.id}`}
                className="inline-flex h-10 items-center gap-2 rounded-md border border-line-strong bg-panel px-4 font-medium hover:bg-panel-2"
              >
                <BarChart3 className="size-4" aria-hidden="true" />
                {t('financeReport')}
              </Link>
            )}
            {covers.team('rosters.export', ref) && (
              <a
                href={`/api/teams/${team.data.id}/roster/export.csv?locale=${fl}`}
                download
                className="inline-flex h-10 items-center gap-2 rounded-md border border-line-strong bg-panel px-4 font-medium hover:bg-panel-2"
              >
                <Download className="size-4" aria-hidden="true" />
                {t('exportCsv')}
              </a>
            )}
            {covers.team('rosters.create', ref) && (
              <Button variant="primary" onClick={() => setEditing('new')}>
                <Plus className="size-4" aria-hidden="true" />
                {t('new')}
              </Button>
            )}
          </>
        }
      />
      {!roster.isLoading && !roster.data && !roster.error ? (
        <p className="text-muted">{t('noAccess')}</p>
      ) : roster.isLoading ? (
        <Spinner />
      ) : roster.error ? (
        <ErrorBanner error={roster.error} />
      ) : (
        <div className="flex flex-col gap-8">
          {groups.map((g) => {
            const rows = members.filter((m) => g.roles.includes(m.role));
            return (
              <Section
                key={g.key}
                title={t(`groups.${g.key}`)}
                lead={seesPay ? t('payLead') : undefined}
              >
                {!rows.length ? (
                  <EmptyState title={t('emptyGroup')} />
                ) : (
                  <div className="relative overflow-x-auto">
                    <table className={tableClass}>
                      <thead>
                        <tr>
                          <th className={thClass}>{tc('name')}</th>
                          <th className={thClass}>{t('role')}</th>
                          <th className={thClass}>{t('joinedOn')}</th>
                          {seesPay && <th className={thEndClass}>{t('pay')}</th>}
                          {seesPay && <th className={thClass}>{t('contract')}</th>}
                          <th className={thClass}>
                            <span className="sr-only">{tc('actions')}</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((m) => {
                          const comp = m.compensation;
                          const monthly = comp
                            ? monthlyEquivalent(comp.amount, comp.frequency)
                            : null;
                          return (
                            <tr key={m.id} className={m.active ? '' : 'text-muted'}>
                              <td className={tdClass}>
                                <span className="font-medium">{m.fullName}</span>
                                {m.handle && (
                                  <>
                                    {' '}
                                    <bdi className="text-muted">“{m.handle}”</bdi>
                                  </>
                                )}
                                {!m.active && (
                                  <span className="ms-2">
                                    <Badge>{t('left')}</Badge>
                                  </span>
                                )}
                                {(m.position || m.nationality) && (
                                  <span className="block text-sm text-muted">
                                    {[m.position, m.nationality].filter(Boolean).join(' · ')}
                                  </span>
                                )}
                              </td>
                              <td className={tdClass}>{L.rosterRole[m.role]}</td>
                              <td className={`${tdClass} whitespace-nowrap`}>
                                {m.joinedOn ? formatDay(m.joinedOn, fl) : '—'}
                              </td>
                              {seesPay && (
                                <td className={`${tdClass} text-end`}>
                                  {comp ? (
                                    <>
                                      <Money
                                        amount={comp.amount}
                                        currency={comp.currency}
                                        className="font-medium"
                                      />
                                      <span className="block text-[0.8125rem] text-muted">
                                        {L.payFrequency[comp.frequency]}
                                        {monthly && comp.frequency !== 'monthly'
                                          ? ` · ${t('perMonth', { amount: fmt(money(monthly, comp.currency), comp.currency) })}`
                                          : ''}
                                      </span>
                                    </>
                                  ) : (
                                    <span className="text-muted">{t('noPay')}</span>
                                  )}
                                </td>
                              )}
                              {seesPay && (
                                <td className={`${tdClass} text-sm whitespace-nowrap`}>
                                  {comp?.contractStart || comp?.contractEnd
                                    ? `${comp.contractStart ? formatDay(comp.contractStart, fl) : '…'} – ${comp.contractEnd ? formatDay(comp.contractEnd, fl) : '…'}`
                                    : '—'}
                                </td>
                              )}
                              <td className={`${tdClass} text-end whitespace-nowrap`}>
                                {covers.team('rosters.edit', ref) && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => setEditing(m)}
                                    aria-label={`${tc('edit')} ${m.fullName}`}
                                  >
                                    <Pencil className="size-4" aria-hidden="true" />
                                  </Button>
                                )}
                                {covers.team('rosters.delete', ref) && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => setDeleting(m)}
                                    aria-label={`${tc('delete')} ${m.fullName}`}
                                  >
                                    <Trash2 className="size-4" aria-hidden="true" />
                                  </Button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </Section>
            );
          })}
        </div>
      )}
      {editing && (
        <MemberDialog
          team={ref}
          member={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        title={t('delete')}
        body={deleting ? t('deleteConfirm', { name: deleting.fullName }) : ''}
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
