'use client';

import { type Locale, type MeResponse, registerOrganizationSchema } from '@esports/shared';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { AuthShell } from '@/components/auth-shell';
import { Button, ErrorBanner, SelectField, TextField } from '@/components/ui';
import { apiPost } from '@/lib/api';
import { enterDashboard } from '@/lib/auth-client';
import { invalidFields } from '@/lib/form';

/** Suggest an address from a Latin-script name; Arabic names leave it for the user to type. */
const toSlug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

export default function RegisterPage() {
  const t = useTranslations('auth');
  const tc = useTranslations('common');
  const locale = useLocale() as Locale;
  const [values, setValues] = useState({
    organizationName: '',
    organizationSlug: '',
    defaultLocale: locale,
    displayName: '',
    email: '',
    password: '',
  });
  const [slugTouched, setSlugTouched] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const invalid = invalidFields(registerOrganizationSchema, values);
  const err = (field: string, message: string) => (showErrors && invalid.has(field) ? message : null);
  const set = (k: keyof typeof values) => (e: { target: { value: string } }) =>
    setValues((v) => {
      const next = { ...v, [k]: e.target.value };
      if (k === 'organizationName' && !slugTouched) next.organizationSlug = toSlug(e.target.value);
      return next;
    });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setShowErrors(true);
    if (invalid.size) return;
    setBusy(true);
    setError(null);
    try {
      enterDashboard(await apiPost<MeResponse>('/auth/register', values));
    } catch (e2) {
      setError(e2);
      setBusy(false);
    }
  };

  return (
    <AuthShell>
      <h1 className="text-2xl font-semibold tracking-tight">{t('registerTitle')}</h1>
      <p className="mt-1.5 mb-7 text-muted">{t('registerLead')}</p>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <ErrorBanner error={error} />
        <TextField label={t('organizationName')} value={values.organizationName} onChange={set('organizationName')} error={err('organizationName', tc('required'))} />
        <TextField
          label={t('organizationSlug')}
          hint={t('organizationSlugHint')}
          value={values.organizationSlug}
          onChange={(e) => {
            setSlugTouched(true);
            set('organizationSlug')(e);
          }}
          className="ltr-text"
          error={err('organizationSlug', t('organizationSlugHint'))}
        />
        <SelectField label={t('defaultLocale')} value={values.defaultLocale} onChange={set('defaultLocale')}>
          <option value="ar">{tc('arabic')}</option>
          <option value="en">{tc('english')}</option>
        </SelectField>
        <TextField label={t('displayName')} autoComplete="name" value={values.displayName} onChange={set('displayName')} error={err('displayName', tc('required'))} />
        <TextField label={t('email')} type="email" autoComplete="email" value={values.email} onChange={set('email')} className="ltr-text" error={err('email', tc('invalidEmail'))} />
        <TextField
          label={t('password')}
          type="password"
          autoComplete="new-password"
          hint={t('passwordHint')}
          value={values.password}
          onChange={set('password')}
          error={err('password', t('passwordHint'))}
        />
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? t('creating') : t('createAndContinue')}
        </Button>
      </form>
      <p className="mt-8 text-sm text-muted">
        {t('haveAccount')}{' '}
        <Link href="/login" className="font-medium text-turf underline-offset-4 hover:underline">
          {t('signIn')}
        </Link>
      </p>
    </AuthShell>
  );
}
