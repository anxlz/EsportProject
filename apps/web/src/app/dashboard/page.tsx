'use client';

import {
  type InvitationDto,
  type MemberDto,
  PERMISSION_DOMAINS,
  PERMISSIONS,
  type ScopeGrant,
  type TeamDto,
} from '@esports/shared';
import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { PageHeader } from '@/components/ui';
import { DotGridBackground } from '@/components/ui/react-bits/dot-grid-background';
import { SpotlightCard } from '@/components/ui/react-bits/spotlight-card';
import { api } from '@/lib/api';
import { useCan, useMe } from '@/lib/session';

function Stat({ value, label, href }: { value: string; label: string; href: string }) {
  return (
    <SpotlightCard href={href} data-motion-item="" className="text-start">
      <span
        data-motion-counter={value}
        className="inline-block text-end text-2xl font-semibold text-ink tabular-nums"
        style={{ minWidth: `${value.length}ch` }}
      >
        {value}
      </span>
      <span className="text-sm text-muted">{label}</span>
    </SpotlightCard>
  );
}

export default function OverviewPage() {
  const me = useMe();
  const can = useCan();
  const locale = useLocale();
  const t = useTranslations('overview');
  const tp = useTranslations('permissions');
  const td = useTranslations('permissionDomains');

  const teams = useQuery({
    queryKey: ['teams'],
    queryFn: () => api<TeamDto[]>('/teams'),
    enabled: can('teams.view'),
  });
  const members = useQuery({
    queryKey: ['members'],
    queryFn: () => api<MemberDto[]>('/members'),
    enabled: can('members.view'),
  });
  const invites = useQuery({
    queryKey: ['invitations'],
    queryFn: () => api<InvitationDto[]>('/invitations'),
    enabled: can('members.view'),
  });

  if (!me.activeOrganization) return null;

  const scopeText = (scope: ScopeGrant): string | null => {
    if (scope.all) return null;
    const parts: string[] = [];
    if (scope.teamIds.length) parts.push(t('scopeTeams', { count: scope.teamIds.length }));
    if (scope.departmentIds.length)
      parts.push(t('scopeDepartments', { count: scope.departmentIds.length }));
    return t('limitedTo', {
      scope: parts.length === 2 ? t('and', { a: parts[0]!, b: parts[1]! }) : (parts[0] ?? ''),
    });
  };

  const stats = [
    can('teams.view') &&
      teams.data && {
        value: String(teams.data.length),
        label: t('teamsVisible', { count: teams.data.length }),
        href: '/dashboard/teams',
      },
    can('members.view') &&
      members.data && {
        value: String(members.data.length),
        label: t('members', { count: members.data.length }),
        href: '/dashboard/members',
      },
    can('members.view') &&
      invites.data && {
        value: String(invites.data.length),
        label: t('pendingInvites', { count: invites.data.length }),
        href: '/dashboard/members',
      },
  ].filter(Boolean) as { value: string; label: string; href: string }[];

  return (
    <div className="relative isolate">
      <DotGridBackground />
      <PageHeader
        title={t('greeting', { name: me.user.displayName })}
        lead={me.activeOrganization.name}
      />

      {stats.length > 0 && (
        <div
          data-motion-stagger
          className="mb-8 grid divide-y divide-line overflow-hidden rounded-lg border border-line bg-panel sm:grid-cols-3 sm:divide-x sm:divide-y-0"
        >
          {stats.map((s) => (
            <Stat key={s.label} {...s} />
          ))}
        </div>
      )}

      <section data-motion-reveal aria-labelledby="access-heading" className="max-w-3xl">
        <h2 id="access-heading" className="mb-3 text-lg font-semibold">
          {t('yourAccess')}
        </h2>
        {me.isOwner ? (
          <p className="text-muted">{t('ownerAccess')}</p>
        ) : me.permissions.length === 0 ? (
          <p className="text-muted">{t('noAccess')}</p>
        ) : (
          <dl className="divide-y divide-line rounded-lg border border-line bg-panel">
            {PERMISSION_DOMAINS.map((domain) => {
              const held = me.permissions.filter((p) => PERMISSIONS[p.key].domain === domain);
              if (!held.length) return null;
              return (
                <div key={domain} className="grid gap-1 px-5 py-3 sm:grid-cols-[10rem_1fr]">
                  <dt className="font-medium">{td(domain)}</dt>
                  <dd>
                    <ul className="flex flex-col gap-0.5 text-[0.9375rem]">
                      {held.map((p) => {
                        const limit = scopeText(p.scope);
                        return (
                          <li key={p.key}>
                            {tp(p.key)}
                            {limit && (
                              <span className="text-muted">
                                {locale === 'ar' ? '، ' : ', '}
                                {limit}
                              </span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </dd>
                </div>
              );
            })}
          </dl>
        )}
      </section>
    </div>
  );
}
