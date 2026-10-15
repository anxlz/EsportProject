'use client';

import { type AuthConfigDto, type Locale, type MeResponse, passwordSchema } from '@esports/shared';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import {
  Button,
  ErrorBanner,
  PageHeader,
  Section,
  SelectField,
  TextField,
  useToast,
} from '@/components/ui';
import { setLocaleCookie } from '@/i18n/locale';
import { api, ApiError, apiDelete, apiPatch, apiPost } from '@/lib/api';
import { useAction } from '@/lib/mutation';
import { useCan, useMe } from '@/lib/session';

interface OrganizationSettings {
  id: string;
  name: string;
  slug: string;
  defaultLocale: Locale;
}

function ProfileSection() {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const me = useMe();
  const [displayName, setDisplayName] = useState(me.user.displayName);
  const [locale, setLocale] = useState<Locale | ''>(me.user.locale ?? '');
  const save = useAction(
    () => apiPatch<MeResponse>('/me', { displayName, locale: locale || null }),
    {
      invalidate: [['me']],
      success: t('profileSaved'),
      onSuccess: () => {
        if (locale && locale !== me.user.locale) {
          setLocaleCookie(locale);
          window.location.reload();
        }
      },
    },
  );
  return (
    <Section title={t('profile')}>
      <div className="flex max-w-md flex-col gap-4 p-5">
        <ErrorBanner error={save.error} />
        <TextField
          label={t('displayName')}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
        <SelectField
          label={t('language')}
          hint={t('languageHint')}
          value={locale}
          onChange={(e) => setLocale(e.target.value as Locale | '')}
        >
          <option value="ar">{tc('arabic')}</option>
          <option value="en">{tc('english')}</option>
        </SelectField>
        <div>
          <Button
            variant="primary"
            disabled={save.isPending || !displayName.trim()}
            onClick={() => save.mutate(undefined)}
          >
            {save.isPending ? tc('saving') : tc('saveChanges')}
          </Button>
        </div>
      </div>
    </Section>
  );
}

function SecuritySection() {
  const t = useTranslations('settings');
  const ta = useTranslations('auth');
  const me = useMe();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const weak = !passwordSchema.safeParse(next).success;
  const change = useAction(
    () => apiPost('/me/password', { currentPassword: current, newPassword: next }),
    {
      invalidate: [],
      success: t('passwordChanged'),
      onSuccess: () => {
        setCurrent('');
        setNext('');
        setShowErrors(false);
      },
    },
  );
  const others = useAction(() => apiPost<{ revoked: number }>('/me/sessions/revoke-others'), {
    invalidate: [],
    onSuccess: (r) => toast(t('signedOutOthers', { count: r.revoked })),
  });
  return (
    <Section title={t('security')}>
      <div className="flex max-w-md flex-col gap-4 p-5">
        {me.user.hasPassword && (
          <>
            <ErrorBanner error={change.error} />
            <TextField
              label={t('currentPassword')}
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
            <TextField
              label={t('newPassword')}
              type="password"
              autoComplete="new-password"
              hint={ta('passwordHint')}
              value={next}
              onChange={(e) => setNext(e.target.value)}
              error={showErrors && weak ? ta('passwordHint') : null}
            />
            <div>
              <Button
                variant="primary"
                disabled={change.isPending || !current}
                onClick={() => {
                  setShowErrors(true);
                  if (!weak) change.mutate(undefined);
                }}
              >
                {t('changePassword')}
              </Button>
            </div>
          </>
        )}
        <div className="border-t border-line pt-4">
          <Button onClick={() => others.mutate(undefined)} disabled={others.isPending}>
            {t('signOutOthers')}
          </Button>
        </div>
      </div>
    </Section>
  );
}

