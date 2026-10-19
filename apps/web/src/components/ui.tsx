'use client';

import { useTranslations } from 'next-intl';
import {
  type ButtonHTMLAttributes,
  createContext,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { ApiError } from '@/lib/api';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ------------------------------------------------------------------------------------------
// Buttons
// ------------------------------------------------------------------------------------------

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const variants: Record<Variant, string> = {
  primary: 'bg-turf text-turf-ink hover:bg-turf-hover border border-transparent',
  secondary: 'bg-panel text-ink border border-line-strong hover:bg-panel-2',
  ghost: 'bg-transparent text-ink border border-transparent hover:bg-panel-2',
  danger: 'bg-brick text-white border border-transparent hover:opacity-90',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' }) {
  return (
    <button
      type="button"
      {...props}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-55',
        size === 'sm' ? 'h-8 px-3 text-sm' : 'h-10 px-4 text-[0.9375rem]',
        variants[variant],
        className,
      )}
    />
  );
}

// ------------------------------------------------------------------------------------------
// Form fields
// ------------------------------------------------------------------------------------------

function FieldShell({
  id,
  label,
  hint,
  error,
  optional,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string | null;
  optional?: boolean;
  children: ReactNode;
}) {
  const t = useTranslations('common');
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
        {optional && <span className="ms-1.5 font-normal text-muted">({t('optional')})</span>}
      </label>
      {children}
      {hint && !error && (
        <p id={`${id}-hint`} className="text-[0.8125rem] text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-[0.8125rem] text-brick" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

const inputClass =
  'h-10 w-full rounded-md border border-line-strong bg-panel px-3 text-ink placeholder:text-muted/70 focus:border-turf disabled:bg-panel-2';

export function TextField({
  label,
  hint,
  error,
  optional,
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
  error?: string | null;
  optional?: boolean;
}) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} optional={optional}>
      <input
        id={id}
        aria-invalid={!!error || undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        {...props}
        className={cx(inputClass, className)}
      />
    </FieldShell>
  );
}

export function TextArea({
  label,
  hint,
  optional,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: string;
  hint?: string;
  optional?: boolean;
}) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} hint={hint} optional={optional}>
      <textarea
        id={id}
        rows={3}
        {...props}
        className="w-full rounded-md border border-line-strong bg-panel px-3 py-2 text-ink focus:border-turf"
      />
    </FieldShell>
  );
}

export function SelectField({
  label,
  hint,
  optional,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string; hint?: string; optional?: boolean }) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} hint={hint} optional={optional}>
      <select id={id} {...props} className={inputClass}>
        {children}
      </select>
    </FieldShell>
  );
}

export function Checkbox({
  label,
  hint,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; hint?: ReactNode }) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="checkbox"
        {...props}
        className="mt-1 size-4 shrink-0 accent-[var(--turf)]"
      />
      <label htmlFor={id} className="flex flex-col">
        <span className="text-ink">{label}</span>
        {hint && <span className="text-[0.8125rem] text-muted">{hint}</span>}
      </label>
    </div>
  );
}

// ------------------------------------------------------------------------------------------
// Errors
// ------------------------------------------------------------------------------------------

export function useErrorText() {
  const t = useTranslations('errors');
  return useCallback(
    (err: unknown): string => {
      const code = err instanceof ApiError ? err.code : 'internal_error';
      return t.has(code) ? t(code) : t('internal_error');
    },
    [t],
  );
}

export function ErrorBanner({ error }: { error: unknown }) {
  const text = useErrorText();
  if (!error) return null;
  return (
    <div
      role="alert"
      className="rounded-md border border-brick/30 bg-brick-soft px-4 py-3 text-sm text-ink"
    >
      {text(error)}
    </div>
  );
}

// ------------------------------------------------------------------------------------------
// Layout pieces
// ------------------------------------------------------------------------------------------

