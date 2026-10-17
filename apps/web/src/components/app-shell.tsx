'use client';

import type { MeResponse, PermissionKey } from '@esports/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  Building2,
  CalendarDays,
  FileSignature,
  Gamepad2,
  LayoutDashboard,
  LogOut,
  Menu,
  ScrollText,
  Settings,
  ShieldCheck,
  Trophy,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { api, ApiError, apiPost } from '@/lib/api';
import { MeProvider, useMeQuery } from '@/lib/session';
import { LanguageSwitcher } from './language-switcher';
import { cx, Spinner } from './ui';

interface NavItem {
  href: string;
  label: string;
  icon: typeof Users;
  /** Shown when the user holds ANY of these (UI hint only — the API enforces). */
  anyOf?: PermissionKey[];
  platformOnly?: boolean;
  needsOrg?: boolean;
}

function useNav(me: MeResponse): NavItem[] {
  const t = useTranslations('nav');
  const has = (keys?: PermissionKey[]) =>
    !keys || keys.some((k) => me.permissions.some((p) => p.key === k));
  const items: NavItem[] = [
    { href: '/dashboard', label: t('overview'), icon: LayoutDashboard, needsOrg: true },
    {
      href: '/dashboard/teams',
      label: t('teams'),
      icon: Trophy,
      anyOf: ['teams.view', 'departments.view'],
      needsOrg: true,
    },
    {
      href: '/dashboard/finance',
      label: t('finance'),
      icon: Wallet,
      anyOf: ['finance.view', 'finance.create', 'finance.configure'],
      needsOrg: true,
    },
    {
      href: '/dashboard/contracts',
      label: t('contracts'),
      icon: FileSignature,
      anyOf: [
        'contracts.view',
        'contracts.create',
        'contracts.approve',
        'contracts.manage_templates',
      ],
      needsOrg: true,
    },
    {
      href: '/dashboard/tournaments',
      label: t('tournaments'),
      icon: CalendarDays,
      anyOf: ['tournaments.view'],
      needsOrg: true,
    },
    {
      href: '/dashboard/games',
      label: t('games'),
      icon: Gamepad2,
      anyOf: ['games.view'],
      needsOrg: true,
    },
    {
      href: '/dashboard/members',
      label: t('members'),
      icon: Users,
      anyOf: ['members.view'],
      needsOrg: true,
    },
    {
      href: '/dashboard/roles',
      label: t('roles'),
      icon: ShieldCheck,
      anyOf: ['roles.view'],
      needsOrg: true,
    },
    {
      href: '/dashboard/audit',
      label: t('audit'),
      icon: ScrollText,
      anyOf: ['audit.view'],
      needsOrg: true,
    },
    { href: '/dashboard/settings', label: t('settings'), icon: Settings },
    { href: '/platform', label: t('platform'), icon: Building2, platformOnly: true },
  ];
  return items.filter(
    (i) =>
      (!i.platformOnly || me.isPlatformAdmin) &&
      (!i.needsOrg || me.activeOrganization) &&
      has(i.anyOf),
  );
}

