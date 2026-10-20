import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import type { Express, NextFunction, Request, Response } from 'express';
import type { Env } from './config/env';

/** Applies HTTP-level configuration. Shared by main.ts and the test harness. */
export function configureApp(app: INestApplication, env: Env): void {
  const http = app.getHttpAdapter().getInstance() as Express;
  // Required so req.ip is the real client IP behind Vercel's rewrite / the host's proxy.
  // Must match the actual number of proxies, or rate limits key on the proxy's IP.
  http.set('trust proxy', env.TRUST_PROXY_HOPS);
  http.disable('x-powered-by');
  app.use(cookieParser());
  // Provider callbacks and incoming webhooks are verified against the exact bytes received,
  // so their bodies are kept raw (registered first; the JSON parser then skips them).
  app.use('/integrations/hooks', rawBody(1024 * 1024));
  // JSON bodies up to 1 MB (bilingual contracts with many clauses), and raw uploads of the file
  // types the file store accepts (its service enforces per-kind limits and checks the bytes).
  const express = app as NestExpressApplication;
  express.useBodyParser('json', { limit: '1mb' });
  express.useBodyParser('raw', {
    type: ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'],
    limit: '6mb',
  });
  app.enableShutdownHooks();
  // Browsers reach the API through the web app's own origin (Next.js rewrite), so CORS is only
  // needed for the explicitly allowed extra origins.
  app.enableCors({ origin: env.allowedOrigins, credentials: true });

  if (env.apiDocsEnabled) {
    const config = new DocumentBuilder()
      .setTitle('Esports Organization Management Platform API')
      .setVersion('0.3.0 (Phase 3)')
      .addCookieAuth(env.cookieSecure ? '__Host-esp_sid' : 'esp_sid')
      .build();
    SwaggerModule.setup('docs', app, () => SwaggerModule.createDocument(app, config));
  }
}

/**
 * Keeps the request body as a Buffer (req.body) and marks it parsed, so the JSON parser
 * registered later leaves it alone. Bodies over `limit` bytes are refused with 413.
 */
function rawBody(limit: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        res.status(413).json({ error: { code: 'validation_failed', message: 'Body too large' } });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      (req as Request & { _body?: boolean }).body = Buffer.concat(chunks);
      (req as Request & { _body?: boolean })._body = true;
      next();
    });
    req.on('error', (e) => {
      if (!done) {
        done = true;
        next(e);
      }
    });
  };
}
