'use client';

import { useTranslations } from 'next-intl';
import { useParams } from 'next/navigation';
import { Suspense } from 'react';
import { AssistantWorkspace } from '@/components/assistants/workspace';
import { EmptyState, PageHeader, Spinner } from '@/components/ui';
import { isAssistantKey } from '@/lib/assistants';

export default function AssistantPage() {
  const { assistant } = useParams<{ assistant: string }>();
  const t = useTranslations('assistants');
  if (!isAssistantKey(assistant))
    return (
      <>
        <PageHeader title={t('title')} />
        <div className="rounded-lg border border-line bg-panel">
          <EmptyState title={t('unknown')} />
        </div>
      </>
    );
  return (
    <Suspense fallback={<Spinner />}>
      <AssistantWorkspace key={assistant} assistant={assistant} />
    </Suspense>
  );
}
