/**
 * How a failed integration call should be handled by the job runner:
 * - `retryable`  — transient (network, 5xx): retried with exponential backoff;
 * - `rate_limited` — the provider (or our own limiter) said wait: deferred, not counted as a failure;
 * - `auth`       — credentials rejected/revoked: the connection is marked "error" until reconnected;
 * - `permanent`  — the request itself is wrong or the resource is gone: not retried.
 */
export type IntegrationErrorKind = 'retryable' | 'rate_limited' | 'auth' | 'permanent';

export class IntegrationError extends Error {
  constructor(
    readonly kind: IntegrationErrorKind,
    readonly code: string,
    message: string,
    readonly retryAfterMs?: number,
    readonly status?: number,
  ) {
    super(message);
  }

  static fromStatus(
    provider: string,
    status: number,
    retryAfter: string | null,
    detail = '',
  ): IntegrationError {
    const msg = `${provider} returned ${status}${detail ? `: ${detail}` : ''}`;
    if (status === 401) return new IntegrationError('auth', 'auth_failed', msg, undefined, status);
    if (status === 429 || status === 529)
      return new IntegrationError(
        'rate_limited',
        'rate_limited',
        msg,
        parseRetryAfter(retryAfter) ?? 60_000,
        status,
      );
    if (status >= 500 || status === 408)
      return new IntegrationError('retryable', 'provider_error', msg, undefined, status);
    return new IntegrationError('permanent', 'request_rejected', msg, undefined, status);
  }
}

/** Retry-After as seconds or an HTTP date → milliseconds (capped at 1 hour). */
export function parseRetryAfter(v: string | null): number | null {
  if (!v) return null;
  const s = Number(v);
  const ms = Number.isFinite(s) ? s * 1000 : Date.parse(v) - Date.now();
  if (!Number.isFinite(ms)) return null;
  return Math.min(Math.max(ms, 1000), 3_600_000);
}
