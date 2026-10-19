'use client';

import type { ContractDto, ContractSummaryDto, RosterMemberDto, TeamDto } from '@esports/shared';
import { useQuery } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { ContractStatusBadge, ContractsNav } from '@/components/contracts/contracts-nav';
import {
  Badge,
  Button,
  cx,
  Dialog,
  EmptyState,
  ErrorBanner,
  PageHeader,
  Section,
  SelectField,
  Spinner,
  tableClass,
  tdClass,
  thClass,
} from '@/components/ui';
import { api, apiPost } from '@/lib/api';
import { pick, useContractLocale, useContractTypes } from '@/lib/contracts';
import { formatDate } from '@/lib/format';
import { useAction } from '@/lib/mutation';
import { useCan, useCovers } from '@/lib/session';

const VIEWS = ['all', 'drafts', 'approvals', 'approved', 'signed'] as const;
type View = (typeof VIEWS)[number];

function NewContractDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslations('contracts');
  const tc = useTranslations('common');
  const loc = useContractLocale();
  const router = useRouter();
  const covers = useCovers();
  const types = useContractTypes();
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => api<TeamDto[]>('/teams') });
  const usable = (types.data ?? []).filter((x) => !x.archived);
  const myTeams = (teams.data ?? []).filter((x) => covers.team('contracts.create', x));
  const orgWide = covers.department('contracts.create', null);
  const [typeId, setTypeId] = useState('');
  const [teamId, setTeamId] = useState('');
  const [rosterMemberId, setRosterMemberId] = useState('');
  const roster = useQuery({
    queryKey: ['roster', teamId],
    queryFn: () => api<RosterMemberDto[]>(`/teams/${teamId}/roster`),
    enabled: !!teamId,
    retry: false,
  });
  const chosenType = typeId || usable[0]?.id || '';
  const chosenTeam = teamId || (orgWide ? '' : (myTeams[0]?.id ?? ''));
  const create = useAction(
    () =>
      apiPost<ContractDto>('/contracts', {
        contractTypeId: chosenType,
        teamId: chosenTeam || null,
        rosterMemberId: rosterMemberId || null,
      }),
    {
      invalidate: [['contracts']],
      success: t('created'),
      onSuccess: (c) => router.push(`/dashboard/contracts/${c.id}`),
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('newContract')}
      lead={t('newLead')}
      footer={
        <>
          <Button onClick={onClose}>{tc('cancel')}</Button>
          <Button
            variant="primary"
            disabled={!chosenType || create.isPending || (!orgWide && !chosenTeam)}
            onClick={() => create.mutate(undefined)}
          >
            {create.isPending ? tc('saving') : t('createDraft')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <ErrorBanner error={create.error ?? types.error} />
        <SelectField
          label={t('type')}
          value={chosenType}
          onChange={(e) => setTypeId(e.target.value)}
        >
          {usable.map((x) => (
            <option key={x.id} value={x.id}>
              {pick(x.nameEn, x.nameAr, loc)}
            </option>
          ))}
        </SelectField>
        <SelectField
          label={t('team')}
          value={chosenTeam}
          onChange={(e) => {
            setTeamId(e.target.value);
            setRosterMemberId('');
          }}
        >
          {orgWide && <option value="">{t('noTeam')}</option>}
          {myTeams.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </SelectField>
        {chosenTeam && !!roster.data?.length && (
          <SelectField
            label={t('rosterMember')}
            hint={t('rosterHint')}
            value={rosterMemberId}
            onChange={(e) => setRosterMemberId(e.target.value)}
          >
            <option value="">{t('noRosterMember')}</option>
            {roster.data
              .filter((m) => m.active)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.fullName}
                  {m.handle ? ` (${m.handle})` : ''}
                </option>
              ))}
          </SelectField>
        )}
      </div>
    </Dialog>
  );
}

