'use client';

import {
  type IntegrationDto,
  type IntegrationProvidersDto,
  type MeetingOccurrenceDto,
  type RecurrenceRule,
  WEEKDAYS,
} from '@esports/shared';
import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { api } from './api';

/** Gregorian calendar, Western digits in both languages (see lib/format.ts). */
const intlLocale = (locale: string) => (locale === 'ar' ? 'ar-u-ca-gregory-nu-latn' : 'en-GB');

/** The browser's own time zone ("your time"). */
export const browserTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

export function formatWhen(iso: string, locale: string, timeZone?: string) {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(iso));
}

export function formatTime(iso: string, locale: string, timeZone?: string) {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    hour: '2-digit',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(iso));
}

export function formatDayHeading(dayKey: string, locale: string) {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${dayKey}T12:00:00Z`));
}

/** "2026-10-21" in the viewer's time zone. */
export function localDayKey(iso: string, timeZone = browserTimeZone()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(iso));
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export const isoDate = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

/** Weekday names in the reader's language, Monday first (matches WEEKDAYS). */
export function weekdayNames(locale: string, style: 'short' | 'long' = 'short') {
  const f = new Intl.DateTimeFormat(intlLocale(locale), { weekday: style, timeZone: 'UTC' });
  // 2026-10-19 is a Monday.
  return WEEKDAYS.map((_, i) => f.format(new Date(Date.UTC(2026, 9, 19 + i, 12))));
}

/** "Every 2 weeks on Tue, Thu, 10 times" in the reader's language. */
export function useRecurrenceText() {
  const t = useTranslations('meetings.recurrenceText');
  const locale = useLocale();
  return (rule: RecurrenceRule | null, startLocal: string) => {
    if (!rule) return t('once');
    const names = weekdayNames(locale);
    const days = (rule.byWeekday ?? [])
      .map((d) => names[WEEKDAYS.indexOf(d)])
      .join(locale === 'ar' ? '، ' : ', ');
    const base =
      rule.freq === 'daily'
        ? t('daily', { interval: rule.interval })
        : rule.freq === 'weekly'
          ? t('weekly', { interval: rule.interval, days })
          : t('monthly', { interval: rule.interval, day: Number(startLocal.slice(8, 10)) });
    const end =
      rule.end.type === 'count'
        ? t('count', { count: rule.end.count })
        : t('until', {
            date: new Intl.DateTimeFormat(intlLocale(locale), {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
              timeZone: 'UTC',
            }).format(new Date(`${rule.end.until}T12:00:00Z`)),
          });
    return `${base}${end}`;
  };
}

/** "15 minutes before" / "1 day before". */
export function useReminderLabel() {
  const t = useTranslations('meetings.reminderLabels');
  return (minutes: number) =>
    minutes % 1440 === 0
      ? t('days', { count: minutes / 1440 })
      : minutes % 60 === 0
        ? t('hours', { count: minutes / 60 })
        : t('minutes', { count: minutes });
}

export function useMeetings(
  from: string,
  to: string,
  opts: { mine?: boolean; teamId?: string } = {},
) {
  const q = new URLSearchParams({ from, to });
  if (opts.mine) q.set('mine', 'true');
  if (opts.teamId) q.set('teamId', opts.teamId);
  return useQuery({
    queryKey: ['meetings', 'list', from, to, !!opts.mine, opts.teamId ?? ''],
    queryFn: () => api<MeetingOccurrenceDto[]>(`/meetings?${q.toString()}`),
  });
}

export function useIntegrations() {
  return useQuery({
    queryKey: ['integrations'],
    queryFn: () =>
      api<{ providers: IntegrationProvidersDto; connections: IntegrationDto[] }>('/integrations'),
  });
}

/** Common IANA zones for the picker (the browser's own is always offered first). */
export const COMMON_TIME_ZONES = [
  'Asia/Riyadh',
  'Asia/Dubai',
  'Asia/Kuwait',
  'Asia/Qatar',
  'Asia/Bahrain',
  'Africa/Cairo',
  'Europe/Istanbul',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'America/New_York',
  'America/Los_Angeles',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Asia/Singapore',
  'UTC',
];
