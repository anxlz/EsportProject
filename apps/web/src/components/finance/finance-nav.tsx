'use client';

import type { PermissionKey } from '@esports/shared';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cx } from '@/components/ui';
import { useCan } from '@/lib/session';

const TABS: { href: string; key: string; anyOf: PermissionKey[] }[] = [
  { href: '/dashboard/finance', key: 'report', anyOf: ['finance.view'] },
  {
    href: '/dashboard/finance/expenses',
    key: 'expenses',
    anyOf: ['finance.view', 'finance.create'],
  },
  { href: '/dashboard/finance/revenue', key: 'revenue', anyOf: ['finance.view', 'finance.create'] },
  { href: '/dashboard/finance/budgets', key: 'budgets', anyOf: ['finance.view'] },
  {
    href: '/dashboard/finance/settings',
    key: 'settings',
    anyOf: ['finance.view', 'finance.configure'],
  },
];

/** Sub-navigation shared by the finance pages. */
export function FinanceNav() {
  const t = useTranslations('finance.nav');
  const can = useCan();
  const pathname = usePathname();
  return (
    <nav aria-label={t('label')} className="-mt-2 mb-6 overflow-x-auto border-b border-line">
      <ul className="flex min-w-max gap-1">
        {TABS.filter((tab) => tab.anyOf.some(can)).map((tab) => {
          const active = pathname === tab.href;
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
