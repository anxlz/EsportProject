import 'reflect-metadata';
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
