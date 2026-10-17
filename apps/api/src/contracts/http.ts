import { Logger } from '@nestjs/common';
import type { Response } from 'express';
import { AppError } from '../common/errors';

/**
 * Contract previews are self-contained HTML (inline styles, data: images and fonts). They are
 * served with a policy that forbids scripts, network access and framing by other sites, and the
 * dashboard shows them in a sandboxed iframe.
 */
export const PREVIEW_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; frame-ancestors 'self'; sandbox";

export function sendPreviewHtml(res: Response, html: string) {
  res
    .status(200)
    .set({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': PREVIEW_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
      'Referrer-Policy': 'no-referrer',
    })
    .send(html);
}

const log = new Logger('ContractDocuments');

/** PDF rendering failures surface as a translatable "export failed" instead of a 500 trace. */
export async function renderGuard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) throw err;
    log.error(`Contract PDF failed: ${err instanceof Error ? err.message : String(err)}`);
    throw new AppError('export_failed', 500, 'The document could not be generated. Please try again.');
  }
}

export const asciiFilename = (name: string) => name.replace(/[^A-Za-z0-9._-]+/g, '_');
