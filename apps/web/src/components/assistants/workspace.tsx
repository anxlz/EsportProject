'use client';

import {
  ASSISTANT_FEATURES,
  ASSISTANT_LIMITS,
  type AssistantKey,
  type AssistantMessageDto,
  type AssistantsOverviewDto,
  type ConversationDto,
  type ConversationSummaryDto,
  REPLY_LANGUAGES,
  type ReplyLanguage,
} from '@esports/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Plus, RotateCcw, Send, SlidersHorizontal } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Checkbox,
  cx,
  Dialog,
  EmptyState,
  ErrorBanner,
  PageHeader,
  SelectField,
  Spinner,
  useErrorText,
} from '@/components/ui';
import { apiPatch, apiPost } from '@/lib/api';
import {
  ASSISTANT_ICONS,
  conversationKey,
  conversationsKey,
  useAssistantsOverview,
  useCanUseAssistant,
  useConversation,
  useConversations,
} from '@/lib/assistants';
import { formatDateTime } from '@/lib/format';
import { useAction } from '@/lib/mutation';
import { useMe } from '@/lib/session';
import { AnswerFooter, AnswerLanguageProvider } from './answer-parts';
import {
  type ContextForm,
  ContextFields,
  contextProblem,
  contextValue,
  hasContextForm,
  initialForm,
} from './context-forms';
import { AnalystView, EmailProposal, FormalView, GeneralView, OfferProposal } from './proposals';

// ------------------------------------------------------------------------------------------
// Shared pieces
// ------------------------------------------------------------------------------------------

export function NotConfiguredBanner() {
  const t = useTranslations('assistants');
  return (
    <p role="status" className="rounded-md border border-line bg-panel-2 px-4 py-3 text-sm">
      {t('notConfigured')}
    </p>
  );
}

function useProblemText() {
  const t = useTranslations('assistants.forms');
  const tc = useTranslations('common');
  return (key: string | null) =>
    key === 'invalidTerms' ? t('invalidTerms') : key === 'invalidEmail' ? tc('invalidEmail') : null;
}

function Composer({
  assistant,
  value,
  onChange,
  onSend,
  disabled,
  busy,
}: {
  assistant: AssistantKey;
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  const t = useTranslations('assistants');
  const ref = useRef<HTMLTextAreaElement>(null);
  const tooLong = value.length > ASSISTANT_LIMITS.messageChars;
  const canSend = !disabled && !busy && value.trim().length > 0 && !tooLong;
  useEffect(() => {
    // Picking a suggested follow-up puts it here; focus so it can be edited or sent.
    if (value && document.activeElement !== ref.current) ref.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value === '']);
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSend) onSend();
      }}
    >
      <label htmlFor="assistant-message" className="sr-only">
        {t('message')}
      </label>
      <textarea
        id="assistant-message"
        ref={ref}
        dir="auto"
        rows={3}
        value={value}
        disabled={disabled}
        placeholder={t(`placeholder.${assistant}`)}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            if (canSend) onSend();
          }
        }}
        className="w-full resize-y rounded-md border border-line-strong bg-panel px-3 py-2 text-ink placeholder:text-muted/70 focus:border-turf disabled:bg-panel-2"
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={cx('text-[0.8125rem]', tooLong ? 'text-brick' : 'text-muted')}>
          {value.length > ASSISTANT_LIMITS.messageChars * 0.8
            ? `${value.length} / ${ASSISTANT_LIMITS.messageChars}`
            : t('sendHint')}
        </span>
        <Button type="submit" variant="primary" disabled={!canSend}>
          <Send className="size-4 rtl:-scale-x-100" aria-hidden="true" />
          {t('send')}
        </Button>
      </div>
    </form>
  );
}