function OrgSwitcher({ me }: { me: MeResponse }) {
  const t = useTranslations('nav');
  const active = me.memberships.filter((m) => m.status === 'active');
  if (!me.activeOrganization) return null;
  if (active.length < 2) {
    return <p className="truncate text-sm font-medium text-ink">{me.activeOrganization.name}</p>;
  }
  return (
    <label className="flex flex-col gap-1">
      <span className="sr-only">{t('switchOrganization')}</span>
      <select
        className="h-9 w-full rounded-md border border-line-strong bg-panel px-2 text-sm font-medium"
        value={me.activeOrganization.id}
        onChange={async (e) => {
          await apiPost<MeResponse>('/auth/switch-organization', {
            organizationId: e.target.value,
          });
          window.location.assign('/dashboard');
        }}
      >
        {active.map((m) => (
          <option key={m.organizationId} value={m.organizationId}>
            {m.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function Sidebar({ me, onNavigate }: { me: MeResponse; onNavigate?: () => void }) {
  const t = useTranslations('nav');
  const tApp = useTranslations('app');
  const pathname = usePathname();
  const items = useNav(me);
  const qc = useQueryClient();

  const isActive = (href: string) =>
    href === '/dashboard'
      ? pathname === '/dashboard'
      : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-col gap-3 border-b border-line px-4 py-5">
        <span className="text-[0.8125rem] font-medium text-muted">{tApp('name')}</span>
        <OrgSwitcher me={me} />
      </div>
      <nav aria-label={t('mainNavigation')} className="flex-1 overflow-y-auto px-2 py-3">
        <ul className="flex flex-col gap-0.5">
          {items.map((item) => {
            const active = isActive(item.href);
            const Icon = item.icon;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={onNavigate}
                  aria-current={active ? 'page' : undefined}
                  className={cx(
                    'flex items-center gap-3 rounded-md px-3 py-2 text-[0.9375rem]',
                    active ? 'bg-turf text-turf-ink' : 'text-ink hover:bg-panel-2',
                  )}
                >
                  <Icon className="size-4 shrink-0" aria-hidden="true" />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="border-t border-line px-4 py-4">
        <p className="truncate text-sm font-medium">{me.user.displayName}</p>
        <p className="ltr-text truncate text-[0.8125rem] text-muted">{me.user.email}</p>
        <button
          type="button"
          className="mt-3 inline-flex items-center gap-2 text-sm text-muted hover:text-ink"
          onClick={async () => {
            await apiPost('/auth/logout').catch(() => undefined);
            qc.clear();
            window.location.assign('/login');
          }}
        >
          <LogOut className="size-4 rtl:-scale-x-100" aria-hidden="true" />
          {t('signOut')}
        </button>
      </div>
    </div>
  );
}

function NotificationBell({ me }: { me: MeResponse }) {
  const t = useTranslations('notifications');
  const unread = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: () => api<{ count: number }>('/notifications/unread-count'),
    refetchInterval: 30_000,
    enabled: !!me.activeOrganization,
  });
  if (!me.activeOrganization) return null;
  const count = unread.data?.count ?? 0;
  return (
    <Link
      href="/dashboard/notifications"
      className="relative inline-flex size-9 items-center justify-center rounded-md text-ink hover:bg-panel-2"
      aria-label={`${t('title')}: ${t('unread', { count })}`}
    >
      <Bell className="size-[1.125rem]" aria-hidden="true" />
      {count > 0 && (
        <span className="absolute -top-0.5 -end-0.5 min-w-5 rounded-full bg-amber px-1 text-center text-xs leading-5 font-semibold text-amber-ink">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </Link>
  );
}

function ShellFrame({ me, children }: { me: MeResponse; children: ReactNode }) {
  const t = useTranslations('nav');
  const tc = useTranslations('common');
  const [drawer, setDrawer] = useState(false);
  const pathname = usePathname();
  useEffect(() => setDrawer(false), [pathname]);

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15.5rem_minmax(0,1fr)]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:start-4 focus:top-4 focus:z-50 focus:rounded focus:bg-panel focus:px-3 focus:py-2"
      >
        {tc('skipToContent')}
      </a>
      <aside className="sticky top-0 hidden h-dvh border-e border-line bg-panel lg:block">
        <Sidebar me={me} />
      </aside>

      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label={tc('close')}
            className="absolute inset-0 bg-black/40"
            onClick={() => setDrawer(false)}
          />
          <div className="absolute inset-y-0 start-0 w-72 max-w-[85%] bg-panel shadow-xl">
            <button
              type="button"
              onClick={() => setDrawer(false)}
              aria-label={tc('close')}
              className="absolute top-3 end-3 inline-flex size-9 items-center justify-center rounded-md hover:bg-panel-2"
            >
              <X className="size-5" aria-hidden="true" />
            </button>
            <Sidebar me={me} onNavigate={() => setDrawer(false)} />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-col">
        <div className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-line bg-bg/95 px-4 backdrop-blur sm:px-8">
          <button
            type="button"
            className="inline-flex size-9 items-center justify-center rounded-md hover:bg-panel-2 lg:hidden"
            aria-label={t('menu')}
            aria-expanded={drawer}
            onClick={() => setDrawer(true)}
          >
            <Menu className="size-5" aria-hidden="true" />
          </button>
          <div className="flex-1" />
          <LanguageSwitcher signedIn />
          <NotificationBell me={me} />
        </div>
        <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}

/** Loads the session, handles signed-out / suspended states, and renders the dashboard frame. */
export function AppShell({ children }: { children: ReactNode }) {
  const me = useMeQuery();
  const t = useTranslations('overview');

  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401) window.location.assign('/login');
  }, [me.error]);

  if (me.isLoading || !me.data) return <Spinner />;

  return (
    <MeProvider me={me.data}>
      <ShellFrame me={me.data}>
        {me.data.activeOrganization || me.data.isPlatformAdmin ? (
          children
        ) : (
          <div className="max-w-xl">
            <h1 className="text-2xl font-semibold">{t('noOrganization')}</h1>
            <p className="mt-2 text-muted">{t('noOrganizationLead')}</p>
          </div>
        )}
      </ShellFrame>
    </MeProvider>
  );
}
