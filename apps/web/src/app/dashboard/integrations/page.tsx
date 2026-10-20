'use client';

import {
  INCOMING_WEBHOOK_ACTIONS,
  type IncomingWebhookAction,
  type IntegrationDto,
  type IntegrationEventDto,
  type IntegrationProvider,
  type IntegrationSecretDto,
  type SyncDirection,
  type TeamDto,
  WEBHOOK_EVENT_TYPES,
  type WebhookEventType,
} from '@esports/shared';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, CalendarDays, FileText, Plug, Webhook } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  CopyField,
  cx,
  Dialog,
  EmptyState,
  ErrorBanner,
  PageHeader,
  Section,
  SelectField,
  Spinner,
  TextField,
  useToast,
} from '@/components/ui';
import { api, apiPatch, apiPost } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { browserTimeZone, COMMON_TIME_ZONES, useIntegrations } from '@/lib/meetings';
import { useAction } from '@/lib/mutation';
import { useCan } from '@/lib/session';

const ICONS: Record<IntegrationProvider, typeof Plug> = {
  google_calendar: CalendarDays,
  notion: FileText,
  obsidian: BookOpen,
  webhook_outgoing: Webhook,
  webhook_incoming: Webhook,
};
const invalidate = [['integrations']];

function useTeams() {
  const can = useCan();
  return useQuery({
    queryKey: ['teams'],
    queryFn: () => api<TeamDto[]>('/teams'),
    enabled: can('teams.view'),
  });
}

function TeamSelect({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('integrations');
  const teams = useTeams();
  if (!teams.data?.length) return null;
  return (
    <SelectField
      label={t('teamFilter')}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{t('allTeams')}</option>
      {teams.data.map((x) => (
        <option key={x.id} value={x.id}>
          {x.name}
        </option>
      ))}
    </SelectField>
  );
}

function DirectionSelect({
  value,
  onChange,
  disabled,
}: {
  value: SyncDirection;
  onChange: (v: SyncDirection) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('integrations.direction');
  return (
    <SelectField
      label={t('label')}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as SyncDirection)}
    >
      <option value="two_way">{t('two_way')}</option>
      <option value="push_only">{t('push_only')}</option>
    </SelectField>
  );
}

/** A secret shown once, right after it was created. */
function SecretDialog({
  result,
  onClose,
  children,
}: {
  result: IntegrationSecretDto | null;
  onClose: () => void;
  children?: React.ReactNode;
}) {
  const t = useTranslations('integrations');
  const tc = useTranslations('common');
  return (
    <Dialog
      open={!!result}
      onClose={onClose}
      title={t('secretTitle')}
      lead={t('secretOnce')}
      footer={
        <Button variant="primary" onClick={onClose}>
          {tc('close')}
        </Button>
      }
    >
      {result && (
        <div className="flex flex-col gap-4">
          {result.integration.settings.endpointUrl && (
            <CopyField label={t('endpoint')} value={result.integration.settings.endpointUrl} />
          )}
          <CopyField
            label={
              result.integration.provider === 'obsidian'
                ? t('obsidian.token')
                : t('webhooks.secret')
            }
            value={result.secret}
          />
          {children}
        </div>
      )}
    </Dialog>
  );
}

function EventLog({ id }: { id: string }) {
  const t = useTranslations('integrations');
  const locale = useLocale();
  const log = useQuery({
    queryKey: ['integrations', id, 'events'],
    queryFn: () => api<IntegrationEventDto[]>(`/integrations/${id}/events`),
  });
  if (log.isLoading) return <Spinner />;
  if (!log.data?.length) return <p className="px-5 py-3 text-sm text-muted">{t('logEmpty')}</p>;
  return (
    <ul className="max-h-72 divide-y divide-line overflow-y-auto border-t border-line">
      {log.data.map((e) => (
        <li key={e.id} className="flex flex-wrap items-baseline gap-x-3 px-5 py-2 text-sm">
          <span
            className={cx(
              'size-2 shrink-0 rounded-full',
              e.level === 'error' ? 'bg-brick' : e.level === 'warn' ? 'bg-amber' : 'bg-turf',
            )}
            aria-hidden="true"
          />
          <span className="font-medium">
            {t.has(`eventCodes.${e.code}` as never) ? t(`eventCodes.${e.code}` as never) : e.code}
          </span>
          <span className="text-muted">{formatDateTime(e.createdAt, locale)}</span>
          <details className="w-full ps-5 text-[0.8125rem] text-muted">
            <summary className="cursor-pointer">{t('technical')}</summary>
            <p dir="ltr" className="text-start">
              {e.message}
            </p>
          </details>
        </li>
      ))}
    </ul>
  );
}

