'use client';

import {
  BACKGROUND_KINDS,
  DOCUMENT_LANGUAGES,
  type DocumentLanguage,
  type DocumentSettingsDto,
  LOGO_POSITIONS,
  STAMP_POSITIONS,
  type StoredFileDto,
} from '@esports/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, RefreshCw, Upload } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { ContractsNav, DocumentFrame } from '@/components/contracts/contracts-nav';
import {
  Button,
  Checkbox,
  ErrorBanner,
  PageHeader,
  Section,
  SelectField,
  Spinner,
  TextArea,
  TextField,
  useToast,
} from '@/components/ui';
import { apiPut } from '@/lib/api';
import {
  downloadGet,
  fetchHtml,
  uploadFile,
  useContractLabels,
  useDocumentSettings,
} from '@/lib/contracts';
import { useAction } from '@/lib/mutation';
import { useCan } from '@/lib/session';

type Layout = Omit<
  DocumentSettingsDto,
  'organizationName' | 'stampFileId' | 'stampPosition' | 'stampWidthMm'
>;

const layoutOf = (s: DocumentSettingsDto): Layout => {
  const { organizationName: _n, stampFileId: _f, stampPosition: _p, stampWidthMm: _w, ...rest } = s;
  return rest;
};

function FilePicker({
  label,
  hint,
  kind,
  accept,
  fileId,
  disabled,
  onUploaded,
  onRemove,
}: {
  label: string;
  hint: string;
  kind: 'logo' | 'background' | 'stamp';
  accept: string;
  fileId: string | null;
  disabled: boolean;
  onUploaded: (f: StoredFileDto) => void;
  onRemove: () => void;
}) {
  const t = useTranslations('contracts.settings');
  const toast = useToast();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const isImage = kind !== 'background' || !fileId;
  return (
    <div className="flex flex-col gap-2">
      <span id={id} className="text-sm font-medium">
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex h-16 w-28 items-center justify-center overflow-hidden rounded-md border border-line bg-panel-2">
          {fileId ? (
            isImage ? (
              <img
                src={`/api/files/${fileId}`}
                alt=""
                className="max-h-full max-w-full object-contain"
              />
            ) : (
              <span className="text-xs text-muted">PDF</span>
            )
          ) : (
            <span className="text-xs text-muted">{t('noFile')}</span>
          )}
        </div>
        {!disabled && (
          <>
            <input
              ref={input}
              type="file"
              accept={accept}
              className="sr-only"
              aria-labelledby={id}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                setBusy(true);
                setError(null);
                try {
                  onUploaded(await uploadFile(kind, file));
                  toast(t('uploaded'));
                } catch (err) {
                  setError(err);
                } finally {
                  setBusy(false);
                }
              }}
            />
            <Button size="sm" disabled={busy} onClick={() => input.current?.click()}>
              <Upload className="size-4" aria-hidden="true" />
              {fileId ? t('replace') : t('upload')}
            </Button>
            {fileId && (
              <Button size="sm" variant="ghost" onClick={onRemove}>
                {t('removeFile')}
              </Button>
            )}
          </>
        )}
      </div>
      <p className="text-[0.8125rem] text-muted">{hint}</p>
      <ErrorBanner error={error} />
    </div>
  );
}

