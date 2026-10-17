'use client';

import { CURRENCIES } from '@esports/shared';
import {
  AE,
  AU,
  BH,
  BR,
  CA,
  CH,
  CN,
  DK,
  EG,
  EU,
  GB,
  ID,
  IN,
  JO,
  JP,
  KR,
  KW,
  MA,
  NO,
  OM,
  PH,
  PK,
  PL,
  QA,
  SA,
  SE,
  SG,
  TR,
  US,
} from 'country-flag-icons/react/3x2';
import { useLocale } from 'next-intl';
import { useMoney } from '@/lib/finance';

const FLAGS: Record<string, typeof US> = {
  AE,
  AU,
  BH,
  BR,
  CA,
  CH,
  CN,
  DK,
  EG,
  EU,
  GB,
  ID,
  IN,
  JO,
  JP,
  KR,
  KW,
  MA,
  NO,
  OM,
  PH,
  PK,
  PL,
  QA,
  SA,
  SE,
  SG,
  TR,
  US,
};

/** Decorative flag next to a currency code (the code itself always carries the meaning). */
export function CurrencyFlag({ code }: { code: string }) {
  const info = CURRENCIES.find((c) => c.code === code);
  const Flag = info ? FLAGS[info.flag] : undefined;
  if (!Flag) return null;
  return (
    <Flag
      aria-hidden="true"
      className="inline-block h-3 w-[1.125rem] shrink-0 rounded-[2px] ring-1 ring-line"
    />
  );
}

export function CurrencyLabel({ code, withName }: { code: string; withName?: boolean }) {
  const locale = useLocale();
  const info = CURRENCIES.find((c) => c.code === code);
  return (
    <span className="inline-flex items-center gap-1.5">
      <CurrencyFlag code={code} />
      <span className="ltr-text">{code}</span>
      {withName && info && (
        <span className="text-muted">{locale === 'ar' ? info.nameAr : info.nameEn}</span>
      )}
    </span>
  );
}

/** An amount formatted exactly like the exports. */
export function Money({
  amount,
  currency,
  className,
}: {
  amount: string | null | undefined;
  currency: string;
  className?: string;
}) {
  const fmt = useMoney();
  return (
    <span className={`tabular-nums whitespace-nowrap ${className ?? ''}`}>
      {fmt(amount, currency)}
    </span>
  );
}