function ContractRows({ rows, view }: { rows: ContractSummaryDto[]; view: View }) {
  const t = useTranslations('contracts');
  const loc = useContractLocale();
  const title = (c: ContractSummaryDto) => c.title || pick(c.typeNameEn, c.typeNameAr, loc);
  return (
    <>
      <div className="hidden overflow-x-auto sm:block">
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>{t('col.number')}</th>
              <th className={thClass}>{t('col.contract')}</th>
              <th className={thClass}>{t('col.team')}</th>
              <th className={thClass}>{t('col.status')}</th>
              <th className={thClass}>{view === 'signed' ? t('col.signed') : t('col.updated')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="hover:bg-panel-2/60">
                <td className={cx(tdClass, 'whitespace-nowrap')}>
                  <Link
                    href={`/dashboard/contracts/${c.id}`}
                    className="ltr-text font-medium text-turf hover:underline"
                  >
                    {c.number}
                  </Link>
                  <span className="ms-2 text-[0.8125rem] text-muted">
                    {t('versionShort', { version: c.currentVersion })}
                  </span>
                </td>
                <td className={tdClass}>
                  <span className="block font-medium">{title(c)}</span>
                  {c.recipientName && (
                    <span className="block text-sm text-muted">{c.recipientName}</span>
                  )}
                </td>
                <td className={cx(tdClass, 'text-muted')}>{c.teamName ?? t('noTeam')}</td>
                <td className={tdClass}>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <ContractStatusBadge status={c.status} />
                    {view !== 'drafts' && c.canDecide && (
                      <Badge tone="amber">{t('decideBadge')}</Badge>
                    )}
                  </span>
                </td>
                <td className={cx(tdClass, 'whitespace-nowrap text-muted')}>
                  {formatDate(view === 'signed' ? c.signedAt : c.updatedAt, loc)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="divide-y divide-line sm:hidden">
        {rows.map((c) => (
          <li key={c.id}>
            <Link
              href={`/dashboard/contracts/${c.id}`}
              className="flex flex-col gap-1 px-5 py-3 hover:bg-panel-2/60"
            >
              <span className="flex items-center justify-between gap-3">
                <span className="ltr-text font-medium text-turf">{c.number}</span>
                <ContractStatusBadge status={c.status} />
              </span>
              <span className="font-medium">{title(c)}</span>
              <span className="text-sm text-muted">
                {[c.recipientName, c.teamName ?? t('noTeam'), formatDate(c.updatedAt, loc)]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              {c.canDecide && (
                <span>
                  <Badge tone="amber">{t('decideBadge')}</Badge>
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

export default function ContractsPage() {
  const t = useTranslations('contracts');
  const can = useCan();
  const onlyApprover =
    can('contracts.approve') && !can('contracts.view') && !can('contracts.create');
  const [view, setView] = useState<View>(onlyApprover ? 'approvals' : 'all');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const params = useMemo(
    () => new URLSearchParams({ view, ...(q.trim() ? { q: q.trim() } : {}) }).toString(),
    [view, q],
  );
  const list = useQuery({
    queryKey: ['contracts', 'list', params],
    queryFn: () => api<ContractSummaryDto[]>(`/contracts?${params}`),
  });
  const rows = list.data ?? [];

  return (
    <>
      <PageHeader
        title={t('title')}
        lead={t('lead')}
        actions={
          can('contracts.create') && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden="true" />
              {t('newContract')}
            </Button>
          )
        }
      />
      <ContractsNav />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div
          role="tablist"
          aria-label={t('title')}
          className="flex flex-wrap gap-1 rounded-lg border border-line bg-panel p-1"
        >
          {VIEWS.map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              onClick={() => setView(v)}
              className={cx(
                'h-8 rounded-md px-3 text-sm',
                view === v ? 'bg-turf text-turf-ink' : 'text-ink hover:bg-panel-2',
              )}
            >
              {t(`views.${v}`)}
            </button>
          ))}
        </div>
        <label className="relative w-full sm:w-72">
          <span className="sr-only">{t('search')}</span>
          <Search
            className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted"
            aria-hidden="true"
          />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="h-10 w-full rounded-md border border-line-strong bg-panel ps-9 pe-3 text-ink placeholder:text-muted/70 focus:border-turf"
          />
        </label>
      </div>
      <Section title={t(`views.${view}`)} lead={t(`viewLead.${view}`)}>
        {list.isLoading ? (
          <Spinner />
        ) : list.error ? (
          <div className="p-5">
            <ErrorBanner error={list.error} />
          </div>
        ) : !rows.length ? (
          <EmptyState title={t(`empty.${view}`)} />
        ) : (
          <ContractRows rows={rows} view={view} />
        )}
      </Section>
      {creating && <NewContractDialog onClose={() => setCreating(false)} />}
    </>
  );
}
