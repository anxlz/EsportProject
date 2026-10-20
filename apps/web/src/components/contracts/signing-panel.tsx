'use client';

/**
 * The Signatures tab of a contract (spec §7.7): send the approved contract for signature, create
 * and withdraw each signer's link, follow who has signed, cancel signing, and download the fully
 * signed document. Every action is re-checked by the API.
 *
 * ID-document patch: each recipient's identity document shows as provided or not; only holders
 * of `contracts.view_signer_id` get its details and can open it (every view is audited).
 */
import {
  type ContractDto,
  type ContractSigningDto,
  formatIsoDate,
  type CreateSigningLinkInput,
  requiredSigners,
  SIGNING_LINK_DEFAULT_DAYS,
  type SignerDto,
  type SignerIdDocumentDto,
  type SigningLinkCreatedDto,
  type SigningRoundDto,
  type VerificationMethod,
} from '@esports/shared';
import { useQuery } from '@tanstack/react-query';
import {
  CheckCircle2,
  Download,
  IdCard,
  Info,
  KeyRound,
  Link2,
  Mail,
  Send,
  ShieldAlert,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import {
  Badge,
  Button,
  ConfirmDialog,
  CopyField,
  cx,
  Dialog,
  ErrorBanner,
  Section,
  SelectField,
  Spinner,
  TextArea,
  TextField,
} from '@/components/ui';
import { api, ApiError, apiPost } from '@/lib/api';
import { downloadGet, pick, useContractLabels, useContractLocale } from '@/lib/contracts';
import { formatDate, formatDateTime } from '@/lib/format';
import { useAction } from '@/lib/mutation';
import { DrawnSignature, TypedSignature } from './signature-art';

const APPROVED = ['approved', 'awaiting_signatures', 'signed'];
const EXPIRY_DAYS = [3, 7, 14, 30];

export function useSigning(contractId: string, enabled = true) {
  return useQuery({
    queryKey: ['contracts', 'signing', contractId],
    queryFn: () => api<ContractSigningDto>(`/contracts/${contractId}/signing`),
    enabled,
  });
}

function Fingerprint({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[0.8125rem] text-muted">{label}</p>
      <p className="ltr-text font-mono text-xs break-all text-ink">{value}</p>
    </div>
  );
}

export function SigningPanel({ c }: { c: ContractDto }) {
  const t = useTranslations('contracts.signing');
  const loc = useContractLocale();
  const signing = useSigning(c.id, APPROVED.includes(c.status));
  const [dlError, setDlError] = useState<unknown>(null);

  if (!APPROVED.includes(c.status))
    return (
      <Section title={t('startTitle')}>
        <p className="px-5 py-4 text-sm text-muted">{t('notApprovedYet')}</p>
      </Section>
    );
  if (signing.isLoading) return <Spinner />;
  if (signing.error || !signing.data) return <ErrorBanner error={signing.error} />;

  const s = signing.data;
  const current = s.rounds.find((r) => r.status === 'in_progress');
  const completed = s.rounds.find((r) => r.status === 'completed');
  const earlier = s.rounds.filter((r) => r.status === 'cancelled');

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted">{t('lead')}</p>
      {completed && (
        <Section
          title={t('signedDocument')}
          lead={t('signedDocumentLead')}
          actions={
            s.can.download && (
              <Button
                variant="primary"
                onClick={() => {
                  setDlError(null);
                  downloadGet(`/contracts/${c.id}/signed.pdf`).catch(setDlError);
                }}
              >
                <Download className="size-4" aria-hidden="true" />
                {t('downloadSigned')}
              </Button>
            )
          }
        >
          <div className="flex flex-col gap-3 px-5 py-4">
            <ErrorBanner error={dlError} />
            <p className="flex items-center gap-2 text-sm font-medium">
              <CheckCircle2 className="size-4 text-turf" aria-hidden="true" />
              {t('roundCompleted', { date: formatDateTime(completed.completedAt, loc) })}
            </p>
            {completed.signedDocument && (
              <>
                <Fingerprint label={t('fingerprint')} value={completed.signedDocument.sha256} />
                <p
                  className={cx(
                    'text-sm',
                    completed.signedDocument.verified ? 'text-muted' : 'font-medium text-brick',
                  )}
                >
                  {completed.signedDocument.verified ? t('verifiedOk') : t('verifiedFailed')}
                </p>
              </>
            )}
          </div>
        </Section>
      )}
      {completed && <RoundView c={c} round={completed} can={s.can} />}
      {current && <RoundView c={c} round={current} can={s.can} />}
      {!current && !completed && <StartCard c={c} can={s.can.start} />}
      {!!earlier.length && (
        <Section title={t('earlierRounds')}>
          <ul className="divide-y divide-line">
            {earlier.map((r) => (
              <li key={r.id} className="px-5 py-3 text-sm">
                <p dir="auto">
                  {t('roundCancelled', {
                    date: formatDate(r.cancelledAt, loc),
                    name: r.cancelledBy?.displayName ?? '',
                    reason: r.cancelReason ?? '',
                  })}
                </p>
                <p className="mt-0.5 text-muted">
                  {r.signers
                    .map((x) => `${pick(x.nameEn, x.nameAr, loc)}: ${t(`status.${x.status}`)}`)
                    .join(' · ')}
                </p>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <p className="flex gap-2 text-[0.8125rem] text-muted">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>{t('legalNote')}</span>
      </p>
    </div>
  );
}

function StartCard({ c, can }: { c: ContractDto; can: boolean }) {
  const t = useTranslations('contracts.signing');
  const te = useTranslations('errors');
  const loc = useContractLocale();
  const L = useContractLabels();
  const start = useAction(() => apiPost(`/contracts/${c.id}/signing`), {
    invalidate: [['contracts']],
    success: t('started'),
  });
  const preview = requiredSigners(c.snapshot, new Date().toISOString().slice(0, 10));
  return (
    <Section
      title={t('startTitle')}
      actions={
        can &&
        !('error' in preview) && (
          <Button
            variant="primary"
            disabled={start.isPending}
            onClick={() => start.mutate(undefined)}
          >
            <Send className="size-4 rtl:-scale-x-100" aria-hidden="true" />
            {t('startButton')}
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-3 px-5 py-4 text-sm">
        <ErrorBanner error={start.error} />
        {'error' in preview ? (
          <p className="flex gap-2 text-brick">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              {te(preview.error)} {t('cannotStart')}
            </span>
          </p>
        ) : (
          <>
            <p className="text-muted">{t('startLead')}</p>
            <ol className="flex flex-col gap-2">
              {preview.signers.map((x) => (
                <li key={x.role} className="flex gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-ink text-xs font-semibold text-bg">
                    {x.order}
                  </span>
                  <span>
                    <span className="font-medium">{pick(x.nameEn, x.nameAr, loc)}</span>
                    {' — '}
                    {x.role === 'guardian'
                      ? `${L.signerRole.guardian}${x.relationship ? ` (${x.relationship})` : ''}`
                      : L.signerRole.recipient}
                    {preview.signers.length > 1 && (
                      <span className="block text-muted">
                        {x.role === 'guardian' ? t('whoGuardian') : t('whoRecipient')}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          </>
        )}
        {!can && <p className="text-muted">{t('noPermission')}</p>}
      </div>
    </Section>
  );
}

function RoundView({
  c,
  round,
  can,
}: {
  c: ContractDto;
  round: SigningRoundDto;
  can: ContractSigningDto['can'];
}) {
  const t = useTranslations('contracts.signing');
  const tc = useTranslations('common');
  const loc = useContractLocale();
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const cancel = useAction(
    () => apiPost(`/contracts/${c.id}/signing/cancel`, { reason: reason.trim() }),
    {
      invalidate: [['contracts']],
      success: t('cancelled'),
      onSuccess: () => {
        setCancelling(false);
        setReason('');
      },
    },
  );
  const open = round.status === 'in_progress';
  return (
    <Section
      title={open ? t('roundInProgress', { date: formatDate(round.startedAt, loc) }) : t('signers')}
      lead={round.minor ? t('minorNote', { date: formatIsoDate(round.minorOn, loc) }) : undefined}
      actions={
        open &&
        can.cancel && (
          <Button variant="ghost" onClick={() => setCancelling(true)}>
            {t('cancel')}
          </Button>
        )
      }
    >
      <ol className="divide-y divide-line">
        {round.signers.map((s) => (
          <SignerItem key={s.id} c={c} signer={s} open={open} can={can.manageLinks} />
        ))}
      </ol>
      <div className="border-t border-line px-5 py-3">
        <Fingerprint label={t('approvedFingerprint')} value={round.approvedDocumentSha256} />
      </div>
      {cancelling && (
        <Dialog
          open
          onClose={() => setCancelling(false)}
          title={t('cancel')}
          lead={t('cancelLead')}
          footer={
            <>
              <Button onClick={() => setCancelling(false)}>{tc('cancel')}</Button>
              <Button
                variant="danger"
                disabled={reason.trim().length < 3 || cancel.isPending}
                onClick={() => cancel.mutate(undefined)}
              >
                {cancel.isPending ? tc('saving') : t('cancel')}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <ErrorBanner error={cancel.error} />
            <TextArea
              label={t('cancelReason')}
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              autoFocus
            />
          </div>
        </Dialog>
      )}
    </Section>
  );
}

function SignerItem({
  c,
  signer: s,
  open,
  can,
}: {
  c: ContractDto;
  signer: SignerDto;
  open: boolean;
  can: boolean;
}) {
  const t = useTranslations('contracts.signing');
  const L = useContractLabels();
  const loc = useContractLocale();
  const [dialog, setDialog] = useState<null | 'link' | 'revoke'>(null);
  const revoke = useAction(
    () => apiPost(`/contracts/${c.id}/signing/signers/${s.id}/link/revoke`),
    { invalidate: [['contracts']], success: t('revoked'), onSuccess: () => setDialog(null) },
  );
  const name = pick(s.nameEn, s.nameAr, loc);
  const sig = s.signature;
  const linkText =
    s.link.state === 'active'
      ? t('linkState.active', { date: formatDate(s.link.expiresAt, loc) })
      : t(`linkState.${s.link.state}`);

  return (
    <li className="flex flex-col gap-3 px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[0.8125rem] text-muted">
            {t('signerN', { n: s.order })} ·{' '}
            {s.role === 'guardian'
              ? `${L.signerRole.guardian}${s.relationship ? ` (${s.relationship})` : ''}`
              : L.signerRole.recipient}
          </p>
          <p className="font-medium">{name}</p>
          <p className="text-sm text-muted">
            {[
              s.email && (
                <span key="e" className="ltr-text">
                  {s.email}
                </span>
              ),
              s.phone && (
                <span key="p" className="ltr-text">
                  {s.phone}
                </span>
              ),
            ]
              .filter(Boolean)
              .flatMap((x, i) => (i ? [' · ', x] : [x]))}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {s.status === 'signed' ? (
            <Badge tone="turf">{t('status.signed')}</Badge>
          ) : (
            <Badge tone={s.turn ? 'amber' : 'neutral'}>
              {s.turn ? t('turnNext') : t('turnLater')}
            </Badge>
          )}
        </div>
      </div>

      {s.idDocument.required && <IdDocumentRow c={c} signer={s} name={name} />}

      {sig ? (
        <div className="grid gap-4 rounded-md border border-line bg-panel-2/50 p-4 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
          <div className="flex min-h-16 items-end border-b border-line-strong pb-1">
            {sig.method === 'drawn' && sig.strokes ? (
              <DrawnSignature strokes={sig.strokes} />
            ) : (
              <TypedSignature
                name={sig.typedName ?? ''}
                fontKey={sig.fontKey ?? 'dancing-script'}
              />
            )}
          </div>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted">{t('signedAt')}</dt>
            <dd>{formatDateTime(sig.signedAt, loc)}</dd>
            <dt className="text-muted">{t('signatureMethod')}</dt>
            <dd>{L.signatureMethod[sig.method]}</dd>
            <dt className="text-muted">{t('verification')}</dt>
            <dd>{L.verification[sig.verification]}</dd>
            <dt className="text-muted">{t('ip')}</dt>
            <dd className="ltr-text">{sig.ip ?? '—'}</dd>
            <dt className="text-muted">{t('device')}</dt>
            <dd className="text-[0.8125rem] break-words text-muted">{sig.userAgent ?? '—'}</dd>
            <dt className="text-muted">{t('consent')}</dt>
            <dd lang={sig.consentLocale} dir={sig.consentLocale === 'ar' ? 'rtl' : 'ltr'}>
              {sig.consentText}
            </dd>
          </dl>
        </div>
      ) : (
        open && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line px-3 py-2">
            <p className="flex items-center gap-2 text-sm">
              <Link2 className="size-4 text-muted" aria-hidden="true" />
              <span className={cx(s.link.state === 'locked' && 'text-brick')}>{linkText}</span>
              {s.link.method && s.link.createdBy && (
                <span className="text-muted">
                  ·{' '}
                  {t('linkBy', {
                    method: L.verification[s.link.method],
                    name: s.link.createdBy.displayName,
                  })}
                </span>
              )}
            </p>
            {can && (
              <div className="flex gap-2">
                {s.link.state === 'active' && (
                  <Button size="sm" variant="ghost" onClick={() => setDialog('revoke')}>
                    {t('revokeLink')}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant={s.link.state === 'none' ? 'primary' : 'secondary'}
                  onClick={() => setDialog('link')}
                >
                  {s.link.state === 'none' ? t('createLink') : t('newLink')}
                </Button>
              </div>
            )}
          </div>
        )
      )}

      {dialog === 'link' && <LinkDialog c={c} signer={s} onClose={() => setDialog(null)} />}
      <ConfirmDialog
        open={dialog === 'revoke'}
        title={t('revokeLink')}
        body={t('revokeLead')}
        confirmLabel={t('revokeLink')}
        danger
        busy={revoke.isPending}
        error={revoke.error}
        onConfirm={() => revoke.mutate(undefined)}
        onClose={() => setDialog(null)}
      />
    </li>
  );
}

const FORMAT: Record<string, string> = {
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/webp': 'WebP',
  'application/pdf': 'PDF',
};
const bytes = (n: number, loc: string) =>
  new Intl.NumberFormat(loc === 'ar' ? 'ar-u-nu-latn' : 'en', {
    style: 'unit',
    unit: n >= 1048576 ? 'megabyte' : 'kilobyte',
    maximumFractionDigits: 1,
  }).format(n >= 1048576 ? n / 1048576 : Math.max(1, Math.round(n / 1024)));

/** ID-document patch: provided or not; details and "View" only with the permission. */
function IdDocumentRow({
  c,
  signer: s,
  name,
}: {
  c: ContractDto;
  signer: SignerDto;
  name: string;
}) {
  const t = useTranslations('contracts.signing.idDocument');
  const loc = useContractLocale();
  const [viewing, setViewing] = useState<SignerIdDocumentDto | null>(null);
  const d = s.idDocument;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line px-3 py-2 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <IdCard className="size-4 text-muted" aria-hidden="true" />
        <span className="font-medium">{t('label')}</span>
        <Badge tone={d.provided ? 'turf' : 'amber'}>
          {d.provided ? t('provided') : t('missing')}
        </Badge>
      </p>
      {d.details ? (
        <ul className="flex flex-col gap-1.5">
          {d.details.map((doc) => (
            <li key={doc.id} className="flex flex-wrap items-center gap-2">
              <span className={cx(!doc.current && 'text-muted')}>
                {t('meta', {
                  type: t(`types.${doc.documentType}`),
                  format: FORMAT[doc.contentType] ?? doc.contentType,
                  size: bytes(doc.sizeBytes, loc),
                  date: formatDateTime(doc.uploadedAt, loc),
                })}
              </span>
              <Badge tone={doc.current ? 'turf' : 'neutral'}>
                {doc.current
                  ? s.status === 'signed'
                    ? t('current')
                    : t('currentPending')
                  : t('replaced')}
              </Badge>
              <Button size="sm" variant="ghost" onClick={() => setViewing(doc)}>
                {t('view')}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        d.provided && <p className="text-[0.8125rem] text-muted">{t('needsPermission')}</p>
      )}
      {viewing && (
        <IdDocumentDialog c={c} doc={viewing} name={name} onClose={() => setViewing(null)} />
      )}
    </div>
  );
}

/** Opens one stored document. Each open is a view the API records in the audit log. */
function IdDocumentDialog({
  c,
  doc,
  name,
  onClose,
}: {
  c: ContractDto;
  doc: SignerIdDocumentDto;
  name: string;
  onClose: () => void;
}) {
  const t = useTranslations('contracts.signing.idDocument');
  const tc = useTranslations('common');
  const path = `/contracts/${c.id}/signing/id-documents/${doc.id}`;
  const image = doc.contentType.startsWith('image/');
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!image) return;
    let revoke: string | null = null;
    let live = true;
    fetch(`/api${path}`, { credentials: 'same-origin', cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            error?: { code?: string; message?: string };
          } | null;
          throw new ApiError(
            res.status,
            (body?.error?.code as never) ?? 'internal_error',
            body?.error?.message ?? '',
          );
        }
        const blob = await res.blob();
        revoke = URL.createObjectURL(blob);
        if (live) setUrl(revoke);
      })
      .catch((e: unknown) => live && setError(e));
    return () => {
      live = false;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [image, path]);
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t('viewTitle', { name })}
      lead={t('viewLead')}
      footer={
        <>
          {!image && (
            <Button
              variant="primary"
              onClick={() => {
                setError(null);
                downloadGet(path, 'id-document.pdf').catch(setError);
              }}
            >
              <Download className="size-4" aria-hidden="true" />
              {t('download')}
            </Button>
          )}
          <Button onClick={onClose}>{tc('close')}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <ErrorBanner error={error} />
        {image ? (
          url ? (
            <img
              src={url}
              alt={t('imageAlt', { name })}
              className="mx-auto max-h-[60vh] max-w-full rounded-md border border-line object-contain"
            />
          ) : (
            !error && <Spinner />
          )
        ) : (
          <p className="text-sm text-muted">{t('pdfNote')}</p>
        )}
        <Fingerprint label="SHA-256" value={doc.sha256} />
      </div>
    </Dialog>
  );
}

function LinkDialog({
  c,
  signer,
  onClose,
}: {
  c: ContractDto;
  signer: SignerDto;
  onClose: () => void;
}) {
  const t = useTranslations('contracts.signing');
  const tc = useTranslations('common');
  const loc = useContractLocale();
  const [method, setMethod] = useState<VerificationMethod>(
    signer.email ? 'email_code' : 'access_code',
  );
  const [email, setEmail] = useState(signer.email ?? '');
  const [days, setDays] = useState(SIGNING_LINK_DEFAULT_DAYS);
  const [created, setCreated] = useState<SigningLinkCreatedDto | null>(null);
  const create = useAction(
    () =>
      apiPost<SigningLinkCreatedDto>(`/contracts/${c.id}/signing/signers/${signer.id}/link`, {
        method,
        email: method === 'email_code' ? email.trim() || null : null,
        expiresInDays: days,
      } satisfies CreateSigningLinkInput),
    { invalidate: [['contracts']], onSuccess: setCreated },
  );
  const name = pick(signer.nameEn, signer.nameAr, loc);

  if (created)
    return (
      <Dialog
        open
        onClose={onClose}
        title={t('createdTitle')}
        lead={t('createdLead')}
        footer={
          <Button variant="primary" onClick={onClose}>
            {tc('close')}
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          <CopyField label={t('linkLabel')} value={created.url} />
          {created.accessCode ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-sm font-medium">{t('codeLabel')}</p>
              <p className="ltr-text w-fit rounded-md border border-line-strong bg-panel-2 px-4 py-2 font-mono text-2xl tracking-[0.3em]">
                {created.accessCode}
              </p>
              <p className="text-[0.8125rem] text-muted">{t('codeHint')}</p>
            </div>
          ) : (
            <p className="flex gap-2 text-sm text-muted">
              <Mail className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              {t('emailHint', { email: created.destination ?? '' })}
            </p>
          )}
          <p className="text-sm text-muted">
            {t('expiresOn', { date: formatDateTime(created.expiresAt, loc) })}
          </p>
        </div>
      </Dialog>
    );

  const emailInvalid = method === 'email_code' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('linkDialogTitle', { name })}
      lead={t('linkDialogLead')}
      footer={
        <>
          <Button onClick={onClose}>{tc('cancel')}</Button>
          <Button
            variant="primary"
            disabled={create.isPending || emailInvalid}
            onClick={() => create.mutate(undefined)}
          >
            {create.isPending ? tc('saving') : t('create')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <ErrorBanner error={create.error} />
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">{t('method')}</legend>
          {(
            [
              ['email_code', t('methodEmail'), t('methodEmailHint'), Mail],
              ['access_code', t('methodAccess'), t('methodAccessHint'), KeyRound],
            ] as const
          ).map(([value, label, hint, Icon]) => (
            <label
              key={value}
              className={cx(
                'flex cursor-pointer gap-3 rounded-md border px-3 py-2.5',
                method === value ? 'border-turf bg-turf-soft/40' : 'border-line',
              )}
            >
              <input
                type="radio"
                name="method"
                value={value}
                checked={method === value}
                onChange={() => setMethod(value)}
                className="mt-1 accent-[var(--turf)]"
              />
              <span className="flex flex-col">
                <span className="flex items-center gap-1.5 font-medium">
                  <Icon className="size-4 text-muted" aria-hidden="true" />
                  {label}
                </span>
                <span className="text-[0.8125rem] text-muted">{hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {method === 'email_code' && (
          <TextField
            label={t('emailLabel')}
            type="email"
            dir="ltr"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        )}
        <SelectField
          label={t('expiry')}
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        >
          {EXPIRY_DAYS.map((d) => (
            <option key={d} value={d}>
              {t('days', { count: d })}
            </option>
          ))}
        </SelectField>
      </div>
    </Dialog>
  );
}
