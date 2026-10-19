'use client';

/**
 * The public signing page (spec §7.7): no account needed. The signer confirms who they are with
 * a 6-digit code, reads the approved contract, signs (typed in blue or drawn), reviews a preview,
 * agrees to the statement and confirms. Only this contract and this signer's details are shown.
 *
 * The verified session lives in sessionStorage for this tab only and is sent as a header; the
 * API re-checks the link and the session on every request.
 */
import {
  type ApiErrorBody,
  CONSENT_VERSION,
  MIN_DRAWN_LENGTH,
  type PublicSigningInfo,
  type PublicSigningSession,
  type PublicSigningVerified,
  type SignatureFontKey,
  type SignatureMethod,
  signatureFontsFor,
  signSchema,
  strokeLength,
} from '@esports/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Clock, Download, FileText, Lock, PenLine, ShieldCheck } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useParams } from 'next/navigation';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { DocumentFrame } from '@/components/contracts/contracts-nav';
import {
  DrawnSignature,
  SignaturePad,
  type Strokes,
  TypedSignature,
} from '@/components/contracts/signature-art';
import { LanguageSwitcher } from '@/components/language-switcher';
import {
  Button,
  Checkbox,
  cx,
  Dialog,
  ErrorBanner,
  Spinner,
  TextField,
  useErrorText,
} from '@/components/ui';
import { ApiError } from '@/lib/api';
import { downloadGet, fetchHtml, useContractLabels } from '@/lib/contracts';
import { formatDate, formatDateTime } from '@/lib/format';

const SESSION_HEADER = 'x-signing-session';
const storeKey = (token: string) => `signing-session:${token.slice(0, 12)}`;
const readStored = (token: string) => {
  try {
    return sessionStorage.getItem(storeKey(token));
  } catch {
    return null;
  }
};
const writeStored = (token: string, value: string | null) => {
  try {
    if (value) sessionStorage.setItem(storeKey(token), value);
    else sessionStorage.removeItem(storeKey(token));
  } catch {
    /* private mode: the session simply lasts for this page view */
  }
};

async function call<T>(
  token: string,
  path: string,
  opts: { method?: string; body?: unknown; session?: string | null } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/public/signing/${encodeURIComponent(token)}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(opts.session ? { [SESSION_HEADER]: opts.session } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      cache: 'no-store',
      credentials: 'omit',
    });
  } catch {
    throw new ApiError(0, 'network', 'Network error');
  }
  const data = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const err = (data as ApiErrorBody | null)?.error;
    throw new ApiError(res.status, err?.code ?? 'internal_error', err?.message ?? '', err?.details);
  }
  return data as T;
}

const isCode = (e: unknown, ...codes: string[]) => e instanceof ApiError && codes.includes(e.code);

export default function SignPage() {
  const { token } = useParams<{ token: string }>();
  const t = useTranslations('signPage');
  const qc = useQueryClient();
  const [session, setSession] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  useEffect(() => setSession(readStored(token)), [token]);

  const info = useQuery({
    queryKey: ['signing', token, 'info'],
    queryFn: () => call<PublicSigningInfo>(token, ''),
    retry: false,
  });
  const state = useQuery({
    queryKey: ['signing', token, 'session', session],
    queryFn: () => call<PublicSigningSession>(token, '/session', { session }),
    enabled: !!session,
    retry: false,
  });
  // A session that ended (30 minutes) or a link withdrawn meanwhile.
  useEffect(() => {
    if (!state.error) return;
    if (isCode(state.error, 'verification_required')) {
      writeStored(token, null);
      setSession(null);
      setEnded(true);
    } else void qc.invalidateQueries({ queryKey: ['signing', token, 'info'] });
  }, [state.error, token, qc]);

  const onVerified = (v: PublicSigningVerified) => {
    writeStored(token, v.sessionToken);
    qc.setQueryData(['signing', token, 'session', v.sessionToken], v.session);
    setEnded(false);
    setSession(v.sessionToken);
  };
  const onSessionLost = () => {
    writeStored(token, null);
    setSession(null);
    setEnded(true);
  };

  let body;
  if (info.isLoading) body = <Spinner />;
  else if (info.error || !info.data) body = <Unusable error={info.error} />;
  else if (!session || (!state.data && state.error))
    body = <Verify token={token} info={info.data} ended={ended} onVerified={onVerified} />;
  else if (!state.data) body = <Spinner />;
  else
    body = (
      <Signing
        token={token}
        session={session}
        s={state.data}
        onUpdate={(next) => qc.setQueryData(['signing', token, 'session', session], next)}
        onRefresh={() => void state.refetch()}
        onSessionLost={onSessionLost}
      />
    );

  return (
    <div className="min-h-dvh bg-bg">
      <header className="border-b border-line bg-panel">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="min-w-0">
            <p className="truncate font-semibold">{info.data?.organizationName ?? t('title')}</p>
            {info.data && (
              <p className="text-sm text-muted">
                {t('title')} · <span className="ltr-text">{info.data.contractNumber}</span>
              </p>
            )}
          </div>
          <LanguageSwitcher />
        </div>
      </header>
      <main id="main" className="mx-auto flex max-w-4xl flex-col gap-5 px-4 py-6 sm:px-6">
        {body}
      </main>
    </div>
  );
}