function ConnectionCard({ c }: { c: IntegrationDto }) {
  const t = useTranslations('integrations');
  const locale = useLocale();
  const [showLog, setShowLog] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [rotated, setRotated] = useState<IntegrationSecretDto | null>(null);
  const update = useAction(
    (body: Record<string, unknown>) => apiPatch<IntegrationDto>(`/integrations/${c.id}`, body),
    { invalidate, success: t('saved') },
  );
  const sync = useAction(() => apiPost(`/integrations/${c.id}/sync`), {
    invalidate,
    success: t('syncQueued'),
  });
  const rotate = useAction(
    () => apiPost<IntegrationSecretDto>(`/integrations/${c.id}/rotate-secret`),
    { invalidate, onSuccess: setRotated },
  );
  const reset = useAction(() => apiPost(`/integrations/${c.id}/reset-verification`), {
    invalidate,
  });
  const disconnect = useAction(() => apiPost(`/integrations/${c.id}/disconnect`), {
    invalidate,
    success: t('disconnected'),
    onSuccess: () => setDisconnecting(false),
  });
  const Icon = ICONS[c.provider];
  const status = c.paused ? 'paused' : c.status;
  const twoWayCapable =
    c.provider === 'google_calendar' || c.provider === 'notion' || c.provider === 'obsidian';
  const syncable = c.provider === 'google_calendar' || c.provider === 'notion';
  const secretful =
    c.provider === 'obsidian' ||
    c.provider === 'webhook_outgoing' ||
    c.provider === 'webhook_incoming';

  return (
    <li className="rounded-lg border border-line bg-panel">
      <div className="flex flex-wrap items-start gap-3 px-5 py-4">
        <Icon className="mt-0.5 size-5 shrink-0 text-turf" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 font-medium">
            {c.provider === 'webhook_outgoing' ||
            c.provider === 'webhook_incoming' ||
            c.provider === 'notion'
              ? c.name
              : t(`providers.${c.provider}`)}
            <Badge tone={status === 'active' ? 'turf' : status === 'error' ? 'brick' : 'neutral'}>
              {t(`status.${status}`)}
            </Badge>
            {c.direction && <Badge>{t(`direction.${c.direction}`)}</Badge>}
          </p>
          <p className="text-[0.8125rem] text-muted">
            {[
              t(`providers.${c.provider}`),
              c.teamName ? t('onlyTeam', { team: c.teamName }) : null,
              c.settings.calendarId && c.settings.calendarId !== 'primary'
                ? c.settings.calendarId
                : null,
              c.settings.databaseTitle ?? null,
              c.settings.url ?? null,
              !c.personal && c.owner ? t('actsAs', { name: c.owner.displayName }) : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          <p className="mt-1 text-[0.8125rem] text-muted">
            {c.lastSyncAt
              ? t('lastSync', { when: formatDateTime(c.lastSyncAt, locale) })
              : t('neverSynced')}
            {' · '}
            {t('linked', { count: c.linkedMeetings })}
            {c.pendingJobs > 0 && ` · ${t('pending', { count: c.pendingJobs })}`}
          </p>
          {c.lastError && (
            <p className="mt-1 text-[0.8125rem] text-brick">
              {t('lastError', { when: formatDateTime(c.lastError.at, locale) })}{' '}
              <span dir="ltr">{c.lastError.code}</span>
            </p>
          )}
        </div>
      </div>

      {c.provider === 'notion' && (
        <div className="flex flex-col gap-3 border-t border-line px-5 py-4">
          <CopyField label={t('notion.webhookUrl')} value={c.settings.endpointUrl ?? ''} />
          {c.settings.verificationToken ? (
            <div className="flex flex-col gap-2">
              <CopyField
                label={t('notion.verificationToken')}
                value={c.settings.verificationToken}
              />
              <div>
                <Button size="sm" variant="ghost" onClick={() => reset.mutate(undefined)}>
                  {t('notion.resetVerification')}
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted">{t('notion.waiting')}</p>
          )}
        </div>
      )}
      {c.provider === 'webhook_incoming' && c.settings.endpointUrl && (
        <div className="flex flex-col gap-2 border-t border-line px-5 py-4">
          <CopyField label={t('endpoint')} value={c.settings.endpointUrl} />
          <p className="text-[0.8125rem] text-muted">{t('webhooks.signingHint')}</p>
          <p className="text-[0.8125rem] text-muted">
            {t('webhooks.accepts', {
              actions: (c.settings.actions ?? []).map((a) => t(`actions.${a}`)).join(', '),
            })}
          </p>
        </div>
      )}
      {c.provider === 'webhook_outgoing' && (
        <p className="border-t border-line px-5 py-3 text-[0.8125rem] text-muted">
          {t('webhooks.sends', {
            events: (c.settings.events ?? []).map((e) => t(`webhookEvents.${e}`)).join(', '),
          })}
        </p>
      )}

      <div className="flex flex-wrap items-end gap-3 border-t border-line px-5 py-3">
        {twoWayCapable && c.direction && (
          <div className="w-56">
            <DirectionSelect
              value={c.direction}
              disabled={update.isPending}
              onChange={(direction) => update.mutate({ direction })}
            />
          </div>
        )}
        {syncable && (
          <Button
            size="sm"
            disabled={sync.isPending || c.paused || c.status !== 'active'}
            onClick={() => sync.mutate(undefined)}
          >
            {t('syncNow')}
          </Button>
        )}
        <Button
          size="sm"
          disabled={update.isPending}
          onClick={() => update.mutate({ paused: !c.paused })}
        >
          {c.paused ? t('resume') : t('pause')}
        </Button>
        {c.status === 'error' && (
          <Button
            size="sm"
            variant="primary"
            disabled={update.isPending}
            onClick={() => update.mutate({ paused: false, name: c.name })}
          >
            {t('retry')}
          </Button>
        )}
        {secretful && (
          <Button size="sm" disabled={rotate.isPending} onClick={() => rotate.mutate(undefined)}>
            {c.provider === 'obsidian' ? t('obsidian.newToken') : t('webhooks.newSecret')}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={showLog}
          onClick={() => setShowLog((v) => !v)}
        >
          {t('activity')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="ms-auto text-brick"
          onClick={() => setDisconnecting(true)}
        >
          {t('disconnect')}
        </Button>
      </div>
      <ErrorBanner error={update.error ?? sync.error ?? rotate.error} />
      {showLog && <EventLog id={c.id} />}
      <ConfirmDialog
        open={disconnecting}
        title={t('disconnectTitle')}
        body={t('disconnectBody')}
        confirmLabel={t('disconnect')}
        danger
        busy={disconnect.isPending}
        error={disconnect.error}
        onConfirm={() => disconnect.mutate(undefined)}
        onClose={() => setDisconnecting(false)}
      />
      <SecretDialog result={rotated} onClose={() => setRotated(null)}>
        {rotated?.integration.provider === 'obsidian' && <ObsidianHowTo token={rotated.secret} />}
      </SecretDialog>
    </li>
  );
}

function GoogleConnect({ configured }: { configured: boolean }) {
  const t = useTranslations('integrations');
  const [direction, setDirection] = useState<SyncDirection>('two_way');
  const [calendar, setCalendar] = useState<'primary' | 'dedicated'>('primary');
  const [calendarId, setCalendarId] = useState('');
  const [teamId, setTeamId] = useState('');
  if (!configured)
    return <p className="px-5 py-4 text-sm text-muted">{t('google.notConfigured')}</p>;
  const q = new URLSearchParams({
    direction,
    calendarId: calendar === 'primary' ? 'primary' : calendarId.trim(),
  });
  if (teamId) q.set('teamId', teamId);
  return (
    <div className="flex flex-col gap-4 px-5 py-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <DirectionSelect value={direction} onChange={setDirection} />
        <SelectField
          label={t('google.calendar')}
          value={calendar}
          onChange={(e) => setCalendar(e.target.value as 'primary' | 'dedicated')}
        >
          <option value="primary">{t('google.primary')}</option>
          <option value="dedicated">{t('google.dedicated')}</option>
        </SelectField>
        {calendar === 'dedicated' && (
          <TextField
            label={t('google.calendarId')}
            dir="ltr"
            value={calendarId}
            placeholder="team@group.calendar.google.com"
            onChange={(e) => setCalendarId(e.target.value)}
          />
        )}
        <TeamSelect value={teamId} onChange={setTeamId} />
      </div>
      <p className="text-[0.8125rem] text-muted">
        {calendar === 'primary' ? t('google.primaryHint') : t('google.dedicatedHint')}
      </p>
      <div>
        {/* A full-page navigation: Google's consent screen, then back here. */}
        <a
          href={`/api/integrations/google/start?${q.toString()}`}
          aria-disabled={calendar === 'dedicated' && !calendarId.trim()}
          className={cx(
            'inline-flex h-10 items-center rounded-md bg-turf px-4 text-[0.9375rem] font-medium text-turf-ink hover:bg-turf-hover',
            calendar === 'dedicated' && !calendarId.trim() && 'pointer-events-none opacity-55',
          )}
        >
          {t('google.connect')}
        </a>
      </div>
    </div>
  );
}

/** The token dialog lives on the page: this form unmounts once the connection exists. */
function ObsidianConnect({ onCreated }: { onCreated: (r: IntegrationSecretDto) => void }) {
  const t = useTranslations('integrations');
  const [direction, setDirection] = useState<SyncDirection>('two_way');
  const [teamId, setTeamId] = useState('');
  const create = useAction(
    () =>
      apiPost<IntegrationSecretDto>('/integrations/obsidian', {
        direction,
        teamId: teamId || null,
      }),
    { invalidate, onSuccess: onCreated },
  );
  return (
    <div className="flex flex-col gap-4 px-5 py-4">
      <p className="text-sm text-muted">{t('obsidian.explain')}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <DirectionSelect value={direction} onChange={setDirection} />
        <TeamSelect value={teamId} onChange={setTeamId} />
      </div>
      <div>
        <Button
          variant="primary"
          disabled={create.isPending}
          onClick={() => create.mutate(undefined)}
        >
          {t('obsidian.create')}
        </Button>
      </div>
      <ErrorBanner error={create.error} />
    </div>
  );
}

function ObsidianHowTo({ token }: { token: string }) {
  const t = useTranslations('integrations.obsidian');
  const base = typeof window === 'undefined' ? '' : `${window.location.origin}/api`;
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p>{t('howTo')}</p>
      <CopyField
        label={t('command')}
        value={`node obsidian-vault-sync.mjs --vault "/path/to/your vault" --url ${base} --token ${token} --watch 300`}
      />
      <p className="text-[0.8125rem] text-muted">{t('howToHint')}</p>
    </div>
  );
}

function NotionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations('integrations');
  const tc = useTranslations('common');
  const [form, setForm] = useState({
    name: 'Notion',
    token: '',
    database: '',
    teamId: '',
    direction: 'two_way' as SyncDirection,
    timeZone: browserTimeZone(),
  });
  const create = useAction(
    () => apiPost<IntegrationDto>('/integrations/notion', { ...form, teamId: form.teamId || null }),
    { invalidate, success: t('notion.connected'), onSuccess: onClose },
  );
  const zones = [...new Set([form.timeZone, ...COMMON_TIME_ZONES])];
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('notion.connectTitle')}
      lead={t('notion.connectLead')}
      footer={
        <>
          <Button onClick={onClose}>{tc('cancel')}</Button>
          <Button
            variant="primary"
            disabled={create.isPending || !form.token.trim() || !form.database.trim()}
            onClick={() => create.mutate(undefined)}
          >
            {t('connect')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <TextField
          label={t('name')}
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <TextField
          label={t('notion.token')}
          hint={t('notion.tokenHint')}
          type="password"
          autoComplete="off"
          dir="ltr"
          value={form.token}
          onChange={(e) => setForm({ ...form, token: e.target.value })}
        />
        <TextField
          label={t('notion.database')}
          hint={t('notion.databaseHint')}
          dir="ltr"
          value={form.database}
          onChange={(e) => setForm({ ...form, database: e.target.value })}
        />
        <DirectionSelect
          value={form.direction}
          onChange={(direction) => setForm({ ...form, direction })}
        />
        <TeamSelect value={form.teamId} onChange={(teamId) => setForm({ ...form, teamId })} />
        <SelectField
          label={t('notion.timeZone')}
          hint={t('notion.timeZoneHint')}
          value={form.timeZone}
          onChange={(e) => setForm({ ...form, timeZone: e.target.value })}
        >
          {zones.map((z) => (
            <option key={z} value={z} dir="ltr">
              {z}
            </option>
          ))}
        </SelectField>
        <ErrorBanner error={create.error} />
      </div>
    </Dialog>
  );
}

function WebhookDialog({
  kind,
  onClose,
}: {
  kind: 'outgoing' | 'incoming' | null;
  onClose: () => void;
}) {
  const t = useTranslations('integrations');
  const tc = useTranslations('common');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [teamId, setTeamId] = useState('');
  const [events, setEvents] = useState<WebhookEventType[]>([...WEBHOOK_EVENT_TYPES]);
  const [actions, setActions] = useState<IncomingWebhookAction[]>(['meeting.create']);
  const [result, setResult] = useState<IntegrationSecretDto | null>(null);
  const create = useAction(
    () =>
      kind === 'outgoing'
        ? apiPost<IntegrationSecretDto>('/integrations/webhooks/outgoing', {
            name,
            url,
            events,
            teamId: teamId || null,
          })
        : apiPost<IntegrationSecretDto>('/integrations/webhooks/incoming', {
            name,
            actions,
            teamId: teamId || null,
          }),
    { invalidate, onSuccess: setResult },
  );
  if (result)
    return (
      <SecretDialog
        result={result}
        onClose={() => {
          setResult(null);
          onClose();
        }}
      >
        <p className="text-[0.8125rem] text-muted">{t('webhooks.signingHint')}</p>
      </SecretDialog>
    );
  return (
    <Dialog
      open={!!kind}
      onClose={onClose}
      title={kind === 'outgoing' ? t('webhooks.addOutgoing') : t('webhooks.addIncoming')}
      lead={
        kind === 'outgoing'
          ? t('descriptions.webhook_outgoing')
          : t('descriptions.webhook_incoming')
      }
      footer={
        <>
          <Button onClick={onClose}>{tc('cancel')}</Button>
          <Button
            variant="primary"
            disabled={create.isPending || !name.trim() || (kind === 'outgoing' && !url.trim())}
            onClick={() => create.mutate(undefined)}
          >
            {tc('create')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <TextField label={t('name')} value={name} onChange={(e) => setName(e.target.value)} />
        {kind === 'outgoing' && (
          <TextField
            label={t('webhooks.url')}
            hint={t('webhooks.urlHint')}
            dir="ltr"
            type="url"
            value={url}
            placeholder="https://"
            onChange={(e) => setUrl(e.target.value)}
          />
        )}
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">
            {kind === 'outgoing' ? t('webhooks.events') : t('webhooks.actions')}
          </legend>
          {kind === 'outgoing'
            ? WEBHOOK_EVENT_TYPES.map((e) => (
                <Checkbox
                  key={e}
                  label={t(`webhookEvents.${e}`)}
                  checked={events.includes(e)}
                  onChange={(x) =>
                    setEvents(x.target.checked ? [...events, e] : events.filter((y) => y !== e))
                  }
                />
              ))
            : INCOMING_WEBHOOK_ACTIONS.map((a) => (
                <Checkbox
                  key={a}
                  label={t(`actions.${a}`)}
                  checked={actions.includes(a)}
                  onChange={(x) =>
                    setActions(x.target.checked ? [...actions, a] : actions.filter((y) => y !== a))
                  }
                />
              ))}
        </fieldset>
        <TeamSelect value={teamId} onChange={setTeamId} />
        {kind === 'incoming' && (
          <p className="text-[0.8125rem] text-muted">{t('webhooks.incomingActsAs')}</p>
        )}
        <ErrorBanner error={create.error} />
      </div>
    </Dialog>
  );
}

function Banner() {
  const t = useTranslations('integrations');
  const te = useTranslations('errors');
  const params = useSearchParams();
  const toast = useToast();
  const connected = params.get('connected');
  const error = params.get('error');
  useEffect(() => {
    if (connected === 'google_calendar') toast(t('google.connected'));
  }, [connected, t, toast]);
  if (!error) return null;
  return (
    <p
      role="alert"
      className="mb-5 rounded-md border border-brick/30 bg-brick-soft px-4 py-3 text-sm"
    >
      {error === 'google_denied'
        ? t('google.denied')
        : te.has(error as never)
          ? te(error as never)
          : te('internal_error')}
    </p>
  );
}

export default function IntegrationsPage() {
  const t = useTranslations('integrations');
  const can = useCan();
  const data = useIntegrations();
  const [notionOpen, setNotionOpen] = useState(false);
  const [webhook, setWebhook] = useState<'outgoing' | 'incoming' | null>(null);
  const [obsidianToken, setObsidianToken] = useState<IntegrationSecretDto | null>(null);
  const manage = can('integrations.manage');
  const all = data.data?.connections ?? [];
  const personal = (p: IntegrationProvider) => all.find((c) => c.personal && c.provider === p);
  const org = all.filter((c) => !c.personal);

  return (
    <>
      <PageHeader title={t('title')} lead={t('lead')} />
      <Suspense>
        <Banner />
      </Suspense>
      <ErrorBanner error={data.error} />
      {data.isLoading ? (
        <Spinner />
      ) : (
        <div className="flex flex-col gap-6">
          <Section title={t('personal')} lead={t('personalLead')}>
            <div className="flex flex-col gap-4 p-5">
              {(['google_calendar', 'obsidian'] as const).map((p) => {
                const c = personal(p);
                return c ? (
                  <ul key={p}>
                    <ConnectionCard c={c} />
                  </ul>
                ) : (
                  <div key={p} className="rounded-lg border border-dashed border-line-strong">
                    <p className="flex items-center gap-2 px-5 pt-4 font-medium">
                      {(() => {
                        const Icon = ICONS[p];
                        return <Icon className="size-5 text-turf" aria-hidden="true" />;
                      })()}
                      {t(`providers.${p}`)}
                    </p>
                    <p className="px-5 pt-1 text-sm text-muted">{t(`descriptions.${p}`)}</p>
                    {p === 'google_calendar' ? (
                      <GoogleConnect configured={!!data.data?.providers.google.configured} />
                    ) : (
                      <ObsidianConnect onCreated={setObsidianToken} />
                    )}
                  </div>
                );
              })}
            </div>
          </Section>

          {manage && (
            <Section
              title={t('organization')}
              lead={t('organizationLead')}
              actions={
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => setNotionOpen(true)}>
                    {t('notion.add')}
                  </Button>
                  <Button size="sm" onClick={() => setWebhook('outgoing')}>
                    {t('webhooks.addOutgoing')}
                  </Button>
                  <Button size="sm" onClick={() => setWebhook('incoming')}>
                    {t('webhooks.addIncoming')}
                  </Button>
                </div>
              }
            >
              {org.length ? (
                <ul className="flex flex-col gap-4 p-5">
                  {org.map((c) => (
                    <ConnectionCard key={c.id} c={c} />
                  ))}
                </ul>
              ) : (
                <EmptyState title={t('noOrgConnections')} lead={t('noOrgConnectionsLead')} />
              )}
            </Section>
          )}
          <p className="text-[0.8125rem] text-muted">{t('conflictRule')}</p>
        </div>
      )}
      <NotionDialog open={notionOpen} onClose={() => setNotionOpen(false)} />
      {webhook && <WebhookDialog kind={webhook} onClose={() => setWebhook(null)} />}
      <SecretDialog result={obsidianToken} onClose={() => setObsidianToken(null)}>
        {obsidianToken && <ObsidianHowTo token={obsidianToken.secret} />}
      </SecretDialog>
    </>
  );
}
