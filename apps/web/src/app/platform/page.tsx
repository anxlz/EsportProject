'use client';

import type { MemberDto, PlatformOrganizationDto } from '@esports/shared';
import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import {
  Badge,
  Button,
  ErrorBanner,
  PageHeader,
  Section,
  Spinner,
  tableClass,
  tdClass,
  thClass,
} from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useMe } from '@/lib/session';

function OrgMembers({ org, onBack }: { org: PlatformOrganizationDto; onBack: () => void }) {
  const t = useTranslations('platform');
  const tc = useTranslations('common');
  const tm = useTranslations('members');
  const members = useQuery({
    queryKey: ['platform', 'members', org.id],
    queryFn: () => api<MemberDto[]>(`/platform/organizations/${org.id}/members`),
  });
  return (
    <>
      <PageHeader
        title={t('membersOf', { name: org.name })}
        actions={<Button onClick={onBack}>{t('back')}</Button>}
      />
      <Section title={tm('title')}>
        {members.error && (
          <div className="p-5">
            <ErrorBanner error={members.error} />
          </div>
        )}
        {members.isLoading ? (
          <Spinner />
        ) : (
          <ul className="divide-y divide-line">
            {(members.data ?? []).map((m) => (
              <li
                key={m.userId}
                className="flex flex-wrap items-center justify-between gap-2 px-5 py-3"
              >
                <div>
                  <p className="font-medium">{m.displayName}</p>
                  <p className="ltr-text text-sm text-muted">{m.email}</p>
                </div>
                <div className="flex gap-1.5">
                  {m.isOwner && <Badge tone="turf">{tm('owner')}</Badge>}
                  <Badge tone={m.status === 'active' ? 'neutral' : 'brick'}>
                    {m.status === 'active' ? tc('active') : tc('suspended')}
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

export default function PlatformPage() {
  const t = useTranslations('platform');
  const locale = useLocale();
  const me = useMe();
  const [selected, setSelected] = useState<PlatformOrganizationDto | null>(null);
  const orgs = useQuery({
    queryKey: ['platform', 'organizations'],
    queryFn: () => api<PlatformOrganizationDto[]>('/platform/organizations'),
    enabled: me.isPlatformAdmin,
  });

  if (!me.isPlatformAdmin)
    return <ErrorBanner error={new ApiError(403, 'forbidden', 'forbidden')} />;
  if (selected) return <OrgMembers org={selected} onBack={() => setSelected(null)} />;

  return (
    <>
      <PageHeader title={t('title')} lead={t('lead')} />
      <Section title={t('organizations')}>
        {orgs.isLoading ? (
          <Spinner />
        ) : (
          <div className="relative overflow-x-auto">
            <ErrorBanner error={orgs.error} />
            <table className={tableClass}>
              <thead>
                <tr>
                  <th className={thClass}>{t('organizations')}</th>
                  <th className={thClass}>{t('members')}</th>
                  <th className={thClass}>{t('owners')}</th>
                  <th className={thClass}>{t('created')}</th>
                  <th className={thClass} />
                </tr>
              </thead>
              <tbody>
                {(orgs.data ?? []).map((o) => (
                  <tr key={o.id}>
                    <td className={tdClass}>
                      <p className="font-medium">{o.name}</p>
                      <p className="ltr-text text-sm text-muted">{o.slug}</p>
                    </td>
                    <td className={tdClass}>
                      {o.activeMemberCount} / {o.memberCount}
                    </td>
                    <td className={`${tdClass} ltr-text text-sm`}>{o.ownerEmails.join(', ')}</td>
                    <td className={`${tdClass} whitespace-nowrap`}>
                      {formatDate(o.createdAt, locale)}
                    </td>
                    <td className={`${tdClass} text-end`}>
                      <Button size="sm" variant="ghost" onClick={() => setSelected(o)}>
                        {t('viewMembers')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}
