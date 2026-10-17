'use client';

import type { ContractClause, ContractTypeDto, TemplateClauseDto } from '@esports/shared';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { ClauseList } from '@/components/contracts/contract-forms';
import { ContractsNav } from '@/components/contracts/contracts-nav';
import {
  Badge,
  Button,
  ConfirmDialog,
  cx,
  Dialog,
  ErrorBanner,
  PageHeader,
  Section,
  Spinner,
  TextField,
} from '@/components/ui';
import { api, apiDelete, apiPatch, apiPost, apiPut } from '@/lib/api';
import { pick, useContractLocale, useContractTypes } from '@/lib/contracts';
import { useAction } from '@/lib/mutation';
import { useCan } from '@/lib/session';

function TypeDialog({
  type,
  onClose,
  onCreated,
}: {
  type: ContractTypeDto | null;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const t = useTranslations('contracts.templates');
  const tc = useTranslations('common');
  const [form, setForm] = useState({
    nameEn: type?.nameEn ?? '',
    nameAr: type?.nameAr ?? '',
    descriptionEn: type?.descriptionEn ?? '',
    descriptionAr: type?.descriptionAr ?? '',
  });
  const body = {
    ...form,
    descriptionEn: form.descriptionEn.trim() || null,
    descriptionAr: form.descriptionAr.trim() || null,
  };
  const save = useAction(
    () =>
      type
        ? apiPatch<ContractTypeDto>(`/contract-types/${type.id}`, body)
        : apiPost<ContractTypeDto>('/contract-types', body),
    {
      invalidate: [['contract-types']],
      success: type ? t('typeSaved') : t('typeCreated'),
      onSuccess: (r) => {
        if (!type) onCreated(r.id);
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={type ? t('rename') : t('newType')}
      footer={
        <>
          <Button onClick={onClose}>{tc('cancel')}</Button>
          <Button
            variant="primary"
            disabled={!form.nameEn.trim() || !form.nameAr.trim() || save.isPending}
            onClick={() => save.mutate(undefined)}
          >
            {save.isPending ? tc('saving') : type ? tc('saveChanges') : tc('create')}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <ErrorBanner error={save.error} />
        </div>
        <TextField
          label={t('nameEn')}
          dir="ltr"
          value={form.nameEn}
          onChange={(e) => setForm((f) => ({ ...f, nameEn: e.target.value }))}
          autoFocus
        />
        <TextField
          label={t('nameAr')}
          dir="rtl"
          value={form.nameAr}
          onChange={(e) => setForm((f) => ({ ...f, nameAr: e.target.value }))}
        />
        <TextField
          label={t('descriptionEn')}
          optional
          dir="ltr"
          value={form.descriptionEn}
          onChange={(e) => setForm((f) => ({ ...f, descriptionEn: e.target.value }))}
        />
        <TextField
          label={t('descriptionAr')}
          optional
          dir="rtl"
          value={form.descriptionAr}
          onChange={(e) => setForm((f) => ({ ...f, descriptionAr: e.target.value }))}
        />
      </div>
    </Dialog>
  );
}

/** Template clauses shown through the contract clause list (same controls, template semantics). */
const asClause = (c: TemplateClauseDto): ContractClause => ({
  id: c.id,
  templateClauseId: c.id,
  source: 'template',
  required: c.required,
  included: true,
  titleEn: c.titleEn,
  titleAr: c.titleAr,
  bodyEn: c.bodyEn,
  bodyAr: c.bodyAr,
});

function TemplateEditor({ type, editable }: { type: ContractTypeDto; editable: boolean }) {
  const t = useTranslations('contracts.templates');
  const tc = useTranslations('common');
  const loc = useContractLocale();
  const clauses = useQuery({
    queryKey: ['contract-types', type.id, 'clauses'],
    queryFn: () => api<TemplateClauseDto[]>(`/contract-types/${type.id}/clauses`),
  });
  const [list, setList] = useState<ContractClause[]>([]);
  const [renaming, setRenaming] = useState(false);
  const [removing, setRemoving] = useState(false);
  useEffect(() => setList((clauses.data ?? []).map(asClause)), [clauses.data]);
  const saved = (clauses.data ?? []).map(asClause);
  const dirty = JSON.stringify(list) !== JSON.stringify(saved);
  const knownIds = new Set((clauses.data ?? []).map((c) => c.id));
  const save = useAction(
    () =>
      apiPut(`/contract-types/${type.id}/clauses`, {
        clauses: list.map((c) => ({
          id: knownIds.has(c.id) ? c.id : null,
          required: c.required,
          titleEn: c.titleEn,
          titleAr: c.titleAr,
          bodyEn: c.bodyEn,
          bodyAr: c.bodyAr,
        })),
      }),
    { invalidate: [['contract-types']], success: t('templateSaved') },
  );
  const remove = useAction(() => apiDelete<{ archived: boolean }>(`/contract-types/${type.id}`), {
    invalidate: [['contract-types']],
    success: (r) => (r.archived ? t('typeArchived') : t('typeDeleted')),
    onSuccess: () => setRemoving(false),
  });
  const restore = useAction(() => apiPost(`/contract-types/${type.id}/restore`), {
    invalidate: [['contract-types']],
    success: t('typeRestored'),
  });

  return (
    <Section
      title={pick(type.nameEn, type.nameAr, loc)}
      lead={t('clauseCount', { count: type.clauseCount })}
      actions={
        editable ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setRenaming(true)}>
              {t('rename')}
            </Button>
            {!type.isSystem &&
              (type.archived ? (
                <Button size="sm" onClick={() => restore.mutate(undefined)}>
                  {t('restore')}
                </Button>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => setRemoving(true)}>
                  {t('removeType')}
                </Button>
              ))}
            <Button
              size="sm"
              variant="primary"
              disabled={!dirty || save.isPending}
              onClick={() => save.mutate(undefined)}
            >
              {save.isPending ? tc('saving') : t('saveTemplate')}
            </Button>
          </div>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-4 px-5 py-5">
        <ErrorBanner error={save.error ?? restore.error ?? clauses.error} />
        {clauses.isLoading ? (
          <Spinner />
        ) : (
          <>
            <ClauseList
              template
              clauses={list}
              onChange={setList}
              disabled={!editable}
              modifiedIds={[]}
            />
          </>
        )}
      </div>
      {renaming && (
        <TypeDialog type={type} onClose={() => setRenaming(false)} onCreated={() => undefined} />
      )}
      <ConfirmDialog
        open={removing}
        title={t('removeType')}
        body={t('removeLead')}
        confirmLabel={t('removeType')}
        danger
        busy={remove.isPending}
        error={remove.error}
        onConfirm={() => remove.mutate(undefined)}
        onClose={() => setRemoving(false)}
      />
    </Section>
  );
}

export default function ContractTemplatesPage() {
  const t = useTranslations('contracts.templates');
  const loc = useContractLocale();
  const can = useCan();
  const editable = can('contracts.manage_templates');
  const types = useContractTypes();
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const list = types.data ?? [];
  const current = list.find((x) => x.id === selected) ?? list[0];

  return (
    <>
      <PageHeader
        title={t('title')}
        lead={t('lead')}
        actions={
          editable && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden="true" />
              {t('newType')}
            </Button>
          )
        }
      />
      <ContractsNav />
      <div className="mb-5 flex flex-col gap-2">
        <p className="text-sm text-muted">{t('sampleWording')}</p>
        {!editable && <p className="text-sm text-muted">{t('ownerOnly')}</p>}
      </div>
      {types.isLoading ? (
        <Spinner />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[16rem_minmax(0,1fr)]">
          <nav aria-label={t('pick')}>
            <ul className="flex gap-2 overflow-x-auto lg:flex-col">
              {list.map((x) => (
                <li key={x.id} className="shrink-0">
                  <button
                    type="button"
                    aria-current={current?.id === x.id ? 'true' : undefined}
                    onClick={() => setSelected(x.id)}
                    className={cx(
                      'flex w-full flex-col items-start gap-1 rounded-lg border px-4 py-3 text-start',
                      current?.id === x.id
                        ? 'border-turf bg-turf-soft'
                        : 'border-line bg-panel hover:bg-panel-2',
                    )}
                  >
                    <span className="font-medium">{pick(x.nameEn, x.nameAr, loc)}</span>
                    <span className="flex flex-wrap gap-1.5">
                      <Badge>{x.isSystem ? t('system') : t('custom')}</Badge>
                      {x.archived && <Badge tone="amber">{t('archived')}</Badge>}
                      <span className="text-[0.8125rem] text-muted">
                        {t('clauseCount', { count: x.clauseCount })}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          {current && <TemplateEditor key={current.id} type={current} editable={editable} />}
        </div>
      )}
      {creating && (
        <TypeDialog type={null} onClose={() => setCreating(false)} onCreated={setSelected} />
      )}
    </>
  );
}
