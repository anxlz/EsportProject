'use client';

import type { ContractStatus, PermissionKey } from '@esports/shared';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Badge, cx } from '@/components/ui';
import { useContractLabels } from '@/lib/contracts';
import { useCan } from '@/lib/session';

const TABS: { href: string; key: string; anyOf: PermissionKey[] }[] = [
  {
    href: '/dashboard/contracts',
    key: 'list',
    anyOf: ['contracts.view', 'contracts.approve', 'contracts.create'],
  },
  {
    href: '/dashboard/contracts/templates',
    key: 'templates',
    anyOf: ['contracts.view', 'contracts.create', 'contracts.edit', 'contracts.manage_templates'],
  },
  {
    href: '/dashboard/contracts/settings',
    key: 'settings',
    anyOf: ['contracts.manage_templates', 'org.settings.edit_sensitive'],
  },
];

/** Sub-navigation shared by the contract pages. */
export function ContractsNav() {
  const t = useTranslations('contracts.nav');
  const can = useCan();
  const pathname = usePathname();
  const tabs = TABS.filter((tab) => tab.anyOf.some(can));
  if (tabs.length < 2) return null;
  return (
    <nav aria-label={t('label')} className="-mt-2 mb-6 overflow-x-auto border-b border-line">
      <ul className="flex min-w-max gap-1">
        {tabs.map((tab) => {
          const active =
            tab.key === 'list'
              ? !pathname.startsWith('/dashboard/contracts/templates') &&
                !pathname.startsWith('/dashboard/contracts/settings')
              : pathname.startsWith(tab.href);
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                className={cx(
                  '-mb-px inline-flex h-10 items-center border-b-2 px-3 text-[0.9375rem]',
                  active
                    ? 'border-turf font-medium text-ink'
                    : 'border-transparent text-muted hover:text-ink',
                )}
              >
                {t(tab.key)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

const STATUS_TONE: Record<ContractStatus, 'neutral' | 'turf' | 'amber' | 'brick'> = {
  draft: 'neutral',
  pending_approval: 'amber',
  changes_requested: 'brick',
  approved: 'turf',
  awaiting_signatures: 'amber',
  signed: 'turf',
  cancelled: 'neutral',
  terminated: 'brick',
};

export function ContractStatusBadge({ status }: { status: ContractStatus }) {
  const L = useContractLabels();
  return <Badge tone={STATUS_TONE[status]}>{L.status[status]}</Badge>;
}

/** A sandboxed frame for the self-contained document HTML: no scripts, no network. */
export function DocumentFrame({ html, title }: { html: string | undefined; title: string }) {
  return (
    <iframe
      title={title}
      sandbox=""
      srcDoc={html ?? ''}
      className="h-[78dvh] min-h-[28rem] w-full rounded-md border border-line bg-panel-2"
    />
  );
}
