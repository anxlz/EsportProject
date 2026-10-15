'use client';

import type { DepartmentDto, GameDto, TeamDto } from '@esports/shared';
import { useQuery } from '@tanstack/react-query';
import { Download, Pencil, Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorBanner,
  PageHeader,
  Section,
  SelectField,
  Spinner,
  TextArea,
  TextField,
  tableClass,
  tdClass,
  thClass,
} from '@/components/ui';
import { api, apiDelete, apiPatch, apiPost } from '@/lib/api';
import { useAction } from '@/lib/mutation';
import { useCan, useCovers } from '@/lib/session';

type TeamForm = {
  name: string;
  departmentId: string;
  gameId: string;
  region: string;
  status: 'active' | 'inactive';
};

function TeamDialog({
  team,
  departments,
  games,
  onClose,
}: {
  team: TeamDto | null;
  departments: DepartmentDto[];
  games: GameDto[];
  onClose: () => void;
}) {
  const t = useTranslations('teams');
  const tc = useTranslations('common');
  const covers = useCovers();
  const [form, setForm] = useState<TeamForm>({
    name: team?.name ?? '',
    departmentId: team?.departmentId ?? '',
    gameId: team?.gameId ?? '',
    region: team?.region ?? '',
    status: team?.status ?? 'active',
  });
  const save = useAction(
    (f: TeamForm) => {
      const body = {
        name: f.name,
        departmentId: f.departmentId || null,
        gameId: f.gameId || null,
        region: f.region || null,
        status: f.status,
      };
      return team ? apiPatch(`/teams/${team.id}`, body) : apiPost('/teams', body);
    },
    {
      invalidate: [['teams'], ['departments'], ['games']],
      success: team ? t('saved') : t('created'),
      onSuccess: onClose,
    },
  );
  const perm = team ? 'teams.edit' : 'teams.create';
  // Only offer destinations the user may place a team in (the API re-checks).
  const deptOptions = departments.filter(
    (d) => covers.department(perm, d.id) || d.id === team?.departmentId,
  );
  const canNoDept = covers.department(perm, null) || (team !== null && team.departmentId === null);
  const set = (k: keyof TeamForm) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Dialog
      open
      onClose={onClose}
      title={team ? t('editTeam') : t('newTeam')}
      footer={
        <>
          <Button onClick={onClose}>{tc('cancel')}</Button>
          <Button
            variant="primary"
            disabled={save.isPending || !form.name.trim()}
            onClick={() => save.mutate(form)}
          >
            {save.isPending ? tc('saving') : team ? tc('saveChanges') : tc('create')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <ErrorBanner error={save.error} />
        <TextField label={tc('name')} value={form.name} onChange={set('name')} autoFocus />
        <SelectField
          label={t('department')}
          value={form.departmentId}
          onChange={set('departmentId')}
        >
          {canNoDept && <option value="">{t('noDepartment')}</option>}
          {deptOptions.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </SelectField>
        <SelectField label={t('game')} value={form.gameId} onChange={set('gameId')}>
          <option value="">{t('noGame')}</option>
          {games
            .filter((g) => g.isActive || g.id === team?.gameId)
            .map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
        </SelectField>
        <TextField label={t('region')} optional value={form.region} onChange={set('region')} />
        {team && (
          <SelectField label={tc('status')} value={form.status} onChange={set('status')}>
            <option value="active">{tc('active')}</option>
            <option value="inactive">{tc('inactive')}</option>
          </SelectField>
        )}
      </div>
    </Dialog>
  );
}

function DepartmentDialog({
  department,
  onClose,
}: {
  department: DepartmentDto | null;
  onClose: () => void;
}) {
  const t = useTranslations('departments');
  const tc = useTranslations('common');
  const [name, setName] = useState(department?.name ?? '');
  const [description, setDescription] = useState(department?.description ?? '');
  const save = useAction(
    () => {
      const body = { name, description: description || null };
      return department
        ? apiPatch(`/departments/${department.id}`, body)
        : apiPost('/departments', body);
    },
    {
      invalidate: [['departments'], ['teams']],
      success: department ? t('saved') : t('created'),
      onSuccess: onClose,
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={department ? t('editDepartment') : t('newDepartment')}
      footer={
        <>
          <Button onClick={onClose}>{tc('cancel')}</Button>
          <Button
            variant="primary"
            disabled={save.isPending || !name.trim()}
            onClick={() => save.mutate(undefined)}
          >
            {save.isPending ? tc('saving') : department ? tc('saveChanges') : tc('create')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <ErrorBanner error={save.error} />
        <TextField
          label={tc('name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
        <TextArea
          label={t('description')}
          optional
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
    </Dialog>
  );
}

export default function TeamsPage() {
  const t = useTranslations('teams');
  const td = useTranslations('departments');
  const tc = useTranslations('common');
  const can = useCan();
  const covers = useCovers();

  const teams = useQuery({
    queryKey: ['teams'],
    queryFn: () => api<TeamDto[]>('/teams'),
    enabled: can('teams.view'),
  });
  const departments = useQuery({
    queryKey: ['departments'],
    queryFn: () => api<DepartmentDto[]>('/departments'),
    enabled: can('departments.view'),
  });
  const games = useQuery({
    queryKey: ['games'],
    queryFn: () => api<GameDto[]>('/games'),
    enabled: can('games.view'),
  });

  const [filter, setFilter] = useState('');
  const [editingTeam, setEditingTeam] = useState<TeamDto | null | 'new'>(null);
  const [deletingTeam, setDeletingTeam] = useState<TeamDto | null>(null);
  const [editingDept, setEditingDept] = useState<DepartmentDto | null | 'new'>(null);
  const [deletingDept, setDeletingDept] = useState<DepartmentDto | null>(null);

  const removeTeam = useAction((id: string) => apiDelete(`/teams/${id}`), {
    invalidate: [['teams'], ['departments'], ['games']],
    success: t('deleted'),
    onSuccess: () => setDeletingTeam(null),
  });
  const removeDept = useAction((id: string) => apiDelete(`/departments/${id}`), {
    invalidate: [['departments']],
    success: td('deleted'),
    onSuccess: () => setDeletingDept(null),
  });

  const visibleTeams = (teams.data ?? []).filter(
    (x) => !filter || (filter === 'none' ? !x.departmentId : x.departmentId === filter),
  );

  return (
    <>
      <PageHeader
        title={t('title')}
        lead={t('lead')}
        actions={
          <>
            {can('teams.export') && (
              <a
                href="/api/teams/export.csv"
                download
                className="inline-flex h-10 items-center gap-2 rounded-md border border-line-strong bg-panel px-4 font-medium hover:bg-panel-2"
              >
                <Download className="size-4" aria-hidden="true" />
                {t('exportCsv')}
              </a>
            )}
            {can('teams.create') && (
              <Button variant="primary" onClick={() => setEditingTeam('new')}>
                <Plus className="size-4" aria-hidden="true" />
                {t('newTeam')}
              </Button>
            )}
          </>
        }
      />

      <div className="flex flex-col gap-8">
        {can('teams.view') && (
          <Section
            title={t('title')}
            actions={
              departments.data && departments.data.length > 0 ? (
                <label className="flex items-center gap-2 text-sm">
                  <span className="text-muted">{t('filterDepartment')}</span>
                  <select
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    className="h-8 rounded-md border border-line-strong bg-panel px-2"
                  >
                    <option value="">{t('allDepartments')}</option>
                    <option value="none">{t('noDepartment')}</option>
                    {departments.data.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : undefined
            }
          >
            {teams.isLoading ? (
              <Spinner />
            ) : teams.error ? (
              <div className="p-5">
                <ErrorBanner error={teams.error} />
              </div>
            ) : visibleTeams.length === 0 ? (
              <EmptyState
                title={t('empty')}
                lead={can('teams.create') ? t('emptyCanCreate') : t('emptyScoped')}
                action={
                  can('teams.create') ? (
                    <Button variant="primary" onClick={() => setEditingTeam('new')}>
                      {t('newTeam')}
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <div className="relative overflow-x-auto">
                <table className={tableClass}>
                  <thead>
                    <tr>
                      <th className={thClass}>{tc('name')}</th>
                      <th className={thClass}>{t('game')}</th>
                      <th className={thClass}>{t('department')}</th>
                      <th className={thClass}>{t('region')}</th>
                      <th className={thClass}>{tc('status')}</th>
                      <th className={thClass}>
                        <span className="sr-only">{tc('actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleTeams.map((team) => (
                      <tr key={team.id}>
                        <td className={`${tdClass} font-medium whitespace-nowrap`}>{team.name}</td>
                        <td className={`${tdClass} whitespace-nowrap`}>
                          {team.gameName ?? <span className="text-muted">{t('noGame')}</span>}
                        </td>
                        <td className={tdClass}>
                          {team.departmentName ?? (
                            <span className="text-muted">{t('noDepartment')}</span>
                          )}
                        </td>
                        <td className={tdClass}>{team.region ?? ''}</td>
                        <td className={tdClass}>
                          <Badge tone={team.status === 'active' ? 'turf' : 'neutral'}>
                            {team.status === 'active' ? tc('active') : tc('inactive')}
                          </Badge>
                        </td>
                        <td className={`${tdClass} text-end whitespace-nowrap`}>
                          {covers.team('teams.edit', team) && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setEditingTeam(team)}
                              aria-label={`${tc('edit')} ${team.name}`}
                            >
                              <Pencil className="size-4" aria-hidden="true" />
                            </Button>
                          )}
                          {covers.team('teams.delete', team) && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setDeletingTeam(team)}
                              aria-label={`${tc('delete')} ${team.name}`}
                            >
                              <Trash2 className="size-4" aria-hidden="true" />
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        )}

        {can('departments.view') && (
          <Section
            title={td('title')}
            lead={td('lead')}
            actions={
              can('departments.create') ? (
                <Button size="sm" onClick={() => setEditingDept('new')}>
                  <Plus className="size-4" aria-hidden="true" />
                  {td('newDepartment')}
                </Button>
              ) : undefined
            }
          >
            {departments.isLoading ? (
              <Spinner />
            ) : !departments.data?.length ? (
              <EmptyState title={td('empty')} />
            ) : (
              <ul className="divide-y divide-line">
                {departments.data.map((d) => (
                  <li
                    key={d.id}
                    className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
                  >
                    <div>
                      <p className="font-medium">{d.name}</p>
                      <p className="text-sm text-muted">
                        {td('teamCount', { count: d.teamCount })}
                        {d.description ? `. ${d.description}` : ''}
                      </p>
                    </div>
                    <div className="flex gap-1">
                      {can('departments.edit') && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditingDept(d)}
                          aria-label={`${tc('edit')} ${d.name}`}
                        >
                          <Pencil className="size-4" aria-hidden="true" />
                        </Button>
                      )}
                      {can('departments.delete') && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDeletingDept(d)}
                          aria-label={`${tc('delete')} ${d.name}`}
                        >
                          <Trash2 className="size-4" aria-hidden="true" />
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        )}
      </div>

      {editingTeam && (
        <TeamDialog
          team={editingTeam === 'new' ? null : editingTeam}
          departments={departments.data ?? []}
          games={games.data ?? []}
          onClose={() => setEditingTeam(null)}
        />
      )}
      {editingDept && (
        <DepartmentDialog
          department={editingDept === 'new' ? null : editingDept}
          onClose={() => setEditingDept(null)}
        />
      )}
      <ConfirmDialog
        open={!!deletingTeam}
        title={t('deleteTeam')}
        body={deletingTeam ? t('deleteConfirm', { name: deletingTeam.name }) : ''}
        confirmLabel={tc('delete')}
        danger
        busy={removeTeam.isPending}
        error={removeTeam.error}
        onConfirm={() => deletingTeam && removeTeam.mutate(deletingTeam.id)}
        onClose={() => {
          setDeletingTeam(null);
          removeTeam.reset();
        }}
      />
      <ConfirmDialog
        open={!!deletingDept}
        title={deletingDept?.name ?? ''}
        body={deletingDept ? td('deleteConfirm', { name: deletingDept.name }) : ''}
        confirmLabel={tc('delete')}
        danger
        busy={removeDept.isPending}
        error={removeDept.error}
        onConfirm={() => deletingDept && removeDept.mutate(deletingDept.id)}
        onClose={() => {
          setDeletingDept(null);
          removeDept.reset();
        }}
      />
    </>
  );
}