function Grid({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 px-5 py-5 sm:grid-cols-2">{children}</div>;
}

function PreviewPanel({ version }: { version: string }) {
  const t = useTranslations('contracts.settings');
  const L = useContractLabels();
  const [language, setLanguage] = useState<DocumentLanguage>('bilingual');
  const [approved, setApproved] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const q = `language=${language}&approved=${approved ? 1 : 0}`;
  const html = useQuery({
    queryKey: ['contract-settings', 'sample', q, version],
    queryFn: () => fetchHtml(`/contract-settings/sample.html?${q}`),
  });
  return (
    <Section
      title={t('preview')}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => html.refetch()}>
            <RefreshCw className="size-4" aria-hidden="true" />
            {t('refresh')}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setErr(null);
              downloadGet(`/contract-settings/sample.pdf?${q}`, 'sample-contract.pdf').catch(
                setErr,
              );
            }}
          >
            <Download className="size-4" aria-hidden="true" />
            {t('downloadSample')}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3 px-5 py-5">
        <div className="flex flex-wrap items-end gap-4">
          <div className="w-56">
            <SelectField
              label={t('previewLanguage')}
              value={language}
              onChange={(e) => setLanguage(e.target.value as DocumentLanguage)}
            >
              {DOCUMENT_LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {L.language[l]}
                </option>
              ))}
            </SelectField>
          </div>
          <div className="pb-2">
            <Checkbox
              label={t('previewApproved')}
              checked={approved}
              onChange={(e) => setApproved(e.target.checked)}
            />
          </div>
        </div>
        <ErrorBanner error={err ?? html.error} />
        {html.isLoading ? <Spinner /> : <DocumentFrame html={html.data} title={t('preview')} />}
      </div>
    </Section>
  );
}

