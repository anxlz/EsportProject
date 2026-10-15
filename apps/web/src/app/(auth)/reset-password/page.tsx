'use client';

import { passwordSchema } from '@esports/shared';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { type FormEvent, Suspense, useState } from 'react';
import { AuthShell } from '@/components/auth-shell';
import { Button, ErrorBanner, TextField } from '@/components/ui';
import { apiPost } from '@/lib/api';

function ResetForm() {
  const t = useTranslations('auth');
  const token = useSearchParams().get('token');
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showError, setShowError] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const weak = !passwordSchema.safeParse(password).success;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setShowError(true);
    if (weak || !token) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost('/auth/password/reset', { token, password });
      setDone(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (!token) return <p className="text-muted">{t('resetMissingToken')}</p>;
  if (done) {
    return (
      <p className="rounded-md border border-turf/25 bg-turf-soft px-4 py-3" role="status">
        {t('resetDone')}
      </p>
    );
  }
  return (
    <>
      <p className="mt-1.5 mb-7 text-muted">{t('resetLead')}</p>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <ErrorBanner error={error} />
        <TextField
          label={t('newPassword')}
          type="password"
          autoComplete="new-password"
          hint={t('passwordHint')}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={showError && weak ? t('passwordHint') : null}
        />
        <Button type="submit" variant="primary" disabled={busy}>
          {t('setPassword')}
        </Button>
      </form>
    </>
  );
}

export default function ResetPasswordPage() {
  const t = useTranslations('auth');
  return (
    <AuthShell>
      <h1 className="text-2xl font-semibold tracking-tight">{t('resetTitle')}</h1>
      <Suspense>
        <ResetForm />
      </Suspense>
      <Link href="/login" className="mt-8 text-sm text-turf underline-offset-4 hover:underline">
        {t('backToSignIn')}
      </Link>
    </AuthShell>
  );
}