function Card({
  icon,
  title,
  lead,
  children,
}: {
  icon?: ReactNode;
  title: string;
  lead?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-line bg-panel">
      <div className="flex gap-3 px-5 pt-5">
        {icon && <span className="mt-0.5 shrink-0 text-turf">{icon}</span>}
        <div className="min-w-0">
          <h1 className="text-lg font-semibold">{title}</h1>
          {lead && <div className="mt-1 text-sm text-muted">{lead}</div>}
        </div>
      </div>
      <div className="px-5 pt-4 pb-5">{children}</div>
    </section>
  );
}

function Unusable({ error }: { error: unknown }) {
  const t = useTranslations('signPage');
  const errorText = useErrorText();
  return (
    <Card
      icon={<Lock className="size-5 text-brick" aria-hidden="true" />}
      title={t('unusable')}
      lead={errorText(error)}
    >
      <p className="text-sm text-muted">{t('contactOrg')}</p>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Step 1: confirm it's you

function Verify({
  token,
  info,
  ended,
  onVerified,
}: {
  token: string;
  info: PublicSigningInfo;
  ended: boolean;
  onVerified: (v: PublicSigningVerified) => void;
}) {
  const t = useTranslations('signPage');
  const errorText = useErrorText();
  const locale = useLocale();
  const [code, setCode] = useState('');
  const [sent, setSent] = useState<{ destination: string; at: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<null | 'send' | 'verify'>(null);
  const [error, setError] = useState<unknown>(null);
  const email = info.method === 'email_code';
  useEffect(() => {
    if (!sent) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [sent]);
  const wait = sent ? Math.max(0, 60 - Math.floor((now - sent.at) / 1000)) : 0;

  const send = async () => {
    setBusy('send');
    setError(null);
    try {
      const r = await call<{ destination: string }>(token, '/code', { method: 'POST' });
      setSent({ destination: r.destination, at: Date.now() });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  const verify = async () => {
    setBusy('verify');
    setError(null);
    try {
      onVerified(
        await call<PublicSigningVerified>(token, '/verify', {
          method: 'POST',
          body: { code: code.trim() },
        }),
      );
    } catch (e) {
      setError(e);
      setCode('');
    } finally {
      setBusy(null);
    }
  };
  const attemptsLeft =
    error instanceof ApiError && error.code === 'verification_failed'
      ? (error.details as { attemptsLeft?: number } | undefined)?.attemptsLeft
      : undefined;

  return (
    <>
      <Card
        icon={<ShieldCheck className="size-5" aria-hidden="true" />}
        title={t('verifyTitle')}
        lead={
          <>
            <p>
              {t('from', { organization: info.organizationName, number: info.contractNumber })}{' '}
              {info.signerRole === 'guardian' ? t('asGuardian') : t('asRecipient')}
            </p>
            {(info.state === 'signed' || info.state === 'completed') && (
              <p className="mt-1">{t('revisitSigned')}</p>
            )}
          </>
        }
      >
        <div className="flex max-w-sm flex-col gap-4">
          {ended && (
            <p role="status" className="rounded-md bg-amber-soft px-3 py-2 text-sm text-amber-ink">
              {t('sessionEnded')}
            </p>
          )}
          {email ? (
            <>
              <p className="text-sm">
                {sent
                  ? t('codeSent', { email: sent.destination })
                  : t('verifyEmailLead', { email: info.destination ?? '' })}
              </p>
              <Button
                variant={sent ? 'secondary' : 'primary'}
                disabled={busy !== null || wait > 0}
                onClick={send}
                className="self-start"
              >
                {sent ? t('resendCode') : t('sendCode')}
              </Button>
              {sent && wait > 0 && (
                <p className="text-[0.8125rem] text-muted">{t('resendIn', { seconds: wait })}</p>
              )}
            </>
          ) : (
            <p className="text-sm">
              {t('verifyAccessLead', { organization: info.organizationName })}
            </p>
          )}
          {(!email || sent) && (
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                void verify();
              }}
            >
              <div className="w-48">
                <TextField
                  label={t('codeLabel')}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  dir="ltr"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  className="ltr-text text-center font-mono text-lg tracking-[0.3em]"
                  autoFocus
                />
              </div>
              <Button
                type="submit"
                variant="primary"
                disabled={code.length !== 6 || busy !== null}
                className="self-start"
              >
                {t('verify')}
              </Button>
            </form>
          )}
          {error !== null && (
            <div role="alert" className="text-sm text-brick">
              <p>{errorText(error)}</p>
              {attemptsLeft !== undefined && <p>{t('attemptsLeft', { count: attemptsLeft })}</p>}
            </div>
          )}
        </div>
      </Card>
      <p className="flex items-center gap-2 text-[0.8125rem] text-muted">
        <Lock className="size-4 shrink-0" aria-hidden="true" />
        <span>
          {t('private')} {t('expiresOn', { date: formatDate(info.expiresAt, locale) })}
        </span>
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Step 2: read, sign, confirm

function Signers({ s }: { s: PublicSigningSession }) {
  const t = useTranslations('signPage');
  const locale = useLocale();
  const L = useContractLabels();
  return (
    <ul className="flex flex-wrap gap-2 text-sm" aria-label={t('signersTitle')}>
      {s.signers.map((x) => (
        <li
          key={x.role}
          className={cx(
            'inline-flex items-center gap-1.5 rounded-full border px-3 py-1',
            x.status === 'signed' ? 'border-turf/30 bg-turf-soft' : 'border-line bg-panel',
          )}
        >
          {x.status === 'signed' ? (
            <CheckCircle2 className="size-4 text-turf" aria-hidden="true" />
          ) : (
            <Clock className="size-4 text-muted" aria-hidden="true" />
          )}
          <span className="font-medium">{L.signerRole[x.role]}</span>
          <span className="text-muted">
            {x.status === 'signed'
              ? `${t('signerSigned')} ${formatDate(x.signedAt, locale)}`
              : t('signerPending')}
          </span>
        </li>
      ))}
    </ul>
  );
}

function DocumentReview({
  token,
  session,
  s,
}: {
  token: string;
  session: string;
  s: PublicSigningSession;
}) {
  const t = useTranslations('signPage');
  const html = useQuery({
    queryKey: ['signing', token, 'document', session],
    queryFn: () =>
      fetchHtml(`/public/signing/${token}/document.html`, { [SESSION_HEADER]: session }),
    retry: false,
    staleTime: Infinity,
  });
  const [dlError, setDlError] = useState<unknown>(null);
  return (
    <Card
      icon={<FileText className="size-5" aria-hidden="true" />}
      title={t('reviewTitle')}
      lead={t('reviewLead')}
    >
      <div className="flex flex-col gap-3">
        <ErrorBanner error={html.error ?? dlError} />
        {html.isLoading ? (
          <Spinner />
        ) : (
          <DocumentFrame html={html.data} title={t('frameTitle', { number: s.contractNumber })} />
        )}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[0.8125rem] text-muted">{t('fingerprint')}</p>
            <p className="ltr-text font-mono text-xs break-all">{s.documentSha256}</p>
          </div>
          <Button
            onClick={() => {
              setDlError(null);
              downloadGet(`/public/signing/${token}/document.pdf`, 'contract.pdf', {
                [SESSION_HEADER]: session,
              }).catch(setDlError);
            }}
          >
            <Download className="size-4" aria-hidden="true" />
            {t('downloadPdf')}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function Signing({
  token,
  session,
  s,
  onUpdate,
  onRefresh,
  onSessionLost,
}: {
  token: string;
  session: string;
  s: PublicSigningSession;
  onUpdate: (s: PublicSigningSession) => void;
  onRefresh: () => void;
  onSessionLost: () => void;
}) {
  const t = useTranslations('signPage');
  const [dlError, setDlError] = useState<unknown>(null);

  if (s.state === 'signed' || s.state === 'completed')
    return (
      <>
        <Card
          icon={<CheckCircle2 className="size-5" aria-hidden="true" />}
          title={s.state === 'completed' ? t('completedTitle') : t('signedTitle')}
          lead={s.state === 'completed' ? t('completedLead') : t('signedLead')}
        >
          <div className="flex flex-col gap-4">
            <Signers s={s} />
            <ErrorBanner error={dlError} />
            {s.state === 'completed' ? (
              <Button
                variant="primary"
                className="self-start"
                onClick={() => {
                  setDlError(null);
                  downloadGet(`/public/signing/${token}/signed.pdf`, 'signed-contract.pdf', {
                    [SESSION_HEADER]: session,
                  }).catch(setDlError);
                }}
              >
                <Download className="size-4" aria-hidden="true" />
                {t('downloadSigned')}
              </Button>
            ) : (
              <Button className="self-start" onClick={onRefresh}>
                {t('refresh')}
              </Button>
            )}
          </div>
        </Card>
      </>
    );

  return (
    <>
      <Signers s={s} />
      {s.state === 'waiting' && (
        <Card
          icon={<Clock className="size-5" aria-hidden="true" />}
          title={t('waitingTitle')}
          lead={t('waitingLead')}
        >
          <Button onClick={onRefresh}>{t('refresh')}</Button>
        </Card>
      )}
      <DocumentReview token={token} session={session} s={s} />
      {s.state === 'ready' && (
        <SignForm
          token={token}
          session={session}
          s={s}
          onSigned={onUpdate}
          onSessionLost={onSessionLost}
        />
      )}
    </>
  );
}

function SignForm({
  token,
  session,
  s,
  onSigned,
  onSessionLost,
}: {
  token: string;
  session: string;
  s: PublicSigningSession;
  onSigned: (s: PublicSigningSession) => void;
  onSessionLost: () => void;
}) {
  const t = useTranslations('signPage');
  const tc = useTranslations('common');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const ownName =
    (locale === 'ar' ? s.signer.nameAr || s.signer.nameEn : s.signer.nameEn || s.signer.nameAr) ??
    '';
  const recipient =
    (locale === 'ar'
      ? s.recipientName.ar || s.recipientName.en
      : s.recipientName.en || s.recipientName.ar) ?? '';
  const [method, setMethod] = useState<SignatureMethod>('typed');
  const [typedName, setTypedName] = useState(ownName);
  const fonts = useMemo(() => signatureFontsFor(typedName || ownName), [typedName, ownName]);
  const [fontKey, setFontKey] = useState<SignatureFontKey>(fonts[0]!.key);
  useEffect(() => {
    if (!fonts.some((f) => f.key === fontKey)) setFontKey(fonts[0]!.key);
  }, [fonts, fontKey]);
  const [strokes, setStrokes] = useState<Strokes>([]);
  const [agree, setAgree] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const payload = {
    method,
    typedName: method === 'typed' ? typedName.trim() : null,
    fontKey: method === 'typed' ? fontKey : null,
    strokes: method === 'drawn' ? strokes : null,
    locale,
    consentVersion: CONSENT_VERSION,
    consent: agree,
    confirm: true,
  };
  const valid = signSchema.safeParse(payload).success;
  const drawnTooShort =
    method === 'drawn' && strokes.length > 0 && strokeLength(strokes) < MIN_DRAWN_LENGTH;
  const statement = locale === 'ar' ? s.consent.ar : s.consent.en;

  const sign = async () => {
    setBusy(true);
    setError(null);
    try {
      onSigned(
        await call<PublicSigningSession>(token, '/sign', {
          method: 'POST',
          body: payload,
          session,
        }),
      );
      setConfirming(false);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      if (isCode(e, 'verification_required')) onSessionLost();
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const preview =
    method === 'typed' ? (
      <TypedSignature name={typedName.trim()} fontKey={fontKey} />
    ) : (
      <DrawnSignature strokes={strokes} className="h-20" />
    );

  return (
    <Card
      icon={<PenLine className="size-5" aria-hidden="true" />}
      title={t('signTitle')}
      lead={
        <>
          {t('signingAs', { name: ownName })}
          {s.signer.role === 'guardian' && <> · {t('onBehalf', { name: recipient })}</>}
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div
          role="radiogroup"
          className="inline-flex w-fit gap-1 rounded-lg border border-line bg-panel-2 p-1"
        >
          {(['typed', 'drawn'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={method === m}
              onClick={() => setMethod(m)}
              className={cx(
                'h-8 rounded-md px-4 text-sm',
                method === m ? 'bg-panel font-medium shadow-sm' : 'text-muted hover:text-ink',
              )}
            >
              {t(m)}
            </button>
          ))}
        </div>

        {method === 'typed' ? (
          <div className="flex flex-col gap-4">
            <div className="max-w-sm">
              <TextField
                label={t('typedLabel')}
                dir="auto"
                value={typedName}
                maxLength={120}
                onChange={(e) => setTypedName(e.target.value)}
                autoComplete="name"
              />
            </div>
            <fieldset>
              <legend className="mb-2 text-sm font-medium">{t('styleLabel')}</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {fonts.map((f) => (
                  <label
                    key={f.key}
                    className={cx(
                      'flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2',
                      fontKey === f.key ? 'border-turf bg-turf-soft/40' : 'border-line bg-panel',
                    )}
                  >
                    <input
                      type="radio"
                      name="font"
                      checked={fontKey === f.key}
                      onChange={() => setFontKey(f.key)}
                      className="accent-[var(--turf)]"
                    />
                    <TypedSignature
                      name={typedName.trim() || ownName}
                      fontKey={f.key}
                      className="truncate text-3xl"
                    />
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted">{t('drawHint')}</p>
            <SignaturePad strokes={strokes} onChange={setStrokes} label={t('drawArea')} />
            <div className="flex items-center justify-between gap-3">
              <span className="text-[0.8125rem] text-brick">
                {drawnTooShort ? t('drawMore') : ''}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={!strokes.length}
                onClick={() => setStrokes([])}
              >
                {t('clear')}
              </Button>
            </div>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">{t('statement')}</p>
          <p className="rounded-md border border-line bg-panel-2 px-4 py-3 text-[0.9375rem]">
            {statement}
          </p>
          <Checkbox
            label={t('agree')}
            checked={agree}
            onChange={(e) => setAgree(e.target.checked)}
          />
        </div>

        <ErrorBanner error={confirming ? null : error} />
        <Button
          variant="primary"
          disabled={!valid}
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
          className="self-start"
        >
          {t('continue')}
        </Button>
      </div>

      {confirming && (
        <Dialog
          open
          onClose={() => setConfirming(false)}
          title={t('confirmTitle')}
          lead={t('confirmLead')}
          footer={
            <>
              <Button onClick={() => setConfirming(false)}>{tc('back')}</Button>
              <Button variant="primary" disabled={busy} onClick={() => void sign()}>
                {busy ? t('signing') : t('confirm')}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <ErrorBanner error={error} />
            <div>
              <p className="mb-1 text-[0.8125rem] text-muted">{t('preview')}</p>
              <div className="flex min-h-20 items-end border-b border-line-strong px-2 pb-1">
                {preview}
              </div>
              <p className="mt-1 text-sm">
                {ownName} · {formatDateTime(new Date().toISOString(), locale)}
              </p>
            </div>
            <p className="text-sm text-muted">{statement}</p>
          </div>
        </Dialog>
      )}
    </Card>
  );
}
