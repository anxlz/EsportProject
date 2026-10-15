'use client';

import {
  PERMISSION_DOMAINS,
  PERMISSION_KEYS,
  PERMISSIONS,
  type PermissionKey,
  type RoleDto,
} from '@esports/shared';
import { useQuery } from '@tanstack/react-query';
import { Lock, Plus } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  ErrorBanner,
  PageHeader,
  Section,
  Spinner,
  TextField,
} from '@/components/ui';
import { api, apiDelete, apiPost, apiPut } from '@/lib/api';
import { roleName } from '@/lib/format';
import { useAction } from '@/lib/mutation';
import { useCan } from '@/lib/session';

function PermissionKind({ k }: { k: PermissionKey }) {
  const t = useTranslations('roles');
  const def = PERMISSIONS[k];
  if (def.ownerOnly) return <Badge tone="amber">{t('kindOwner')}</Badge>;
  if (def.scopable) return <Badge tone="turf">{t('kindScopable')}</Badge>;
  return <Badge>{t('kindOrg')}</Badge>;
}

function RoleDialog({
  role,
  readOnly,
  onClose,
}: {
  role: RoleDto | null;
  readOnly: boolean;
  onClose: () => void;
}) {
  const t = useTranslations('roles');
  const tc = useTranslations('common');
  const tp = useTranslations('permissions');
  const td = useTranslations('permissionDomains');
  const locked = !!role?.isSystem;
  const disabled = readOnly || locked;
  const [form, setForm] = useState({
    nameEn: role?.nameEn ?? '',
    nameAr: role?.nameAr ?? '',
    descriptionEn: role?.descriptionEn ?? '',
    descriptionAr: role?.descriptionAr ?? '',
  });
  const [perms, setPerms] = useState<Set<PermissionKey>>(
    new Set(role?.grantsAll ? PERMISSION_KEYS : (role?.permissions ?? [])),
  );
  const [showErrors, setShowErrors] = useState(false);
  const save = useAction(
    () => {
      const body = {
        nameEn: form.nameEn || null,
        nameAr: form.nameAr || null,
        descriptionEn: form.descriptionEn || null,
        descriptionAr: form.descriptionAr || null,
        permissions: [...perms],
      };
      return role ? apiPut(`/roles/${role.id}`, body) : apiPost('/roles', body);
    },
    {
      invalidate: [['roles'], ['me']],
      success: role ? t('saved') : t('created'),
      onSuccess: onClose,
    },
  );
  const nameMissing = !form.nameEn.trim() && !form.nameAr.trim();
  const toggle = (k: PermissionKey, on: boolean) =>
    setPerms((s) => {
      const n = new Set(s);
      if (on) n.add(k);
      else n.delete(k);
      return n;
    });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={disabled ? t('viewRole') : role ? t('editRole') : t('newRole')}
      lead={locked ? t('lockedHint') : undefined}
      footer={
        disabled ? (
          <Button onClick={onClose}>{tc('close')}</Button>
        ) : (
          <>
            <Button onClick={onClose}>{tc('cancel')}</Button>
            <Button
              variant="primary"
              disabled={save.isPending}
              onClick={() => {
                setShowErrors(true);
                if (!nameMissing) save.mutate(undefined);
              }}
            >
              {save.isPending ? tc('saving') : role ? tc('saveChanges') : tc('create')}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-5">
        <ErrorBanner error={save.error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label={t('nameEn')}
            value={form.nameEn}
            onChange={set('nameEn')}
            disabled={disabled}
            dir="ltr"
            error={showErrors && nameMissing ? t('nameRequired') : null}
          />
          <TextField
            label={t('nameAr')}
            value={form.nameAr}
            onChange={set('nameAr')}
            disabled={disabled}
            dir="rtl"
            lang="ar"
          />
          <TextField
            label={t('descriptionEn')}
            optional
            value={form.descriptionEn}
            onChange={set('descriptionEn')}
            disabled={disabled}
            dir="ltr"
          />
          <TextField
            label={t('descriptionAr')}
            optional
            value={form.descriptionAr}
            onChange={set('descriptionAr')}
            disabled={disabled}
            dir="rtl"
            lang="ar"
          />
        </div>

        <fieldset>
          <legend className="mb-3 text-base font-semibold">{t('permissions')}</legend>
          <div className="flex flex-col divide-y divide-line rounded-md border border-line">
            {PERMISSION_DOMAINS.map((domain) => {
              const keys = PERMISSION_KEYS.filter((k) => PERMISSIONS[k].domain === domain);
              const grantable = keys.filter((k) => !PERMISSIONS[k].ownerOnly);
              return (
                <div key={domain} className="px-4 py-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="font-medium">{td(domain)}</p>
                    {!disabled && grantable.length > 1 && (
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setPerms((s) => new Set([...s, ...grantable]))}
                        >
                          {t('selectAll')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setPerms((s) => new Set([...s].filter((k) => !keys.includes(k))))
                          }
                        >
                          {t('clearAll')}
                        </Button>
                      </div>
                    )}
                  </div>
                  <ul className="flex flex-col gap-2">
                    {keys.map((k) => {
                      const ownerOnly = PERMISSIONS[k].ownerOnly;
                      const id = `perm-${k}`;
                      return (
                        <li key={k} className="flex flex-wrap items-start justify-between gap-2">
                          <label htmlFor={id} className="flex items-start gap-3">
                            <input
                              id={id}
                              type="checkbox"
                              className="mt-1 size-4 accent-[var(--turf)]"
                              checked={perms.has(k)}
                              disabled={disabled || ownerOnly}
                              onChange={(e) => toggle(k, e.target.checked)}
                              aria-describedby={ownerOnly ? `${id}-hint` : undefined}
                            />
                            <span className="flex flex-col">
                              <span className={ownerOnly && !locked ? 'text-muted' : ''}>
                                {tp(k)}
                              </span>
                              {ownerOnly && !locked && (
                                <span id={`${id}-hint`} className="text-[0.8125rem] text-muted">
                                  {t('ownerOnlyHint')}
                                </span>
                              )}
                            </span>
                          </label>
                          <PermissionKind k={k} />
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        </fieldset>
      </div>
    </Dialog>
  );
}

export default function RolesPage() {
  const t = useTranslations('roles');
  const tc = useTranslations('common');
  const locale = useLocale();
  const can = useCan();
  const manage = can('roles.manage');
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api<RoleDto[]>('/roles') });
  const [open, setOpen] = useState<RoleDto | null | 'new'>(null);
  const [deleting, setDeleting] = useState<RoleDto | null>(null);
  const remove = useAction((id: string) => apiDelete(`/roles/${id}`), {
    invalidate: [['roles']],
    success: t('deleted'),
    onSuccess: () => setDeleting(null),
  });

  return (
    <>
      <PageHeader
        title={t('title')}
        lead={t('lead')}
        actions={
          manage && (
            <Button variant="primary" onClick={() => setOpen('new')}>
              <Plus className="size-4" aria-hidden="true" />
              {t('newRole')}
            </Button>
          )
        }
      />
      <Section title={t('title')}>
        {roles.isLoading ? (
          <Spinner />
        ) : (
          <ul className="divide-y divide-line">
            {(roles.data ?? []).map((r) => {
              const description =
                locale === 'ar'
                  ? (r.descriptionAr ?? r.descriptionEn)
                  : (r.descriptionEn ?? r.descriptionAr);
              return (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-5 py-4"
                >
                  <div className="min-w-0 max-w-xl">
                    <p className="flex items-center gap-2 font-medium">
                      {roleName(r, locale)}
                      {r.isSystem && (
                        <Badge tone="amber">
                          <Lock className="me-1 size-3" aria-hidden="true" />
                          {t('locked')}
                        </Badge>
                      )}
                    </p>
                    {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
                    <p className="mt-1 text-[0.8125rem] text-muted">
                      {r.grantsAll
                        ? t('allPermissions')
                        : t('permissionCount', { count: r.permissions.length })}
                      {'. '}
                      {t('assigned', { count: r.assignmentCount })}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setOpen(r)}>
                      {manage && !r.isSystem ? tc('edit') : t('viewRole')}
                    </Button>
                    {manage && !r.isSystem && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-brick"
                        onClick={() => setDeleting(r)}
                      >
                        {tc('delete')}
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
      {open && (
        <RoleDialog
          role={open === 'new' ? null : open}
          readOnly={!manage}
          onClose={() => setOpen(null)}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        title={deleting ? roleName(deleting, locale) : ''}
        body={deleting ? t('deleteConfirm', { name: roleName(deleting, locale) }) : ''}
        confirmLabel={tc('delete')}
        danger
        busy={remove.isPending}
        error={remove.error}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        onClose={() => {
          setDeleting(null);
          remove.reset();
        }}
      />
    </>
  );
}
