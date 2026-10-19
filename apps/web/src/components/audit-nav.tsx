'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cx } from '@/components/ui';

const TABS = [
  { href: '/dashboard/audit', key: 'activity' },
  { href: '/dashboard/audit/tool-calls', key: 'toolCalls' },
] as const;

/** Sub-navigation for the audit pages: the activity log and the assistants' lookup log. */
export function AuditNav() {
  const t = useTranslations('audit.nav');
  const pathname = usePathname();
  return (
    <nav aria-label={t('label')} className="-mt-2 mb-6 overflow-x-auto border-b border-line">
      <ul className="flex min-w-max gap-1">
        {TABS.map((tab) => {
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
