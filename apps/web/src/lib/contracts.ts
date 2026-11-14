'use client';

import {
  type AssistantStatusDto,
  type ContractDto,
  type ContractLocale,
  type ContractTypeDto,
  cl,
  type DocumentSettingsDto,
  type StoredFileDto,
} from '@esports/shared';
import { useQuery } from '@tanstack/react-query';
import { useLocale } from 'next-intl';
import { api, ApiError, withApiRequest } from './api';
import { useCan } from './session';

export function useContractLocale(): ContractLocale {
  return useLocale() === 'ar' ? 'ar' : 'en';
}

/** Status, field and document labels shared with the generated documents. */
export function useContractLabels() {
  return cl(useContractLocale());
}

export function useContractTypes() {
  const can = useCan();
  return useQuery({
    queryKey: ['contract-types'],
    queryFn: () => api<ContractTypeDto[]>('/contract-types'),
    enabled: (
      [
        'contracts.view',
        'contracts.create',
        'contracts.edit',
        'contracts.approve',
        'contracts.manage_templates',
      ] as const
    ).some(can),
  });
}

export function useContract(id: string) {
  return useQuery({
    queryKey: ['contracts', 'detail', id],
    queryFn: () => api<ContractDto>(`/contracts/${id}`),
  });
}

export function useAssistantStatus() {
  return useQuery({
    queryKey: ['contracts', 'assistant-status'],
    queryFn: () => api<AssistantStatusDto>('/contracts/assistant-status'),
    staleTime: 5 * 60_000,
  });
}

export function useDocumentSettings(enabled = true) {
  return useQuery({
    queryKey: ['contract-settings'],
    queryFn: () => api<DocumentSettingsDto>('/contract-settings'),
    enabled,
  });
}

async function failure(res: Response): Promise<never> {
  const data = (await res.json().catch(() => null)) as {
    error?: { code?: string; message?: string; details?: unknown };
  } | null;
  throw new ApiError(
    res.status,
    (data?.error?.code as never) ?? 'internal_error',
    data?.error?.message ?? res.statusText,
    data?.error?.details,
  );
}

/** Self-contained preview HTML (shown in a sandboxed iframe via srcdoc). */
export async function fetchHtml(path: string, headers?: Record<string, string>): Promise<string> {
  return withApiRequest(async () => {
    const res = await fetch(`/api${path}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers,
    });
    if (!res.ok) await failure(res);
    return res.text();
  });
}

/** Downloads a GET response as a file, named by the server's Content-Disposition. */
export async function downloadGet(
  path: string,
  fallbackName = 'document.pdf',
  headers?: Record<string, string>,
): Promise<void> {
  return withApiRequest(async () => {
    const res = await fetch(`/api${path}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers,
    });
    if (!res.ok) await failure(res);
    const blob = await res.blob();
    const name =
      /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  });
}

/** Uploads a file as the raw request body; the API checks its bytes, kind and size. */
export async function uploadFile(
  kind: 'logo' | 'background' | 'stamp',
  file: File,
): Promise<StoredFileDto> {
  return withApiRequest(async () => {
    const res = await fetch(`/api/files?kind=${kind}`, {
      method: 'POST',
      headers: { 'content-type': file.type || 'application/octet-stream' },
      body: file,
      credentials: 'same-origin',
    });
    if (!res.ok) await failure(res);
    return (await res.json()) as StoredFileDto;
  });
}

/** Name in the reader's language, falling back to the other. */
export const pick = (
  en: string | null | undefined,
  ar: string | null | undefined,
  locale: ContractLocale,
) => (locale === 'ar' ? ar || en : en || ar) ?? '';
