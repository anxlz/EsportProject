'use client';

import {
  type DepartmentDto,
  PERMISSIONS,
  type RoleAssignmentInput,
  type RoleDto,
  type ScopeType,
  type TeamDto,
} from '@esports/shared';
import { useQuery } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { api } from '@/lib/api';
import { roleName } from '@/lib/format';
import { Button } from './ui';

export type AssignmentDraft = { roleId: string; scopeType: ScopeType; scopeId: string };

export function toInput(drafts: AssignmentDraft[]): RoleAssignmentInput[] {
  return drafts
    .filter((d) => d.roleId && (d.scopeType === 'organization' || d.scopeId))
    .map((d) => ({
      roleId: d.roleId,
      scopeType: d.scopeType,
      scopeId: d.scopeType === 'organization' ? null : d.scopeId,
    }));
}

const selectClass = 'h-9 w-full rounded-md border border-line-strong bg-panel px-2 text-sm';

/**
 * Edits a list of (role, scope) lines. Each line grants one role over the whole organization,
 * one department, or one team; the member's access is the union of all lines.
 */
export function AssignmentEditor({
  value,
  onChange,
}: {
  value: AssignmentDraft[];
  onChange: (v: AssignmentDraft[]) => void;
}) {
  const t = useTranslations('scope');
  const tm = useTranslations('members');
  const tc = useTranslations('common');
  const tp = useTranslations('permissions');
  const locale = useLocale();
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api<RoleDto[]>('/roles') });
  const departments = useQuery({
    queryKey: ['departments'],
    queryFn: () => api<DepartmentDto[]>('/departments'),
  });
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => api<TeamDto[]>('/teams') });
  const assignable = (roles.data ?? []).filter((r) => !r.isSystem);

  const update = (i: number, patch: Partial<AssignmentDraft>) =>
    onChange(value.map((d, j) => (j === i ? { ...d, ...patch } : d)));

  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-2 text-sm font-medium">{tm('access')}</legend>
      {value.map((d, i) => {
        const role = assignable.find((r) => r.id === d.roleId);
        const orgLevel =
          role && d.scopeType !== 'organization'
            ? role.permissions.filter((p) => !PERMISSIONS[p].scopable)
            : [];
        return (
          <div key={i} className="rounded-md border border-line bg-panel-2 p-3">
            <div className="grid gap-2 sm:grid-cols-[1.2fr_1fr_1.2fr_auto] sm:items-center">
              <select
                aria-label={t('role')}
                className={selectClass}
                value={d.roleId}
                onChange={(e) => update(i, { roleId: e.target.value })}
              >
                <option value="">{t('chooseRole')}</option>
                {assignable.map((r) => (
                  <option key={r.id} value={r.id}>
                    {roleName(r, locale)}
                  </option>
                ))}
              </select>
              <select
                aria-label={t('scopeType')}
                className={selectClass}
                value={d.scopeType}
                onChange={(e) => update(i, { scopeType: e.target.value as ScopeType, scopeId: '' })}
              >
                <option value="organization">{t('organization')}</option>
                <option value="department">{t('department')}</option>
                <option value="team">{t('team')}</option>
              </select>
              {d.scopeType === 'organization' ? (
                <span className="hidden sm:block" />
              ) : (
                <select
                  aria-label={
                    d.scopeType === 'department' ? t('chooseDepartment') : t('chooseTeam')
                  }
                  className={selectClass}
                  value={d.scopeId}
                  onChange={(e) => update(i, { scopeId: e.target.value })}
                >
                  <option value="">
                    {d.scopeType === 'department' ? t('chooseDepartment') : t('chooseTeam')}
                  </option>
                  {(d.scopeType === 'department'
                    ? (departments.data ?? [])
                    : (teams.data ?? [])
                  ).map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </select>
              )}
              <Button
                size="sm"
                variant="ghost"
                aria-label={tc('remove')}
                onClick={() => onChange(value.filter((_, j) => j !== i))}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </div>
            {orgLevel.length > 0 && (
              <p className="mt-2 text-[0.8125rem] text-muted">
                {t('orgLevelNote', {
                  permissions: orgLevel.map((p) => tp(p)).join(locale === 'ar' ? '، ' : ', '),
                })}
              </p>
            )}
          </div>
        );
      })}
      <div>
        <Button
          size="sm"
          onClick={() =>
            onChange([...value, { roleId: '', scopeType: 'organization', scopeId: '' }])
          }
        >
          <Plus className="size-4" aria-hidden="true" />
          {tm('addAssignment')}
        </Button>
      </div>
    </fieldset>
  );
}
