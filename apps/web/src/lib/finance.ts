'use client';

import {
  type FinanceLocale,
  fl,
  type FinanceSettingsDto,
  formatIsoDate,
  formatMoney,
  type ReportScopeOption,
  type SeasonDto,
  type TournamentDto,
} from '@esports/shared';
import { useQuery } from '@tanstack/react-query';
import { useLocale } from 'next-intl';
import { api, ApiError } from './api';
import { useCan } from './session';

export function useFinanceLocale(): FinanceLocale {
  return useLocale() === 'ar' ? 'ar' : 'en';
}

/** Category, status and report labels shared with the exports (one source for both). */
export function useFinanceLabels() {
  return fl(useFinanceLocale());
}

/** Formats an amount exactly as the exports do ("USD 1,250.00", Western digits). */
export function useMoney() {
  const locale = useFinanceLocale();
  return (amount: string | null | undefined, currency: string) =>
    amount === null || amount === undefined ? '' : formatMoney(amount, currency, locale);
}

export function useFinanceSettings() {
  return useQuery({
    queryKey: ['finance', 'settings'],
    queryFn: () => api<FinanceSettingsDto>('/finance/settings'),
  });
}

export function useSeasons() {
  return useQuery({
    queryKey: ['finance', 'seasons'],
    queryFn: () => api<SeasonDto[]>('/finance/seasons'),
  });
}

/** Report scopes the user can see — also the team list for finance forms and filters. */
export function useFinanceScopes() {
  const can = useCan();
  return useQuery({
    queryKey: ['finance', 'scopes'],
    queryFn: () => api<ReportScopeOption[]>('/finance/reports/scopes'),
    enabled: can('finance.view'),
  });
}

export function useTournaments() {
  const can = useCan();
  return useQuery({
    queryKey: ['tournaments'],
    queryFn: () => api<TournamentDto[]>('/tournaments'),
    enabled: can('tournaments.view'),
  });
}

/** A calendar date ("15 Mar 2026" / "15 مارس 2026"), exactly as the exports print it. */
export const formatDay = (iso: string, locale: FinanceLocale | string) =>
  formatIsoDate(iso, locale === 'ar' ? 'ar' : 'en');

/** Today's date (UTC) as YYYY-MM-DD, for date inputs. */
export const todayIso = () => new Date().toISOString().slice(0, 10);

/** "" → null for optional fields sent to the API. */
export const orNull = (v: string) => (v.trim() === '' ? null : v.trim());

/**
 * Downloads a POST response as a file (exports). The filename comes from the server's
 * Content-Disposition header so it matches what the API audited.
 */
export async function downloadPost(path: string, body: unknown): Promise<void> {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new ApiError(
      res.status,
      (data?.error?.code as never) ?? 'internal_error',
      data?.error?.message ?? res.statusText,
    );
  }
  const blob = await res.blob();
  const name =
    /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'report';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