function SettingsFields({
  assistant,
  overview,
  replyLanguage,
  webSearch,
  onLanguage,
  onWebSearch,
  disabled,
}: {
  assistant: AssistantKey;
  overview: AssistantsOverviewDto | undefined;
  replyLanguage: ReplyLanguage;
  webSearch: boolean;
  onLanguage: (v: ReplyLanguage) => void;
  onWebSearch: (v: boolean) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('assistants');
  const tools = ASSISTANT_FEATURES[assistant].tools;
  return (
    <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
      <div className="w-56">
        <SelectField
          label={t('replyLanguage')}
          value={replyLanguage}
          disabled={disabled}
          onChange={(e) => onLanguage(e.target.value as ReplyLanguage)}
        >
          {REPLY_LANGUAGES.map((l) => (
            <option key={l} value={l} lang={l === 'auto' ? undefined : l}>
              {t(`languages.${l}`)}
            </option>
          ))}
        </SelectField>
      </div>
      {tools &&
        (overview && !overview.webSearch ? (
          <p className="max-w-sm pb-2 text-[0.8125rem] text-muted">{t('webSearchDisabled')}</p>
        ) : (
          <div className="max-w-sm pb-1">
            <Checkbox
              label={t('webSearch')}
              hint={t('webSearchHint')}
              checked={webSearch}
              disabled={disabled}
              onChange={(e) => onWebSearch(e.target.checked)}
            />
          </div>
        ))}
    </div>
  );
}

// ------------------------------------------------------------------------------------------
// Messages
// ------------------------------------------------------------------------------------------

function AssistantCard({
  assistant,
  m,
  children,
}: {
  assistant: AssistantKey;
  m: AssistantMessageDto;
  children: ReactNode;
}) {
  const t = useTranslations('assistants');
  const locale = useLocale();
  const Icon = ASSISTANT_ICONS[assistant];
  return (
    <article className="flex flex-col gap-4 rounded-lg border border-line bg-panel-2/60 p-4 sm:p-5">
      <header className="flex flex-wrap items-center gap-2 text-sm text-muted">
        <Icon className="size-4 text-turf" aria-hidden="true" />
        <span className="font-medium text-ink">{t(`short.${assistant}`)}</span>
        <span aria-hidden="true">·</span>
        <time dateTime={m.completedAt ?? m.createdAt}>
          {formatDateTime(m.completedAt ?? m.createdAt, locale)}
        </time>
      </header>
      {children}
    </article>
  );
}

function MessageItem({
  m,
  conv,
  overview,
  isLast,
  onAsk,
  onRetry,
  retrying,
}: {
  m: AssistantMessageDto;
  conv: ConversationDto;
  overview: AssistantsOverviewDto | undefined;
  isLast: boolean;
  onAsk: (text: string) => void;
  onRetry: () => void;
  retrying: boolean;
}) {
  const t = useTranslations('assistants');
  const errorText = useErrorText();
  const me = useMe();
  const assistant = conv.assistant;

  if (m.role === 'user')
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-turf-soft px-4 py-2.5">
          <p className="sr-only">{t('you')}</p>
          <p dir="auto" className="text-start whitespace-pre-wrap">
            {m.text}
          </p>
        </div>
      </div>
    );

  if (m.status === 'pending')
    return (
      <AssistantCard assistant={assistant} m={m}>
        <p role="status" className="flex items-center gap-2 text-sm text-muted">
          <span className="size-2 animate-pulse rounded-full bg-turf" aria-hidden="true" />
          {ASSISTANT_FEATURES[assistant].tools ? t('workingTools') : t('working')}
        </p>
      </AssistantCard>
    );

  if (m.status === 'failed' || !m.answer)
    return (
      <AssistantCard assistant={assistant} m={m}>
        <div role="alert" className="flex flex-col gap-1 text-sm">
          <p className="font-medium">{t('failed')}</p>
          <p className="text-muted">
            {m.errorCode === 'timeout'
              ? t('failure.timeout')
              : errorText({ code: m.errorCode ?? 'internal_error' } as never)}
          </p>
        </div>
        {isLast && !conv.archived && (
          <div>
            <Button size="sm" onClick={onRetry} disabled={retrying || !overview?.configured}>
              <RotateCcw className="size-4" aria-hidden="true" />
              {t('retry')}
            </Button>
          </div>
        )}
      </AssistantCard>
    );

  const a = m.answer;
  return (
    <AssistantCard assistant={assistant} m={m}>
      <AnswerLanguageProvider value={m.language}>
        {a.kind === 'general' && (
          <GeneralView m={m} a={a} onAsk={isLast && !conv.archived ? onAsk : undefined} />
        )}
        {a.kind === 'formal_message' && <FormalView a={a} />}
        {a.kind === 'email' && (
          <EmailProposal
            m={m}
            a={a}
            conversationId={conv.id}
            canSend={!!overview?.canSendEmail}
            replyTo={me.user.email}
          />
        )}
        {a.kind === 'offer_optimizer' && (
          <OfferProposal m={m} a={a} conversationId={conv.id} context={conv.context} />
        )}
        {a.kind === 'player_analyst' && <AnalystView m={m} a={a} />}
        <AnswerFooter m={m} />
      </AnswerLanguageProvider>
    </AssistantCard>
  );
}

// ------------------------------------------------------------------------------------------
// An open conversation
// ------------------------------------------------------------------------------------------

