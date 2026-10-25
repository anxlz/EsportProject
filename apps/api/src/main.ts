import 'reflect-metadata';
// Nest loads its HTTP adapter with a dynamic require; importing it here lets bundlers and file
// tracers (Vercel's build) see it and ship it with the function.
import '@nestjs/platform-express';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { loadEnv } from './config/env';

const env = loadEnv();
const app = await NestFactory.create(AppModule.forRoot(env), {
  logger: env.NODE_ENV === 'production' ? ['log', 'warn', 'error'] : undefined,
});
configureApp(app, env);
await app.listen(env.PORT, '0.0.0.0');
Logger.log(
  `API listening on :${env.PORT}${env.apiDocsEnabled ? ` — docs at /docs` : ''}`,
  'Bootstrap',
);
