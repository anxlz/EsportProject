'use client';

import { ASSISTANT_KEYS } from '@esports/shared';
import { ArrowRight, CheckCircle2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { NotConfiguredBanner } from '@/components/assistants/workspace';
import { Badge, cx, ErrorBanner, PageHeader } from '@/components/ui';
import { ASSISTANT_ICONS, useAssistantsOverview, useCanUseAssistant } from '@/lib/assistants';

export default function AssistantsPage() {
  const t = useTranslations('assistants');
  const overview = useAssistantsOverview();
  const canUse = useCanUseAssistant();
  const rules = ['proposalOnly', 'yourData', 'citations', 'language', 'log'] as const;

  return (
    <>
      <PageHeader title={t('title')} lead={t('lead')} />
      <div className="flex flex-col gap-6">
        <ErrorBanner error={overview.error} />
        {overview.data && !overview.data.configured && <NotConfiguredBanner />}
        {overview.data?.configured && overview.data.model && (
          <p className="text-sm text-muted">{t('provider', { model: overview.data.model })}</p>
        )}

        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {ASSISTANT_KEYS.map((key) => {
            const Icon = ASSISTANT_ICONS[key];
            const allowed = canUse(key);
            const body = (
              <>
                <div className="flex items-start justify-between gap-3">
                  <span className="inline-flex size-10 items-center justify-center rounded-md bg-turf-soft text-turf">
                    <Icon className="size-5" aria-hidden="true" />
                  </span>
                  {!allowed && <Badge>{t('noAccess')}</Badge>}
                </div>
                <h2 className="mt-3 font-semibold">{t(`names.${key}`)}</h2>
                <p className="mt-1 flex-1 text-sm text-muted">{t(`descriptions.${key}`)}</p>
                {allowed && (
                  <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-turf">
                    {t('open')}
                    <ArrowRight className="size-4 rtl:-scale-x-100" aria-hidden="true" />
                  </span>
                )}
              </>
            );
            const box = 'flex h-full flex-col rounded-lg border border-line bg-panel p-5';
            return (
              <li key={key}>
                {allowed ? (
                  <Link
                    href={`/dashboard/assistants/${key}`}
                    className={cx(box, 'transition-colors hover:border-turf')}
                  >
                    {body}
                  </Link>
                ) : (
                  <div className={cx(box, 'opacity-70')}>{body}</div>
                )}
              </li>
            );
          })}
        </ul>

        <section className="rounded-lg border border-line bg-panel p-5">
          <h2 className="font-semibold">{t('rules.title')}</h2>
          <ul className="mt-3 flex flex-col gap-2.5">
            {rules.map((r) => (
              <li key={r} className="flex gap-2.5 text-sm">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-turf" aria-hidden="true" />
                <span>{t(`rules.${r}`)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-[0.8125rem] text-muted">{t('confidenceHelp')}</p>
        </section>
      </div>
    </>
  );
}
