'use client';

import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { LanguageSwitcher } from './language-switcher';

/**
 * Tournament bracket drawn as line work: eight entrants narrowing to a final. It is the one
 * decorative element in the product, used only on the signed-out screens.
 */
function Bracket() {
  const rounds = [8, 4, 2, 1];
  const colW = 92;
  const h = 520;
  const paths: string[] = [];
  rounds.forEach((n, r) => {
    const gap = h / n;
    for (let i = 0; i < n; i++) {
      const y = gap * i + gap / 2;
      const x0 = r * colW;
      paths.push(`M${x0} ${y} H${x0 + colW * 0.62}`);
      if (r < rounds.length - 1 && i % 2 === 0) {
        const yNext = gap * (i + 1) + gap / 2;
        const xj = x0 + colW * 0.62;
        paths.push(`M${xj} ${y} V${yNext}`);
        paths.push(`M${xj} ${(y + yNext) / 2} H${x0 + colW}`);
      }
    }
  });
  return (
    <svg
      viewBox={`0 0 ${colW * rounds.length} ${h}`}
      className="h-full w-full rtl:-scale-x-100"
      fill="none"
      aria-hidden="true"
      preserveAspectRatio="xMidYMid meet"
    >
      {paths.map((d, i) => (
        <path key={i} d={d} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      ))}
      <circle cx={colW * 3 + colW * 0.62} cy={h / 2} r="7" fill="var(--amber)" />
    </svg>
  );
}

export function AuthShell({ children }: { children: ReactNode }) {
  const t = useTranslations('app');
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
      <main className="flex flex-col px-5 py-6 sm:px-10">
        <div className="flex items-center justify-between gap-4">
          <span className="font-semibold text-ink lg:invisible">{t('name')}</span>
          <LanguageSwitcher />
        </div>
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-10">
          {children}
        </div>
      </main>
      <aside className="relative hidden overflow-hidden bg-turf text-turf-ink lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div className="relative z-10 max-w-sm">
          <p className="text-3xl leading-tight font-semibold">{t('name')}</p>
          <p className="mt-3 text-turf-ink/75">{t('tagline')}</p>
        </div>
        <div className="absolute top-52 bottom-12 end-0 w-[66%] text-turf-ink/20">
          <Bracket />
        </div>
      </aside>
    </div>
  );
}