export function PageHeader({
  title,
  lead,
  actions,
}: {
  title: string;
  lead?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {lead && <p className="mt-1.5 text-muted">{lead}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

export function Section({
  title,
  lead,
  actions,
  children,
}: {
  title: string;
  lead?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-lg border border-line bg-panel">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div>
          <h2 className="text-base font-semibold text-ink">{title}</h2>
          {lead && <p className="mt-0.5 text-sm text-muted">{lead}</p>}
        </div>
        {actions}
      </div>
      <div>{children}</div>
    </section>
  );
}

export function EmptyState({
  title,
  lead,
  action,
}: {
  title: string;
  lead?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-2 px-5 py-10">
      <p className="font-medium text-ink">{title}</p>
      {lead && <p className="text-sm text-muted">{lead}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'turf' | 'amber' | 'brick';
  children: ReactNode;
}) {
  const tones = {
    neutral: 'bg-panel-2 text-muted border-line',
    turf: 'bg-turf-soft text-turf border-transparent',
    amber: 'bg-amber-soft text-amber-ink border-transparent',
    brick: 'bg-brick-soft text-brick border-transparent',
  } as const;
  return (
    <span
      className={cx(
        'inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium',
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Spinner({ label }: { label?: string }) {
  const t = useTranslations('common');
  return (
    <p className="px-5 py-8 text-sm text-muted" role="status">
      {label ?? t('loading')}
    </p>
  );
}

export const tableClass = 'w-full border-collapse text-start text-[0.9375rem]';
export const thClass =
  'border-b border-line bg-panel-2 px-5 py-2.5 text-start text-[0.8125rem] font-medium text-muted';
export const tdClass = 'border-b border-line px-5 py-3 align-top';
/** Header cell for a numeric (end-aligned) column. */
export const thEndClass = thClass.replace('text-start', 'text-end');

// ------------------------------------------------------------------------------------------
// Dialog (native <dialog>)
// ------------------------------------------------------------------------------------------

export function Dialog({
  open,
  onClose,
  title,
  lead,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  lead?: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className={cx(
        'm-auto max-h-[90dvh] w-[calc(100%-2rem)] rounded-lg border border-line bg-panel p-0 text-ink shadow-xl',
        wide ? 'max-w-3xl' : 'max-w-lg',
      )}
    >
      {open && (
        <div className="flex max-h-[90dvh] flex-col">
          <div className="border-b border-line px-6 pt-5 pb-4">
            <h2 id={titleId} className="text-lg font-semibold">
              {title}
            </h2>
            {lead && <p className="mt-1 text-sm text-muted">{lead}</p>}
          </div>
          <div className="overflow-y-auto px-6 py-5">{children}</div>
          {footer && (
            <div className="flex flex-wrap justify-end gap-2 border-t border-line px-6 py-4">
              {footer}
            </div>
          )}
        </div>
      )}
    </dialog>
  );
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  danger,
  busy,
  confirmDisabled,
  error,
  onConfirm,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  body?: string;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  /** Keeps the confirm button disabled (e.g. until a required choice is made). */
  confirmDisabled?: boolean;
  error?: unknown;
  onConfirm: () => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  const t = useTranslations('common');
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      lead={body}
      footer={
        <>
          <Button onClick={onClose}>{t('cancel')}</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={onConfirm}
            disabled={busy || confirmDisabled}
          >
            {busy ? t('saving') : confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {children}
        <ErrorBanner error={error} />
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------------------------------
// Toasts (announced to screen readers)
// ------------------------------------------------------------------------------------------

const ToastContext = createContext<(message: string) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<{ id: number; message: string }[]>([]);
  const push = useCallback((message: string) => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs, { id, message }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 4000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 start-4 z-50 flex flex-col gap-2"
      >
        {items.map((x) => (
          <div key={x.id} className="rounded-md bg-ink px-4 py-2.5 text-sm text-bg shadow-lg">
            {x.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

export function CopyField({ label, value }: { label: string; value: string }) {
  const t = useTranslations('common');
  const [copied, setCopied] = useState(false);
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          readOnly
          value={value}
          className={cx(inputClass, 'ltr-text font-normal')}
          onFocus={(e) => e.target.select()}
        />
        <Button
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          {copied ? t('copied') : t('copy')}
        </Button>
      </div>
    </div>
  );
}

export { cx };
