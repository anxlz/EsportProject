'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { AuthShell } from '@/components/auth-shell';
import { Button, ErrorBanner, TextField } from '@/components/ui';
import { apiPost } from '@/lib/api';

export default function ForgotPasswordPage() {
  const t = useTranslations('auth');
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiPost('/auth/password/forgot', { email });
      setSent(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell>
      <h1 className="text-2xl font-semibold tracking-tight">{t('forgotTitle')}</h1>
      {sent ? (
        <p className="mt-4 rounded-md border border-turf/25 bg-turf-soft px-4 py-3" role="status">
          {t('forgotSent')}
        </p>
      ) : (
        <>
          <p className="mt-1.5 mb-7 text-muted">{t('forgotLead')}</p>
          <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
            <ErrorBanner error={error} />
            <TextField
              label={t('email')}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="ltr-text"
            />
            <Button type="submit" variant="primary" disabled={busy || !email}>
              {t('sendResetLink')}
            </Button>
          </form>
        </>
      )}
      <Link href="/login" className="mt-8 text-sm text-turf underline-offset-4 hover:underline">
        {t('backToSignIn')}
      </Link>
    </AuthShell>
  );
}
