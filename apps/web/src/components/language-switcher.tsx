'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { apiPatch } from '@/lib/api';
import { type Locale, setLocaleCookie } from '@/i18n/locale';
import { cx } from './ui';

/**
 * Switches the interface language. When signed in, the choice is also saved to the profile so it
 * follows the user to other devices.
 */
export function LanguageSwitcher({ signedIn = false, tone = 'default' }: { signedIn?: boolean; tone?: 'default' | 'onTurf' }) {
  const locale = useLocale();
  const t = useTranslations('common');
  const router = useRouter();
  const qc = useQueryClient();
  const [pending, start] = useTransition();

  const choose = (next: Locale) => {
    if (next === locale) return;
    setLocaleCookie(next);
    start(async () => {
      if (signedIn) {
        await apiPatch('/me', { locale: next }).catch(() => undefined);
        await qc.invalidateQueries({ queryKey: ['me'] });
      }
      router.refresh();
    });
  };

  const options: { value: Locale; label: string; lang: string }[] = [
    { value: 'ar', label: t('arabic'), lang: 'ar' },
    { value: 'en', label: t('english'), lang: 'en' },
  ];

  return (
    <div role="group" aria-label={t('language')} className="inline-flex gap-1" aria-busy={pending}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          lang={o.lang}
          aria-pressed={locale === o.value}
          onClick={() => choose(o.value)}
          className={cx(
            'rounded px-2.5 py-1 text-sm transition-colors',
            tone === 'onTurf'
              ? locale === o.value
                ? 'bg-white/15 text-white'
                : 'text-white/70 hover:text-white'
              : locale === o.value
                ? 'bg-turf-soft font-medium text-turf'
                : 'text-muted hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