function ContextDialog({ conv, onClose }: { conv: ConversationDto; onClose: () => void }) {
  const t = useTranslations('assistants');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const problemText = useProblemText();
  const [form, setForm] = useState<ContextForm>(() => initialForm(conv.assistant, conv.context));
  const problem = contextProblem(form);
  const save = useAction(
    () =>
      apiPatch<ConversationDto>(`/assistants/conversations/${conv.id}`, {
        context: contextValue(form),
      }),
    {
      invalidate: [],
      success: t('contextSaved'),
      onSuccess: (c) => {
        qc.setQueryData(conversationKey(conv.id), c);
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t('context')}
      lead={t('contextLead')}
      footer={
        <>
          <Button onClick={onClose}>{tc('cancel')}</Button>
          <Button
            variant="primary"
            disabled={!!problem || save.isPending || conv.archived}
            onClick={() => save.mutate(undefined)}
          >
            {save.isPending ? tc('saving') : t('saveContext')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <ContextFields form={form} onChange={setForm} />
        {problem && form.assistant !== 'offer_optimizer' && (
          <p role="alert" className="text-sm text-brick">
            {problemText(problem)}
          </p>
        )}
        <ErrorBanner error={save.error} />
      </div>
    </Dialog>
  );
}

function ConversationPanel({
  id,
  assistant,
  overview,
  onGone,
}: {
  id: string;
  assistant: AssistantKey;
  overview: AssistantsOverviewDto | undefined;
  onGone: () => void;
}) {
  const t = useTranslations('assistants');
  const qc = useQueryClient();
  const conv = useConversation(id);
  const [draft, setDraft] = useState('');
  const [contextOpen, setContextOpen] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const count = conv.data?.messages.length ?? 0;
  const seen = useRef<number | null>(null);

  useEffect(() => {
    // Scroll to the newest message when one arrives, not on first load.
    if (seen.current !== null && count > seen.current)
      endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    if (conv.data) seen.current = count;
  }, [count, conv.data]);

  const refresh = (c: ConversationDto) => {
    qc.setQueryData(conversationKey(id), c);
    void qc.invalidateQueries({ queryKey: conversationsKey(assistant) });
  };
  const send = useAction(
    (text: string) =>
      apiPost<ConversationDto>(`/assistants/conversations/${id}/messages`, { text }),
    { invalidate: [], onSuccess: (c) => (refresh(c), setDraft('')) },
  );
  const patch = useAction(
    (body: Record<string, unknown>) =>
      apiPatch<ConversationDto>(`/assistants/conversations/${id}`, body),
    { invalidate: [], onSuccess: refresh },
  );

  if (conv.isLoading) return <Spinner />;
  if (conv.error || !conv.data)
    return (
      <div className="flex flex-col gap-3">
        <ErrorBanner error={conv.error} />
        <div>
          <Button onClick={onGone}>{t('newConversation')}</Button>
        </div>
      </div>
    );

  const c = conv.data;
  const last = c.messages[c.messages.length - 1];
  const lastUser = [...c.messages].reverse().find((m) => m.role === 'user');
  const composerDisabled = c.pending || c.archived || !overview?.configured;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-col gap-4 rounded-lg border border-line bg-panel p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 dir="auto" className="min-w-0 text-lg font-semibold break-words">
            {c.title || t('untitled')}
          </h2>
          <div className="flex flex-wrap gap-2">
            {hasContextForm(assistant) && (
              <Button size="sm" onClick={() => setContextOpen(true)}>
                <SlidersHorizontal className="size-4" aria-hidden="true" />
                {t('editContext')}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={patch.isPending || c.pending}
              onClick={() => patch.mutate({ archived: !c.archived })}
            >
              {c.archived ? (
                <ArchiveRestore className="size-4" aria-hidden="true" />
              ) : (
                <Archive className="size-4" aria-hidden="true" />
              )}
              {c.archived ? t('unarchive') : t('archive')}
            </Button>
          </div>
        </div>
        <SettingsFields
          assistant={assistant}
          overview={overview}
          replyLanguage={c.replyLanguage}
          webSearch={c.webSearch}
          disabled={c.archived || patch.isPending}
          onLanguage={(replyLanguage) => patch.mutate({ replyLanguage })}
          onWebSearch={(webSearch) => patch.mutate({ webSearch })}
        />
        <ErrorBanner error={patch.error} />
      </div>

      <div className="flex flex-col gap-4" aria-live="polite" aria-busy={c.pending}>
        {c.messages.map((m) => (
          <MessageItem
            key={m.id}
            m={m}
            conv={c}
            overview={overview}
            isLast={m.id === last?.id}
            onAsk={setDraft}
            onRetry={() => lastUser?.text && send.mutate(lastUser.text)}
            retrying={send.isPending}
          />
        ))}
        <div ref={endRef} />
      </div>

      {c.archived ? (
        <p className="rounded-md border border-line bg-panel-2 px-4 py-3 text-sm">
          {t('archivedNote')}
        </p>
      ) : (
        <div className="flex flex-col gap-2 rounded-lg border border-line bg-panel p-4">
          <ErrorBanner error={send.error} />
          <Composer
            assistant={assistant}
            value={draft}
            onChange={setDraft}
            onSend={() => send.mutate(draft)}
            disabled={composerDisabled}
            busy={send.isPending}
          />
          <p className="text-[0.8125rem] text-muted">{t('nothingChanges')}</p>
        </div>
      )}
      {contextOpen && <ContextDialog conv={c} onClose={() => setContextOpen(false)} />}
    </div>
  );
}

// ------------------------------------------------------------------------------------------
// Starting a conversation: settings and context first, then the first message
// ------------------------------------------------------------------------------------------

function NewConversation({
  assistant,
  overview,
  onStarted,
}: {
  assistant: AssistantKey;
  overview: AssistantsOverviewDto | undefined;
  onStarted: (id: string) => void;
}) {
  const t = useTranslations('assistants');
  const qc = useQueryClient();
  const problemText = useProblemText();
  const features = ASSISTANT_FEATURES[assistant];
  const [replyLanguage, setReplyLanguage] = useState<ReplyLanguage>('auto');
  const [webSearch, setWebSearch] = useState(features.webSearchDefault);
  const [form, setForm] = useState<ContextForm>(() => initialForm(assistant));
  const [draft, setDraft] = useState('');
  // If the first message fails after the conversation was created, retry into the same one.
  const created = useRef<string | null>(null);
  const problem = contextProblem(form);

  const start = useAction(
    async (text: string) => {
      if (!created.current) {
        const conv = await apiPost<ConversationDto>('/assistants/conversations', {
          assistant,
          replyLanguage,
          webSearch: features.tools ? webSearch : undefined,
          context: contextValue(form),
        });
        created.current = conv.id;
      } else {
        await apiPatch(`/assistants/conversations/${created.current}`, {
          replyLanguage,
          webSearch: features.tools ? webSearch : undefined,
          context: contextValue(form),
        });
      }
      return apiPost<ConversationDto>(`/assistants/conversations/${created.current}/messages`, {
        text,
      });
    },
    {
      invalidate: [conversationsKey(assistant)],
      onSuccess: (c) => {
        qc.setQueryData(conversationKey(c.id), c);
        onStarted(c.id);
      },
    },
  );

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-col gap-4 rounded-lg border border-line bg-panel p-4">
        <h2 className="text-lg font-semibold">{t('newConversation')}</h2>
        <SettingsFields
          assistant={assistant}
          overview={overview}
          replyLanguage={replyLanguage}
          webSearch={webSearch}
          onLanguage={setReplyLanguage}
          onWebSearch={setWebSearch}
        />
      </div>
      {hasContextForm(assistant) && (
        <section className="flex flex-col gap-4 rounded-lg border border-line bg-panel p-4">
          <div>
            <h3 className="font-semibold">{t('context')}</h3>
            <p className="mt-0.5 text-sm text-muted">{t('contextLead')}</p>
          </div>
          <ContextFields form={form} onChange={setForm} />
          {problem && form.assistant !== 'offer_optimizer' && (
            <p role="alert" className="text-sm text-brick">
              {problemText(problem)}
            </p>
          )}
        </section>
      )}
      <div className="flex flex-col gap-2 rounded-lg border border-line bg-panel p-4">
        <ErrorBanner error={start.error} />
        <Composer
          assistant={assistant}
          value={draft}
          onChange={setDraft}
          onSend={() => start.mutate(draft)}
          disabled={!overview?.configured || !!problem}
          busy={start.isPending}
        />
        <p className="text-[0.8125rem] text-muted">{t('nothingChanges')}</p>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------
// Conversation list
// ------------------------------------------------------------------------------------------

function ConversationList({
  assistant,
  selected,
  onSelect,
}: {
  assistant: AssistantKey;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const t = useTranslations('assistants');
  const locale = useLocale();
  const [archived, setArchived] = useState(false);
  const list = useConversations(assistant, archived);
  const rows: ConversationSummaryDto[] = list.data ?? [];
  const body = (
    <div className="flex flex-col">
      <div
        className="flex gap-1 border-b border-line p-2"
        role="group"
        aria-label={t('conversations')}
      >
        {[false, true].map((a) => (
          <button
            key={String(a)}
            type="button"
            aria-pressed={archived === a}
            onClick={() => setArchived(a)}
            className={cx(
              'h-8 flex-1 rounded-md px-2 text-sm',
              archived === a ? 'bg-panel-2 font-medium text-ink' : 'text-muted hover:text-ink',
            )}
          >
            {a ? t('showArchived') : t('showActive')}
          </button>
        ))}
      </div>
      {list.isLoading ? (
        <Spinner />
      ) : list.error ? (
        <div className="p-3">
          <ErrorBanner error={list.error} />
        </div>
      ) : rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted">
          {archived ? t('noArchived') : t('noConversations')}
        </p>
      ) : (
        <ul data-lenis-prevent className="flex max-h-[60dvh] flex-col overflow-y-auto p-2">
          {rows.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onSelect(c.id)}
                aria-current={selected === c.id ? 'true' : undefined}
                className={cx(
                  'flex w-full flex-col items-start gap-0.5 rounded-md px-3 py-2 text-start',
                  selected === c.id ? 'bg-turf-soft' : 'hover:bg-panel-2',
                )}
              >
                <span dir="auto" className="line-clamp-2 w-full text-sm font-medium">
                  {c.title || t('untitled')}
                </span>
                <span className="flex items-center gap-2 text-xs text-muted">
                  {formatDateTime(c.updatedAt, locale)}
                  {c.pending && <Badge tone="amber">{t('pendingBadge')}</Badge>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
  return (
    <>
      <details className="rounded-lg border border-line bg-panel lg:hidden">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
          {t('conversations')}
          {rows.length > 0 && <span className="ms-1 text-muted">({rows.length})</span>}
        </summary>
        <div className="border-t border-line">{body}</div>
      </details>
      <aside
        aria-label={t('conversations')}
        className="hidden self-start rounded-lg border border-line bg-panel lg:sticky lg:top-20 lg:block"
      >
        <h2 className="border-b border-line px-4 py-3 text-sm font-semibold">
          {t('conversations')}
        </h2>
        {body}
      </aside>
    </>
  );
}

// ------------------------------------------------------------------------------------------
// Page body
// ------------------------------------------------------------------------------------------

export function AssistantWorkspace({ assistant }: { assistant: AssistantKey }) {
  const t = useTranslations('assistants');
  const overview = useAssistantsOverview();
  // Phase 6: each assistant may be answered by a different provider (set by the deployer), so
  // "configured", the model and web search are per assistant.
  const info = overview.data?.assistants.find((a) => a.key === assistant);
  const mine =
    overview.data && info
      ? {
          ...overview.data,
          ...info,
          configured: info.configured,
          model: info.model,
          webSearch: info.webSearchAvailable,
        }
      : overview.data;
  const allowed = useCanUseAssistant()(assistant);
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const selected = params.get('c');
  const select = (id: string | null) =>
    router.replace(id ? `${pathname}?c=${id}` : pathname, { scroll: false });
  const Icon = ASSISTANT_ICONS[assistant];

  const header = (
    <PageHeader
      title={t(`names.${assistant}`)}
      lead={t(`descriptions.${assistant}`)}
      actions={
        allowed && selected ? (
          <Button variant="primary" onClick={() => select(null)}>
            <Plus className="size-4" aria-hidden="true" />
            {t('newConversation')}
          </Button>
        ) : undefined
      }
    />
  );

  if (!allowed)
    return (
      <>
        {header}
        <div className="rounded-lg border border-line bg-panel">
          <EmptyState title={t('notAllowed')} />
        </div>
      </>
    );

  return (
    <>
      <div className="flex items-start gap-3">
        <Icon className="mt-1.5 size-6 shrink-0 text-turf" aria-hidden="true" />
        <div className="min-w-0 flex-1">{header}</div>
      </div>
      {mine && !mine.configured && (
        <div className="mb-5">
          <NotConfiguredBanner />
        </div>
      )}
      {mine?.configured && mine.model && (
        <p className="mb-4 text-sm text-muted">
          {t('answeredBy', { provider: t(`providerNames.${mine.provider}`), model: mine.model })}
        </p>
      )}
      <div className="grid gap-5 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <ConversationList assistant={assistant} selected={selected} onSelect={select} />
        {selected ? (
          <ConversationPanel
            key={selected}
            id={selected}
            assistant={assistant}
            overview={mine}
            onGone={() => select(null)}
          />
        ) : (
          <NewConversation
            key={assistant}
            assistant={assistant}
            overview={mine}
            onStarted={select}
          />
        )}
      </div>
    </>
  );
}
