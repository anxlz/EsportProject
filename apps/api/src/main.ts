import 'reflect-metadata';
// Nest loads its HTTP adapter with a dynamic require; importing it here lets bundlers and file
// tracers (Vercel's build) see it and ship it with the function.
import '@nestjs/platform-express';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Request, Response } from 'express';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { loadEnv } from './config/env';

const env = loadEnv();

let appPromise: Promise<INestApplication> | undefined;

async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(env), {
    logger: env.NODE_ENV === 'production' ? ['log', 'warn', 'error'] : undefined,
  });
  configureApp(app, env);
  await app.init();
  return app;
}

async function cachedApp(): Promise<INestApplication> {
  appPromise ??= createApp();
  try {
    return await appPromise;
  } catch (error) {
    appPromise = undefined;
    throw error;
  }
}

if (env.onVercel) {
  const logger = new Logger('Bootstrap');
  logger.log('API serverless handler ready');
} else {
  const app = await createApp();
  await app.listen(env.PORT, '0.0.0.0');
  Logger.log(
    `API listening on :${env.PORT}${env.apiDocsEnabled ? ` — docs at /docs` : ''}`,
    'Bootstrap',
  );
}

export default async function handler(req: Request, res: Response): Promise<void> {
  const app = await cachedApp();
  const expressApp = app.getHttpAdapter().getInstance() as (req: Request, res: Response) => void;
  expressApp(req, res);
}
