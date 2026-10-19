import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

/** The signer's page: no account, never indexed, and the token in the URL never leaks. */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('signPage');
  return {
    title: t('title'),
    robots: { index: false, follow: false },
    referrer: 'no-referrer',
  };
}

export default function SignLayout({ children }: { children: ReactNode }) {
  return children;
}
