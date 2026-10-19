'use client';

import type {
  AssistantMessageDto,
  ClaimDto,
  Confidence,
  GuardrailFlagDto,
  SourceDto,
  ToolCallSummaryDto,
} from '@esports/shared';
import { Database, ExternalLink, Globe, Search, TriangleAlert, UserRound } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { createContext, Fragment, type ReactNode, useContext, useState } from 'react';
import { Badge, Button, cx } from '@/components/ui';
import { hostOf, lookupInput, safeHref } from '@/lib/assistants';
import { formatDateTime } from '@/lib/format';

const CONFIDENCE_TONE: Record<Confidence, 'turf' | 'amber' | 'brick'> = {
  confirmed: 'turf',
  estimated: 'amber',
  uncertain: 'brick',
};

/**
 * The language of the reply being shown. Text the model wrote is marked with it (lang + dir), so
 * an Arabic reply reads right-to-left even in the English interface and vice versa, while the
 * interface's own labels keep the interface language.
 */
const AnswerLanguage = createContext<'ar' | 'en' | null>(null);
export const AnswerLanguageProvider = AnswerLanguage.Provider;

export function useAnswerText(): { lang?: string; dir: 'rtl' | 'ltr' | 'auto' } {
  const l = useContext(AnswerLanguage);
  return l ? { lang: l, dir: l === 'ar' ? 'rtl' : 'ltr' } : { dir: 'auto' };
}

export function ConfidenceBadge({ level }: { level: Confidence }) {
  const t = useTranslations('assistants.confidence');
  return <Badge tone={CONFIDENCE_TONE[level]}>{t(level)}</Badge>;
}

export const sourceAnchor = (messageId: string, sourceId: string) => `src-${messageId}-${sourceId}`;

/** A citation chip that jumps to the source in the list below the answer. */
export function SourceChip({ messageId, id }: { messageId: string; id: string }) {
  const t = useTranslations('assistants');
  return (
    <a
      href={`#${sourceAnchor(messageId, id)}`}
      aria-label={t('citation', { id })}
      dir="ltr"
      className="inline-flex h-5 items-center rounded border border-line-strong bg-panel px-1.5 text-xs font-medium text-ink tabular-nums hover:border-turf hover:text-turf"
    >
      {id}
    </a>
  );
}

/**
 * Model text rendered as plain React text (never as HTML): blank lines split paragraphs, and
 * lines starting with "-", "*", "•" or "1." become list items. Markdown emphasis is dropped.
 */
export function PlainText({ text, className }: { text: string; className?: string }) {
  const tp = useAnswerText();
  const blocks = text.replace(/\r/g, '').split(/\n{2,}/);
  const clean = (s: string) => s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#+\s+/, '');
  return (
    <div {...tp} className={cx('flex flex-col gap-2.5 text-start', className)}>
      {blocks.map((block, i) => {
        const lines = block.split('\n').filter((l) => l.trim());
        const bullet = /^\s*(?:[-*•]|\d+[.)])\s+/;
        if (lines.length > 0 && lines.every((l) => bullet.test(l))) {
          const ordered = /^\s*\d/.test(lines[0]!);
          const List = ordered ? 'ol' : 'ul';
          return (
            <List
              key={i}
              className={cx('flex flex-col gap-1 ps-5', ordered ? 'list-decimal' : 'list-disc')}
            >
              {lines.map((l, j) => (
                <li key={j}>{clean(l.replace(bullet, ''))}</li>
              ))}
            </List>
          );
        }
        return (
          <p key={i} className="whitespace-pre-line">
            {clean(block)}
          </p>
        );
      })}
    </div>
  );
}

export function SubHeading({ children }: { children: ReactNode }) {
  return <h3 className="text-sm font-semibold text-ink">{children}</h3>;
}

export function ClaimsList({ claims, messageId }: { claims: ClaimDto[]; messageId: string }) {
  const t = useTranslations('assistants');
  const tp = useAnswerText();
  if (!claims.length) return null;
  return (
    <div className="flex flex-col gap-2">
      <SubHeading>{t('claims')}</SubHeading>
      <ul className="flex flex-col gap-2">
        {claims.map((c, i) => (
          <li key={i} className="flex flex-wrap items-start gap-x-2 gap-y-1">
            <ConfidenceBadge level={c.confidence} />
            <span {...tp} className="min-w-0 flex-1 text-start">
              {c.text}
            </span>
            {c.sourceIds.length > 0 && (
              <span className="flex flex-wrap gap-1">
                {c.sourceIds.map((id) => (
                  <SourceChip key={id} messageId={messageId} id={id} />
                ))}
              </span>
            )}
          </li>
        ))}
      </ul>
      <p className="text-[0.8125rem] text-muted">{t('confidenceHelp')}</p>
    </div>
  );
}

export function TextList({ title, items }: { title: string; items: string[] }) {
  const tp = useAnswerText();
  if (!items.length) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <SubHeading>{title}</SubHeading>
      <ul className="flex list-disc flex-col gap-1 ps-5">
        {items.map((g, i) => (
          <li key={i} {...tp} className="text-start">
            {g}
          </li>
        ))}
      </ul>
    </div>
  );
}

const SOURCE_ICON = { platform: Database, web: Globe, user: UserRound } as const;

/** A source's name in the reader's language (platform and user sources), or its page title. */
export function useSourceName() {
  const t = useTranslations('assistants.sourceLabels');
  return (s: SourceDto) =>
    s.label ? (s.subject ? `${t(s.label)} — ${s.subject}` : t(s.label)) : s.title;
}

