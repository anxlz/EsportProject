import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import type { Express } from 'express';
import type { Env } from './config/env';

/** Applies HTTP-level configuration. Shared by main.ts and the test harness. */
export function configureApp(app: INestApplication, env: Env): void {
  const http = app.getHttpAdapter().getInstance() as Express;
  // Required so req.ip is the real client IP behind Vercel's rewrite / the host's proxy.
  // Must match the actual number of proxies, or rate limits key on the proxy's IP.
  http.set('trust proxy', env.TRUST_PROXY_HOPS);
  http.disable('x-powered-by');
  app.use(cookieParser());
  app.enableShutdownHooks();
  // Browsers reach the API through the web app's own origin (Next.js rewrite), so CORS is only
  // needed for the explicitly allowed extra origins.
  app.enableCors({ origin: env.allowedOrigins, credentials: true });

  if (env.apiDocsEnabled) {
    const config = new DocumentBuilder()
      .setTitle('Esports Organization Management Platform API')
      .setVersion('0.1.0 (Phase 1)')
      .addCookieAuth(env.cookieSecure ? '__Host-esp_sid' : 'esp_sid')
      .build();
    SwaggerModule.setup('docs', app, () => SwaggerModule.createDocument(app, config));
  }
}
