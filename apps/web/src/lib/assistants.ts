'use client';

import {
  ASSISTANT_KEYS,
  ASSISTANT_PERMISSION,
  type AssistantKey,
  type AssistantsOverviewDto,
  type ConversationDto,
  type ConversationSummaryDto,
} from '@esports/shared';
import { useQuery } from '@tanstack/react-query';
import { Mail, MessagesSquare, PenLine, Scale, TrendingUp } from 'lucide-react';
import { api } from './api';
import { useCan } from './session';

export const ASSISTANT_ICONS: Record<AssistantKey, typeof Mail> = {
  general: MessagesSquare,
  formal_message: PenLine,
  email: Mail,
  offer_optimizer: Scale,
  player_analyst: TrendingUp,
};

export const isAssistantKey = (v: string): v is AssistantKey =>
  (ASSISTANT_KEYS as readonly string[]).includes(v);

/** UI hint only: the API checks the assistant permission on every request. */
export function useCanUseAssistant() {
  const can = useCan();
  return (key: AssistantKey) => can(ASSISTANT_PERMISSION[key]);
}

export function useAssistantsOverview() {
  return useQuery({
    queryKey: ['assistants', 'overview'],
    queryFn: () => api<AssistantsOverviewDto>('/assistants'),
    staleTime: 60_000,
  });
}

export const conversationsKey = (assistant: AssistantKey) => [
  'assistants',
  'conversations',
  assistant,
];
export const conversationKey = (id: string) => ['assistants', 'conversation', id];

export function useConversations(assistant: AssistantKey, archived: boolean) {
  return useQuery({
    queryKey: [...conversationsKey(assistant), archived],
    queryFn: () =>
      api<ConversationSummaryDto[]>(
        `/assistants/conversations?assistant=${assistant}&archived=${archived}`,
      ),
    // Keep the "replying" badges current while any reply is being prepared.
    refetchInterval: (q) => (q.state.data?.some((c) => c.pending) ? 3000 : false),
  });
}

/** Replies are prepared in the background: poll while one is pending. */
export function useConversation(id: string | null) {
  return useQuery({
    queryKey: conversationKey(id ?? ''),
    queryFn: () => api<ConversationDto>(`/assistants/conversations/${id}`),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data?.pending ? 1500 : false),
  });
}

/** Only links that are plainly web pages or dashboard paths are rendered as links. */
export function safeHref(url: string | null): { href: string; external: boolean } | null {
  if (!url) return null;
  if (url.startsWith('/dashboard')) return { href: url, external: false };
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || u.protocol === 'http:') return { href: u.href, external: true };
  } catch {
    // not a URL
  }
  return null;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** A short, readable form of what a lookup was asked (the search query, or its arguments). */
export function lookupInput(input: Record<string, unknown>): string {
  if (typeof input.query === 'string') return input.query;
  return Object.entries(input)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(', ');
}

export const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

export const splitAddresses = (s: string) =>
  s
    .split(/[,;\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
