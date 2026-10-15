'use client';

import type { AuthConfigDto, MeResponse } from '@esports/shared';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { type FormEvent, Suspense, useState } from 'react';
import { AuthShell } from '@/components/auth-shell';
import { Button, ErrorBanner, TextField } from '@/components/ui';
import { api, ApiError, apiPost } from '@/lib/api';
import { enterDashboard } from '@/lib/auth-client';

function LoginForm() {
  const t = useTranslations('auth');
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const config = useQuery({ queryKey: ['auth-config'], queryFn: () => api<AuthConfigDto>('/auth/config') });

  const redirectError = params.get('error');
  // Only same-site relative paths, never "//host" (open-redirect guard).
  const nextParam = params.get('next');
  const next = nextParam && nextParam.startsWith('/') && !nextParam.startsWith('//') ? nextParam : '/dashboard';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await apiPost<MeResponse>('/auth/login', { email, password });
      enterDashboard(me, next);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">{t('signInTitle')}</h1>
      <p className="mt-1.5 mb-7 text-muted">{t('signInLead')}</p>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {redirectError && !error && (
          <ErrorBanner error={new ApiError(400, redirectError as never, redirectError)} />
        )}
        <ErrorBanner error={error} />
        <TextField label={t('email')} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="ltr-text" />
        <TextField label={t('password')} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        <Button type="submit" variant="primary" disabled={busy || !email || !password}>
          {busy ? t('signingIn') : t('signIn')}
        </Button>
        <Link href="/forgot-password" className="text-sm text-turf underline-offset-4 hover:underline">
          {t('forgotPassword')}
        </Link>
      </form>

      {config.data?.discordEnabled && (
        <div className="mt-6 flex flex-col gap-2 border-t border-line pt-6">
          <a
            href="/api/auth/discord/start?mode=login"
            className="inline-flex h-10 items-center justify-center rounded-md border border-line-strong bg-panel font-medium hover:bg-panel-2"
          >
            {t('signInWithDiscord')}
          </a>
          <p className="text-[0.8125rem] text-muted">{t('discordHint')}</p>
        </div>
      )}

      {config.data?.signupEnabled && (
        <p className="mt-8 text-sm text-muted">
          {t('noAccount')}{' '}
          <Link href="/register" className="font-medium text-turf underline-offset-4 hover:underline">
            {t('createOrganization')}
          </Link>
        </p>
      )}
    </>
  );
}

export default function LoginPage() {
  return (
    <AuthShell>
      <Suspense>
        <LoginForm />
      </Suspense>
    </AuthShell>
  );
}
