/**
 * Outbound HTTP for integrations: timeouts, our own per-connection rate limit (checked before a
 * request, in Redis so it holds across instances), and errors mapped to IntegrationError.
 */
import type { RateLimitService } from '../../common/rate-limit';
import { IntegrationError } from '../errors';

export interface HttpResult<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

export async function httpJson<T = unknown>(
  provider: string,
  url: string,
  init: RequestInit & { timeoutMs: number },
): Promise<HttpResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(init.timeoutMs) });
  } catch (e) {
    const name = (e as Error).name;
    throw new IntegrationError(
      'retryable',
      name === 'TimeoutError' ? 'timeout' : 'network',
      `${provider} could not be reached (${name})`,
    );
  }
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body: body as T, headers: res.headers };
}

/**
 * Reserves one request in a per-minute budget, or throws `rate_limited` with how long to wait.
 * Budgets stay below each provider's documented limit (see the provider files).
 */
export async function reserve(limiter: RateLimitService, bucket: string, perMinute: number) {
  const wait = await limiter.consume(`integration:${bucket}`, perMinute, 60);
  if (wait !== null)
    throw new IntegrationError('rate_limited', 'rate_limited', `Own rate limit for ${bucket}`, wait * 1000);
}
