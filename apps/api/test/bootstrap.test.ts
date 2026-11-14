import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { expect, test } from 'bun:test';
import { configureApp } from '../src/bootstrap';
import { loadEnv } from '../src/config/env';

@Controller('health')
class HealthController {
  @Get()
  check() {
    return { status: 'ok' };
  }
}

@Module({ controllers: [HealthController] })
class HealthTestModule {}

test('Vercel API paths include /api while local paths do not', async () => {
  const app = await NestFactory.create(HealthTestModule, { logger: false });
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/test',
    REDIS_URL: 'redis://localhost:6379',
    WEB_APP_URL: 'https://example.com',
    SESSION_SECRET: 'test-session-secret-with-at-least-32-characters',
    VERCEL: '1',
    VERCEL_URL: 'example.com',
  });
  configureApp(app, env);
  await app.listen(0, '127.0.0.1');

  try {
    const address = app.getHttpServer().address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${address.port}/api/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  } finally {
    await app.close();
  }

  const localApp = await NestFactory.create(HealthTestModule, { logger: false });
  const localEnv = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/test',
    REDIS_URL: 'redis://localhost:6379',
    WEB_APP_URL: 'http://localhost:3000',
    SESSION_SECRET: 'test-session-secret-with-at-least-32-characters',
  });
  configureApp(localApp, localEnv);
  await localApp.listen(0, '127.0.0.1');

  try {
    const address = localApp.getHttpServer().address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    expect(response.status).toBe(200);
  } finally {
    await localApp.close();
  }
});
