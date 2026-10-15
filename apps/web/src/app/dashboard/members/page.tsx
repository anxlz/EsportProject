'use client';

import type { InvitationDto, MemberDto } from '@esports/shared';
import { useQuery } from '@tanstack/react-query';
import { UserPlus } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { type AssignmentDraft, AssignmentEditor, toInput } from '@/components/assignment-editor';
import {
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  CopyField,
  Dialog,
  EmptyState,
  ErrorBanner,
  PageHeader,
  Section,
  Spinner,
  TextField,
  tableClass,
  tdClass,
  thClass,
} from '@/components/ui';
import { api, apiDelete, apiPost, apiPut } from '@/lib/api';
import { formatDate, roleName } from '@/lib/format';
import { useAction } from '@/lib/mutation';
import { useCan, useMe } from '@/lib/session';

function InviteDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslations('inviteForm');
  const tc = useTranslations('common');
  const can = useCan();
  const [email, setEmail] = useState('');
  const [makeOwner, setMakeOwner] = useState(false);
  const [drafts, setDrafts] = useState<AssignmentDraft[]>([]);
  const [created, setCreated] = useState<{
    inviteUrl: string;
    emailSent: boolean;
    email: string;
  } | null>(null);
  const send = useAction(
    () =>
      apiPost<{ inviteUrl: string; emailSent: boolean; invitation: InvitationDto }>(
        '/invitations',
        {
          email,
          assignments: toInput(drafts),
          makeOwner,
        },
      ),
    {
      invalidate: [['invitations']],
      onSuccess: (r) =>
        setCreated({ inviteUrl: r.inviteUrl, emailSent: r.emailSent, email: r.invitation.email }),
    },
  );

  if (created) {
    return (
      <Dialog
        open
        onClose={onClose}
        title={t('createdTitle')}
        footer={
          <Button variant="primary" onClick={onClose}>
            {tc('close')}
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-muted">
            {created.emailSent ? t('emailSent', { email: created.email }) : t('emailNotSent')}
          </p>
          <CopyField label={t('linkLabel')} value={created.inviteUrl} />
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t('title')}
      lead={t('lead')}
      footer={
        <>
          <Button onClick={onClose}>{tc('cancel')}</Button>
          <Button
            variant="primary"
            disabled={send.isPending || !email.includes('@')}
            onClick={() => send.mutate(undefined)}
          >
            {send.isPending ? t('sending') : t('send')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <ErrorBanner error={send.error} />
        <TextField
          label={t('email')}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="ltr-text"
          autoFocus
        />
        <AssignmentEditor value={drafts} onChange={setDrafts} />
        {can('org.ownership.manage') && (
          <Checkbox
            label={t('makeOwner')}
            hint={t('makeOwnerHint')}
            checked={makeOwner}
            onChange={(e) => setMakeOwner(e.target.checked)}
          />
        )}
      </div>
    </Dialog>
  );
}

function AccessDialog({ member, onClose }: { member: MemberDto; onClose: () => void }) {
  const t = useTranslations('members');
  const tc = useTranslations('common');
  const [drafts, setDrafts] = useState<AssignmentDraft[]>(
    member.assignments.map((a) => ({
      roleId: a.roleId,
      scopeType: a.scopeType,
      scopeId: a.scopeId ?? '',
    })),
  );
  const save = useAction(
    () => apiPut(`/members/${member.userId}/assignments`, { assignments: toInput(drafts) }),
    {
      invalidate: [['members'], ['roles'], ['me']],
      success: t('accessSaved'),
      onSuccess: onClose,
    },
  );
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t('editAccessTitle', { name: member.displayName })}
      lead={t('editAccessLead')}
      footer={
        <>
          <Button onClick={onClose}>{tc('cancel')}</Button>
          <Button
            variant="primary"
            disabled={save.isPending}
            onClick={() => save.mutate(undefined)}
          >
            {save.isPending ? tc('saving') : tc('saveChanges')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <ErrorBanner error={save.error} />
        <AssignmentEditor value={drafts} onChange={setDrafts} />
      </div>
    </Dialog>
  );
}

type PendingAction = {
  kind: 'suspend' | 'reactivate' | 'grantOwner' | 'revokeOwner';
  member: MemberDto;
};

export default function MembersPage() {
  const t = useTranslations('members');
  const ts = useTranslations('scope');
  const tc = useTranslations('common');
  const locale = useLocale();
  const me = useMe();
  const can = useCan();
  const members = useQuery({ queryKey: ['members'], queryFn: () => api<MemberDto[]>('/members') });
  const invitations = useQuery({
    queryKey: ['invitations'],
    queryFn: () => api<InvitationDto[]>('/invitations'),
  });

  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<MemberDto | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [reason, setReason] = useState('');

  const act = useAction(
    (p: PendingAction) => {
      const base = `/members/${p.member.userId}`;
      switch (p.kind) {
        case 'suspend':
          return apiPost(`${base}/suspend`, reason ? { reason } : {});
        case 'reactivate':
          return apiPost(`${base}/reactivate`);
        case 'grantOwner':
          return apiPost(`${base}/ownership`);
        case 'revokeOwner':
          return apiDelete(`${base}/ownership`);
      }
    },
    {
      invalidate: [['members'], ['me']],
      success: () => {
        if (!pending) return '';
        const name = pending.member.displayName;
        return {
          suspend: t('suspended'),
          reactivate: t('reactivated'),
          grantOwner: t('ownershipGranted', { name }),
          revokeOwner: t('ownershipRevoked', { name }),
        }[pending.kind];
      },
      onSuccess: () => {
        setPending(null);
        setReason('');
      },
    },
  );
  const revoke = useAction((id: string) => apiDelete(`/invitations/${id}`), {
    invalidate: [['invitations']],
    success: t('revoked'),
  });

  const canManage = can('members.manage');
  const canOwnership = can('org.ownership.manage');

  const confirmText = (p: PendingAction) => {
    const name = p.member.displayName;
    switch (p.kind) {
      case 'suspend':
        return {
          title: t('suspendTitle', { name }),
          body: t('suspendLead'),
          label: t('suspend'),
          danger: true,
        };
      case 'reactivate':
        return { title: t('reactivate'), body: name, label: t('reactivate'), danger: false };
      case 'grantOwner':
        return {
          title: t('makeOwner'),
          body: t('makeOwnerConfirm', { name }),
          label: t('makeOwner'),
          danger: false,
        };
      case 'revokeOwner':
        return {
          title: t('removeOwner'),
          body: t('removeOwnerConfirm', { name }),
          label: t('removeOwner'),
          danger: true,
        };
    }
  };
  const confirm = pending ? confirmText(pending) : null;

  return (
    <>
      <PageHeader
        title={t('title')}
        lead={t('lead')}
        actions={
          can('members.invite') && (
            <Button variant="primary" onClick={() => setInviting(true)}>
              <UserPlus className="size-4" aria-hidden="true" />
              {t('invite')}
            </Button>
          )
        }
      />

      <div className="flex flex-col gap-8">
        <Section title={t('title')}>
          {members.isLoading ? (
            <Spinner />
          ) : members.error ? (
            <div className="p-5">
              <ErrorBanner error={members.error} />
            </div>
          ) : (
            <div className="relative overflow-x-auto">
              <table className={tableClass}>
                <thead>
                  <tr>
                    <th className={thClass}>{t('member')}</th>
                    <th className={thClass}>{t('access')}</th>
                    <th className={thClass}>{tc('status')}</th>
                    <th className={thClass}>{t('joined')}</th>
                    {(canManage || canOwnership) && (
                      <th className={thClass}>
                        <span className="sr-only">{tc('actions')}</span>
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {(members.data ?? []).map((m) => {
                    const self = m.userId === me.user.id;
                    return (
                      <tr key={m.userId}>
                        <td className={tdClass}>
                          <p className="font-medium">
                            {m.displayName}
                            {self && (
                              <span className="ms-2 text-sm font-normal text-muted">
                                ({tc('you')})
                              </span>
                            )}
                          </p>
                          <p className="ltr-text text-sm text-muted">{m.email}</p>
                        </td>
                        <td className={tdClass}>
                          <div className="flex flex-wrap gap-1.5">
                            {m.isOwner && <Badge tone="turf">{t('owner')}</Badge>}
                            {m.assignments.map((a) => (
                              <Badge key={a.id}>
                                {roleName({ nameEn: a.roleNameEn, nameAr: a.roleNameAr }, locale)}
                                {': '}
                                {a.scopeType === 'organization' ? ts('organization') : a.scopeName}
                              </Badge>
                            ))}
                            {!m.isOwner && m.assignments.length === 0 && (
                              <span className="text-sm text-muted">{t('noRoles')}</span>
                            )}
                          </div>
                        </td>
                        <td className={tdClass}>
                          {m.status === 'active' ? (
                            <Badge tone="turf">{tc('active')}</Badge>
                          ) : (
                            <div className="flex flex-col gap-1">
                              <Badge tone="brick">{tc('suspended')}</Badge>
                              {m.suspendedReason && (
                                <span className="text-[0.8125rem] text-muted">
                                  {m.suspendedReason}
                                </span>
                              )}
                            </div>
                          )}
                        </td>
                        <td className={`${tdClass} whitespace-nowrap`}>
                          {formatDate(m.joinedAt, locale)}
                        </td>
                        {(canManage || canOwnership) && (
                          <td className={`${tdClass} text-end`}>
                            <div className="flex flex-wrap justify-end gap-1">
                              {canManage && m.status === 'active' && (
                                <Button size="sm" variant="ghost" onClick={() => setEditing(m)}>
                                  {t('editAccess')}
                                </Button>
                              )}
                              {canOwnership && m.status === 'active' && !m.isOwner && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => setPending({ kind: 'grantOwner', member: m })}
                                >
                                  {t('makeOwner')}
                                </Button>
                              )}
                              {canOwnership && m.isOwner && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => setPending({ kind: 'revokeOwner', member: m })}
                                >
                                  {t('removeOwner')}
                                </Button>
                              )}
                              {canManage && !self && m.status === 'active' && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="text-brick"
                                  onClick={() => setPending({ kind: 'suspend', member: m })}
                                >
                                  {t('suspend')}
                                </Button>
                              )}
                              {canManage && m.status === 'suspended' && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => setPending({ kind: 'reactivate', member: m })}
                                >
                                  {t('reactivate')}
                                </Button>
                              )}
                            </div>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        <Section title={t('pendingInvitations')}>
          {invitations.isLoading ? (
            <Spinner />
          ) : !invitations.data?.length ? (
            <EmptyState title={t('noPendingInvitations')} />
          ) : (
            <ul className="divide-y divide-line">
              {invitations.data.map((inv) => (
                <li
                  key={inv.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
                >
                  <div>
                    <p className="ltr-text font-medium">{inv.email}</p>
                    <p className="text-sm text-muted">
                      {inv.invitedBy && t('invitedBy', { name: inv.invitedBy.displayName })}
                      {inv.invitedBy && '. '}
                      {t('expiresOn', { date: formatDate(inv.expiresAt, locale) })}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {inv.makeOwner && <Badge tone="turf">{t('owner')}</Badge>}
                    {can('members.invite') && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => revoke.mutate(inv.id)}
                        disabled={revoke.isPending}
                      >
                        {t('revoke')}
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      {inviting && <InviteDialog onClose={() => setInviting(false)} />}
      {editing && <AccessDialog member={editing} onClose={() => setEditing(null)} />}
      {confirm && pending && (
        <ConfirmDialog
          open
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.label}
          danger={confirm.danger}
          busy={act.isPending}
          error={act.error}
          onConfirm={() => act.mutate(pending)}
          onClose={() => {
            setPending(null);
            setReason('');
            act.reset();
          }}
        >
          {pending.kind === 'suspend' && (
            <TextField
              label={t('suspendReason')}
              optional
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          )}
        </ConfirmDialog>
      )}
    </>
  );
}
