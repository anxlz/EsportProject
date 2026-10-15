'use client';

import type { GameDto } from '@esports/shared';
import { useQuery } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import {
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  ErrorBanner,
  PageHeader,
  Section,
  Spinner,
  TextField,
  tableClass,
  tdClass,
  thClass,
} from '@/components/ui';
import { api, apiDelete, apiPatch, apiPost } from '@/lib/api';
import { useAction } from '@/lib/mutation';
import { useCan } from '@/lib/session';

function GameDialog({ game, onClose }: { game: GameDto | null; onClose: () => void }) {
  const t = useTranslations('games');
  const tc = useTranslations('common');
  const [name, setName] = useState(game?.name ?? '');
  const [shortName, setShortName] = useState(game?.shortName ?? '');
  const [isActive, setIsActive] = useState(game?.isActive ?? true);
  const save = useAction(
    () => {
      const body = { name, shortName: shortName || null, isActive };
      return game ? apiPatch(`/games/${game.id}`, body) : apiPost('/games', body);
    },
    { invalidate: [['games']], success: game ? t('saved') : t('created'), onSuccess: onClose },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={game ? t('editGame') : t('newGame')}
      footer={
        <>
          <Button onClick={onClose}>{tc('cancel')}</Button>
          <Button variant="primary" disabled={save.isPending || !name.trim()} onClick={() => save.mutate(undefined)}>
            {save.isPending ? tc('saving') : game ? tc('saveChanges') : tc('add')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <ErrorBanner error={save.error} />
        <TextField label={tc('name')} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <TextField label={t('shortName')} optional value={shortName} onChange={(e) => setShortName(e.target.value)} />
        <Checkbox label={t('isActive')} checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
      </div>
    </Dialog>
  );
}

export default function GamesPage() {
  const t = useTranslations('games');
  const tc = useTranslations('common');
  const can = useCan();
  const manage = can('games.manage');
  const games = useQuery({ queryKey: ['games'], queryFn: () => api<GameDto[]>('/games') });
  const [editing, setEditing] = useState<GameDto | null | 'new'>(null);
  const [deleting, setDeleting] = useState<GameDto | null>(null);
  const toggle = useAction((g: GameDto) => apiPatch(`/games/${g.id}`, { isActive: !g.isActive }), {
    invalidate: [['games']],
    success: t('saved'),
  });
  const remove = useAction((id: string) => apiDelete(`/games/${id}`), {
    invalidate: [['games']],
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
            <Button variant="primary" onClick={() => setEditing('new')}>
              <Plus className="size-4" aria-hidden="true" />
              {t('newGame')}
            </Button>
          )
        }
      />
      <Section title={t('title')}>
        {games.isLoading ? (
          <Spinner />
        ) : (
          <div className="relative overflow-x-auto">
            <ErrorBanner error={games.error ?? toggle.error} />
            <table className={tableClass}>
              <thead>
                <tr>
                  <th className={thClass}>{tc('name')}</th>
                  <th className={thClass}>{t('shortName')}</th>
                  <th className={thClass}>{t('teamCount')}</th>
                  <th className={thClass}>{tc('status')}</th>
                  {manage && (
                    <th className={thClass}>
                      <span className="sr-only">{tc('actions')}</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {(games.data ?? []).map((g) => (
                  <tr key={g.id} className={g.isActive ? '' : 'text-muted'}>
                    <td className={`${tdClass} font-medium`}>{g.name}</td>
                    <td className={`${tdClass} ltr-text`}>{g.shortName}</td>
                    <td className={tdClass}>{g.teamCount}</td>
                    <td className={tdClass}>
                      <Badge tone={g.isActive ? 'turf' : 'neutral'}>{g.isActive ? tc('active') : tc('inactive')}</Badge>
                    </td>
                    {manage && (
                      <td className={`${tdClass} text-end whitespace-nowrap`}>
                        <Button size="sm" variant="ghost" onClick={() => toggle.mutate(g)} disabled={toggle.isPending}>
                          {g.isActive ? t('deactivate') : t('activate')}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(g)} aria-label={`${tc('edit')} ${g.name}`}>
                          <Pencil className="size-4" aria-hidden="true" />
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setDeleting(g)} aria-label={`${tc('delete')} ${g.name}`}>
                          <Trash2 className="size-4" aria-hidden="true" />
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      {editing && <GameDialog game={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={!!deleting}
        title={deleting?.name ?? ''}
        body={deleting ? t('deleteConfirm', { name: deleting.name }) : ''}
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