function DiscordSection() {
  const t = useTranslations('settings');
  const me = useMe();
  const params = useSearchParams();
  const config = useQuery({
    queryKey: ['auth-config'],
    queryFn: () => api<AuthConfigDto>('/auth/config'),
  });
  const unlink = useAction(() => apiDelete('/me/discord'), {
    invalidate: [['me']],
    success: t('discordUnlinked'),
  });
  const redirectError = params.get('error');
  return (
    <Section title={t('discord')} lead={t('discordLead')}>
      <div className="flex max-w-md flex-col gap-3 p-5">
        {params.get('discord') === 'linked' && (
          <p role="status" className="rounded-md bg-turf-soft px-3 py-2 text-sm">
            {t('discordLinked')}
          </p>
        )}
        {redirectError && (
          <ErrorBanner error={new ApiError(400, redirectError as never, redirectError)} />
        )}
        <ErrorBanner error={unlink.error} />
        {!config.data?.discordEnabled ? (
          <p className="text-sm text-muted">{t('discordNotConfigured')}</p>
        ) : me.user.discordLinked ? (
          <div className="flex flex-wrap items-center gap-3">
            <span>{t('discordLinkedAs', { name: me.user.discordUsername ?? '' })}</span>
            <Button size="sm" onClick={() => unlink.mutate(undefined)} disabled={unlink.isPending}>
              {t('unlinkDiscord')}
            </Button>
          </div>
        ) : (
          <div>
            <a
              href="/api/auth/discord/start?mode=link"
              className="inline-flex h-10 items-center rounded-md border border-line-strong bg-panel px-4 font-medium hover:bg-panel-2"
            >
              {t('linkDiscord')}
            </a>
          </div>
        )}
      </div>
    </Section>
  );
}

function OrganizationSection() {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const can = useCan();
  const editable = can('org.settings.edit');
  const org = useQuery({
    queryKey: ['organization'],
    queryFn: () => api<OrganizationSettings>('/organization'),
  });
  const [draft, setDraft] = useState<{ name: string; defaultLocale: Locale } | null>(null);
  const value =
    draft ?? (org.data ? { name: org.data.name, defaultLocale: org.data.defaultLocale } : null);
  const save = useAction(() => apiPatch('/organization', value), {
    invalidate: [['organization'], ['me']],
    success: t('organizationSaved'),
    onSuccess: () => setDraft(null),
  });
  if (!value || !org.data) return null;
  return (
    <Section title={t('organization')}>
      <div className="flex max-w-md flex-col gap-4 p-5">
        <ErrorBanner error={save.error} />
        <TextField
          label={t('organizationName')}
          value={value.name}
          disabled={!editable}
          onChange={(e) => setDraft({ ...value, name: e.target.value })}
        />
        <TextField
          label={t('organizationAddress')}
          value={org.data.slug}
          disabled
          className="ltr-text"
        />
        <SelectField
          label={t('defaultLocale')}
          value={value.defaultLocale}
          disabled={!editable}
          onChange={(e) => setDraft({ ...value, defaultLocale: e.target.value as Locale })}
        >
          <option value="ar">{tc('arabic')}</option>
          <option value="en">{tc('english')}</option>
        </SelectField>
        {editable && (
          <div>
            <Button
              variant="primary"
              disabled={!draft || save.isPending}
              onClick={() => save.mutate(undefined)}
            >
              {save.isPending ? tc('saving') : tc('saveChanges')}
            </Button>
          </div>
        )}
        <p className="border-t border-line pt-4 text-[0.8125rem] text-muted">
          {t('verificationNote')}
        </p>
      </div>
    </Section>
  );
}

export default function SettingsPage() {
  const t = useTranslations('settings');
  const me = useMe();
  const can = useCan();
  return (
    <>
      <PageHeader title={t('title')} />
      <div className="flex flex-col gap-8">
        <ProfileSection />
        <SecuritySection />
        <Suspense>
          <DiscordSection />
        </Suspense>
        {me.activeOrganization && can('org.settings.view') && <OrganizationSection />}
      </div>
    </>
  );
}