export function SourcesList({ sources, messageId }: { sources: SourceDto[]; messageId: string }) {
  const t = useTranslations('assistants');
  const locale = useLocale();
  const name = useSourceName();
  if (!sources.length) return null;
  return (
    <div className="flex flex-col gap-2">
      <SubHeading>{t('sources')}</SubHeading>
      <ol className="flex flex-col gap-2">
        {sources.map((s) => {
          const Icon = SOURCE_ICON[s.kind];
          const link = safeHref(s.url);
          return (
            <li
              key={s.id}
              id={sourceAnchor(messageId, s.id)}
              className="flex scroll-mt-20 gap-3 rounded-md border border-line bg-panel px-3 py-2.5 target:border-turf target:ring-1 target:ring-turf"
            >
              <span
                dir="ltr"
                className="mt-0.5 shrink-0 text-xs font-semibold text-muted tabular-nums"
              >
                {s.id}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <Icon className="size-3.5 shrink-0 text-muted" aria-hidden="true" />
                  <span className="text-[0.8125rem] text-muted">{t(`sourceKinds.${s.kind}`)}</span>
                  {link ? (
                    link.external ? (
                      <a
                        href={link.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex min-w-0 items-center gap-1 font-medium text-turf underline-offset-2 hover:underline"
                      >
                        <span className="truncate" dir="auto">
                          {name(s) || hostOf(link.href)}
                        </span>
                        <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
                        <span className="sr-only">{t('openSource')}</span>
                      </a>
                    ) : (
                      <Link
                        href={link.href}
                        className="font-medium text-turf underline-offset-2 hover:underline"
                        dir="auto"
                      >
                        {name(s)}
                      </Link>
                    )
                  ) : (
                    <span className="font-medium" dir="auto">
                      {name(s)}
                    </span>
                  )}
                </div>
                {link?.external && (
                  <span dir="ltr" className="ltr-text truncate text-xs text-muted">
                    {hostOf(link.href)}
                  </span>
                )}
                {s.excerpt && (
                  <blockquote
                    dir="auto"
                    className="border-s-2 border-line-strong ps-2 text-sm text-muted"
                  >
                    {s.excerpt}
                  </blockquote>
                )}
                <span className="text-xs text-muted">
                  {t(s.kind === 'user' ? 'provided' : 'retrieved', {
                    time: formatDateTime(s.retrievedAt, locale),
                  })}
                  {s.pageAge && <> · {t('pageAge', { age: s.pageAge })}</>}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const OUTCOME_TONE = {
  ok: 'turf',
  denied: 'amber',
  not_found: 'neutral',
  error: 'brick',
  unknown_tool: 'brick',
} as const;

export function useToolLabel() {
  const t = useTranslations('assistants.tools');
  return (tool: string) => (t.has(tool as never) ? t(tool as never) : tool);
}

export function LookupsList({ calls }: { calls: ToolCallSummaryDto[] }) {
  const t = useTranslations('assistants');
  const label = useToolLabel();
  if (!calls.length) return null;
  return (
    <details className="group rounded-md border border-line bg-panel">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm font-medium">
        <Search className="size-3.5 text-muted" aria-hidden="true" />
        {t('lookups', { count: calls.length })}
      </summary>
      <ul className="flex flex-col divide-y divide-line border-t border-line">
        {calls.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
            <span className="font-medium">{label(c.tool)}</span>
            {lookupInput(c.input) && (
              <span dir="auto" className="min-w-0 flex-1 text-muted break-words">
                {lookupInput(c.input)}
              </span>
            )}
            <Badge tone={OUTCOME_TONE[c.outcome]}>{t(`outcomes.${c.outcome}`)}</Badge>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Which findings show their detail. A removed link is deliberately not shown (it was never
 * verified), and a downgraded claim is already visible in the answer as "Uncertain".
 */
const FLAG_DETAIL: Partial<Record<GuardrailFlagDto['code'], 'raw' | 'tool'>> = {
  unknown_source_removed: 'raw',
  tool_denied: 'tool',
  unknown_tool: 'raw',
  guarantee_language: 'raw',
};

export function FlagsList({ flags }: { flags: GuardrailFlagDto[] }) {
  const t = useTranslations('assistants');
  const toolLabel = useToolLabel();
  const sep = useLocale() === 'ar' ? '، ' : ', ';
  if (!flags.length) return null;
  // One line per kind of check; repeated findings of the same kind are summarized together.
  const codes = [...new Set(flags.map((f) => f.code))];
  return (
    <div
      role="note"
      className="flex flex-col gap-1.5 rounded-md border border-amber/40 bg-amber-soft px-3 py-2.5 text-sm text-amber-ink"
    >
      <p className="flex items-center gap-2 font-medium">
        <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
        {t('flagsTitle')}
      </p>
      <ul className="flex list-disc flex-col gap-1 ps-5">
        {codes.map((code) => {
          const mode = FLAG_DETAIL[code];
          const details = mode
            ? [
                ...new Set(
                  flags
                    .filter((f) => f.code === code && f.detail)
                    .map((f) => (mode === 'tool' ? toolLabel(f.detail!) : f.detail!)),
                ),
              ]
            : [];
          return (
            <li key={code}>
              {t(`flags.${code}`)}
              {details.length > 0 && (
                <span dir="auto" className="ms-1 text-xs opacity-80">
                  ({details.slice(0, 5).join(sep)})
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const t = useTranslations('assistants');
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? t('copied') : (label ?? t('copy'))}
    </Button>
  );
}

/** Sources, lookups and guardrail notes shown under every completed reply. */
export function AnswerFooter({ m }: { m: AssistantMessageDto }) {
  const t = useTranslations('assistants');
  return (
    <Fragment>
      <SourcesList sources={m.sources} messageId={m.id} />
      <FlagsList flags={m.flags} />
      <LookupsList calls={m.toolCalls} />
      {m.model && <p className="text-xs text-muted">{t('model', { model: m.model })}</p>}
    </Fragment>
  );
}
