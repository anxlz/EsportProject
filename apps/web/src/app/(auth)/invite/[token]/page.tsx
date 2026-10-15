'use client';

import { type MeResponse, passwordSchema, type PublicInvitationDto } from '@esports/shared';
import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { AuthShell } from '@/components/auth-shell';
import { Button, ErrorBanner, Spinner, TextField } from '@/components/ui';
import { api, apiPost } from '@/lib/api';
import { enterDashboard } from '@/lib/auth-client';
import { formatDate, ltr } from '@/lib/format';

export default function InvitePage() {
  const t = useTranslations('invite');
  const ta = useTranslations('auth');
  const tc = useTranslations('common');
  const locale = useLocale();
  const { token } = useParams<{ token: string }>();
  const invitation = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => api<PublicInvitationDto>(`/public/invitations/${encodeURIComponent(token)}`),
    retry: false,
  });
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api<MeResponse>('/auth/me'),
    retry: false,
  });

  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const run = async (fn: () => Promise<MeResponse>) => {
    setBusy(true);
    setError(null);
    try {
      enterDashboard(await fn());
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  if (invitation.isLoading || me.isLoading) {
    return (
      <AuthShell>
        <Spinner />
      </AuthShell>
    );
  }

  if (invitation.isError || !invitation.data) {
    return (
      <AuthShell>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="mt-3 text-muted">{t('invalid')}</p>
      </AuthShell>
    );
  }

  const inv = invitation.data;
  const signedIn = me.data;
  const sameEmail = signedIn && signedIn.user.email.toLowerCase() === inv.email.toLowerCase();
  const weak = !passwordSchema.safeParse(password).success;

  return (
    <AuthShell>
      <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
      <p className="mt-2 text-ink">
        {inv.inviterName
          ? t('lead', { inviter: inv.inviterName, organization: inv.organizationName })
          : t('leadNoInviter', { organization: inv.organizationName })}
      </p>
      <p className="mt-1 text-sm text-muted">
        {t('forEmail', { email: ltr(inv.email) })}{' '}
        {t('expires', { date: formatDate(inv.expiresAt, locale) })}
      </p>

      <div className="mt-7 flex flex-col gap-4">
        <ErrorBanner error={error} />
        {signedIn ? (
          sameEmail ? (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() =>
                run(() => apiPost<MeResponse>(`/invitations/accept/${encodeURIComponent(token)}`))
              }
            >
              {busy ? t('joining') : t('acceptAsSignedIn', { organization: inv.organizationName })}
            </Button>
          ) : (
            <>
              <p className="text-muted">{t('wrongAccount', { email: ltr(inv.email) })}</p>
              <Button
                onClick={async () => {
                  await apiPost('/auth/logout').catch(() => undefined);
                  window.location.reload();
                }}
              >
                {tc('back')}
              </Button>
            </>
          )
        ) : inv.accountExists ? (
          <>
            <p className="text-muted">{t('existingAccount')}</p>
            <Link
              href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}
              className="inline-flex h-10 items-center justify-center rounded-md bg-turf px-4 font-medium text-turf-ink hover:bg-turf-hover"
            >
              {ta('signIn')}
            </Link>
          </>
        ) : (
          <form
            className="flex flex-col gap-4"
            noValidate
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              setShowErrors(true);
              if (!displayName.trim() || weak) return;
              void run(() =>
                apiPost<MeResponse>(`/public/invitations/${encodeURIComponent(token)}/accept`, {
                  displayName,
                  password,
                }),
              );
            }}
          >
            <p className="font-medium">{t('createAccount')}</p>
            <TextField
              label={ta('displayName')}
              autoComplete="name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              error={showErrors && !displayName.trim() ? tc('required') : null}
            />
            <TextField
              label={ta('password')}
              type="password"
              autoComplete="new-password"
              hint={ta('passwordHint')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={showErrors && weak ? ta('passwordHint') : null}
            />
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? t('joining') : t('join', { organization: inv.organizationName })}
            </Button>
          </form>
        )}
      </div>
    </AuthShell>
  );
}