function SettingsForm({ settings }: { settings: DocumentSettingsDto }) {
  const t = useTranslations('contracts.settings');
  const tc = useTranslations('common');
  const L = useContractLabels();
  const can = useCan();
  const qc = useQueryClient();
  const editLayout = can('contracts.manage_templates');
  const editStamp = can('org.settings.edit_sensitive');
  const [form, setForm] = useState<Layout>(layoutOf(settings));
  const [stamp, setStamp] = useState({
    stampFileId: settings.stampFileId,
    stampPosition: settings.stampPosition,
    stampWidthMm: settings.stampWidthMm,
  });
  const [version, setVersion] = useState(0);
  useEffect(() => {
    setForm(layoutOf(settings));
    setStamp({
      stampFileId: settings.stampFileId,
      stampPosition: settings.stampPosition,
      stampWidthMm: settings.stampWidthMm,
    });
  }, [settings]);
  const set = (patch: Partial<Layout>) => setForm((f) => ({ ...f, ...patch }));
  const text = (k: keyof Layout) => ({
    value: (form[k] as string | null) ?? '',
    disabled: !editLayout,
    onChange: (e: { target: { value: string } }) =>
      set({ [k]: e.target.value.trim() === '' ? null : e.target.value } as Partial<Layout>),
  });
  const num = (
    k:
      | 'marginTopMm'
      | 'marginBottomMm'
      | 'marginStartMm'
      | 'marginEndMm'
      | 'fontSizePt'
      | 'lineHeight',
    step = 1,
  ) => ({
    type: 'number',
    step,
    dir: 'ltr' as const,
    value: String(form[k]),
    disabled: !editLayout,
    onChange: (e: { target: { value: string } }) =>
      set({ [k]: Number(e.target.value) } as Partial<Layout>),
  });
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['contract-settings'] });
    setVersion((v) => v + 1);
  };
  const saveLayout = useAction(
    () => apiPut<DocumentSettingsDto>('/contract-settings/document', form),
    {
      invalidate: [],
      success: t('saved'),
      onSuccess: refresh,
    },
  );
  const saveStamp = useAction(
    () => apiPut<DocumentSettingsDto>('/contract-settings/stamp', stamp),
    {
      invalidate: [],
      success: t('stampSaved'),
      onSuccess: refresh,
    },
  );
  const layoutDirty = JSON.stringify(form) !== JSON.stringify(layoutOf(settings));
  const stampDirty =
    stamp.stampFileId !== settings.stampFileId ||
    stamp.stampPosition !== settings.stampPosition ||
    stamp.stampWidthMm !== settings.stampWidthMm;
  const saveButton = editLayout && (
    <Button
      size="sm"
      variant="primary"
      disabled={!layoutDirty || saveLayout.isPending}
      onClick={() => saveLayout.mutate(undefined)}
    >
      {saveLayout.isPending ? tc('saving') : tc('saveChanges')}
    </Button>
  );

  return (
    <div className="flex flex-col gap-5">
      {!editLayout && <p className="text-sm text-muted">{t('ownerOnly')}</p>}
      <ErrorBanner error={saveLayout.error} />
      <div className="grid min-w-0 items-start gap-5 lg:grid-cols-2 [&>*]:min-w-0">
        <Section title={t('legal')} actions={saveButton}>
          <Grid>
            <TextField label={t('legalNameEn')} dir="ltr" optional {...text('legalNameEn')} />
            <TextField label={t('legalNameAr')} dir="rtl" optional {...text('legalNameAr')} />
            <TextField
              label={t('commercialRegistration')}
              dir="ltr"
              optional
              {...text('commercialRegistration')}
            />
            <TextField label={t('taxNumber')} dir="ltr" optional {...text('taxNumber')} />
            <TextArea label={t('addressEn')} dir="ltr" optional rows={2} {...text('addressEn')} />
            <TextArea label={t('addressAr')} dir="rtl" optional rows={2} {...text('addressAr')} />
          </Grid>
        </Section>
        <Section title={t('contact')}>
          <Grid>
            <TextField label={t('email')} type="email" dir="ltr" optional {...text('email')} />
            <TextField label={t('phone')} type="tel" dir="ltr" optional {...text('phone')} />
            <TextField label={t('website')} dir="ltr" optional {...text('website')} />
          </Grid>
        </Section>
        <Section title={t('letterhead')}>
          <Grid>
            <FilePicker
              label={t('logo')}
              hint={t('uploadHint')}
              kind="logo"
              accept="image/png,image/jpeg,image/webp"
              fileId={form.logoFileId}
              disabled={!editLayout}
              onUploaded={(f) => set({ logoFileId: f.id })}
              onRemove={() => set({ logoFileId: null })}
            />
            <SelectField
              label={t('logoPosition')}
              value={form.logoPosition}
              disabled={!editLayout}
              onChange={(e) => set({ logoPosition: e.target.value as Layout['logoPosition'] })}
            >
              {LOGO_POSITIONS.map((p) => (
                <option key={p} value={p}>
                  {t(`positions.${p}`)}
                </option>
              ))}
            </SelectField>
            <TextField label={t('headerTextEn')} dir="ltr" optional {...text('headerTextEn')} />
            <TextField label={t('headerTextAr')} dir="rtl" optional {...text('headerTextAr')} />
            <TextField label={t('footerTextEn')} dir="ltr" optional {...text('footerTextEn')} />
            <TextField label={t('footerTextAr')} dir="rtl" optional {...text('footerTextAr')} />
          </Grid>
        </Section>
        <Section title={t('background')} lead={t('backgroundHint')}>
          <Grid>
            <SelectField
              label={t('background')}
              value={form.backgroundKind}
              disabled={!editLayout}
              onChange={(e) =>
                set({
                  backgroundKind: e.target.value as Layout['backgroundKind'],
                  backgroundFileId: e.target.value === 'none' ? null : form.backgroundFileId,
                })
              }
            >
              {BACKGROUND_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`backgroundKind.${k}`)}
                </option>
              ))}
            </SelectField>
            {form.backgroundKind !== 'none' && (
              <FilePicker
                label={t('background')}
                hint={t('backgroundUploadHint')}
                kind="background"
                accept={form.backgroundKind === 'pdf' ? 'application/pdf' : 'image/png,image/jpeg'}
                fileId={form.backgroundFileId}
                disabled={!editLayout}
                onUploaded={(f) =>
                  set({
                    backgroundFileId: f.id,
                    backgroundKind: f.contentType === 'application/pdf' ? 'pdf' : 'image',
                  })
                }
                onRemove={() => set({ backgroundFileId: null })}
              />
            )}
          </Grid>
        </Section>
        <Section title={t('layout')} actions={saveButton}>
          <Grid>
            <TextField label={t('marginTop')} min={5} max={60} {...num('marginTopMm')} />
            <TextField label={t('marginBottom')} min={5} max={60} {...num('marginBottomMm')} />
            <TextField label={t('marginStart')} min={5} max={50} {...num('marginStartMm')} />
            <TextField label={t('marginEnd')} min={5} max={50} {...num('marginEndMm')} />
            <TextField label={t('fontSize')} min={8} max={14} {...num('fontSizePt', 0.5)} />
            <TextField label={t('lineHeight')} min={1.1} max={2.2} {...num('lineHeight', 0.05)} />
            <SelectField
              label={t('defaultLanguage')}
              value={form.defaultLanguage}
              disabled={!editLayout}
              onChange={(e) => set({ defaultLanguage: e.target.value as DocumentLanguage })}
            >
              {DOCUMENT_LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {L.language[l]}
                </option>
              ))}
            </SelectField>
            <div className="flex items-end pb-2">
              <Checkbox
                label={t('pageBorder')}
                checked={form.pageBorder}
                disabled={!editLayout}
                onChange={(e) => set({ pageBorder: e.target.checked })}
              />
            </div>
          </Grid>
        </Section>
        <Section
          title={t('stamp')}
          lead={t('stampLead')}
          actions={
            editStamp && (
              <Button
                size="sm"
                variant="primary"
                disabled={!stampDirty || saveStamp.isPending}
                onClick={() => saveStamp.mutate(undefined)}
              >
                {saveStamp.isPending ? tc('saving') : t('saveStamp')}
              </Button>
            )
          }
        >
          <Grid>
            <div className="sm:col-span-2">
              <ErrorBanner error={saveStamp.error} />
            </div>
            <FilePicker
              label={t('stampImage')}
              hint={t('uploadHint')}
              kind="stamp"
              accept="image/png,image/jpeg,image/webp"
              fileId={stamp.stampFileId}
              disabled={!editStamp}
              onUploaded={(f) => setStamp((s) => ({ ...s, stampFileId: f.id }))}
              onRemove={() => setStamp((s) => ({ ...s, stampFileId: null }))}
            />
            <div className="flex flex-col gap-4">
              <SelectField
                label={t('stampPosition')}
                value={stamp.stampPosition}
                disabled={!editStamp}
                onChange={(e) =>
                  setStamp((s) => ({
                    ...s,
                    stampPosition: e.target.value as typeof s.stampPosition,
                  }))
                }
              >
                {STAMP_POSITIONS.map((p) => (
                  <option key={p} value={p}>
                    {t(`positions.${p}`)}
                  </option>
                ))}
              </SelectField>
              <TextField
                label={t('stampWidth')}
                type="number"
                min={15}
                max={80}
                dir="ltr"
                value={String(stamp.stampWidthMm)}
                disabled={!editStamp}
                onChange={(e) => setStamp((s) => ({ ...s, stampWidthMm: Number(e.target.value) }))}
              />
            </div>
          </Grid>
        </Section>
      </div>
      <p className="text-sm text-muted">{t('legalNote')}</p>
      <PreviewPanel version={`${version}`} />
    </div>
  );
}

export default function DocumentSetupPage() {
  const t = useTranslations('contracts.settings');
  const can = useCan();
  const allowed = can('contracts.manage_templates') || can('org.settings.edit_sensitive');
  const settings = useDocumentSettings(allowed);
  return (
    <>
      <PageHeader title={t('title')} lead={t('lead')} />
      <ContractsNav />
      {!allowed ? (
        <p className="text-muted">{t('ownerOnly')}</p>
      ) : settings.isLoading ? (
        <Spinner />
      ) : settings.error || !settings.data ? (
        <ErrorBanner error={settings.error} />
      ) : (
        <SettingsForm settings={settings.data} />
      )}
    </>
  );
}
