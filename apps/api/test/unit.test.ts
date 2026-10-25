import { describe, expect, test } from 'bun:test';
import { Logger } from '@nestjs/common';
import { Access, buildGrants } from '../src/authz/access';
import { toCsv } from '../src/common/csv';
import { GlobalExceptionFilter } from '../src/common/errors';
import { loadEnv } from '../src/config/env';

describe('buildGrants (pure authorization logic)', () => {
  const D1 = 'd1',
    T1 = 't1',
    T2 = 't2';

  test('scopable permission from team + department assignments is the union', () => {
    const { grants } = buildGrants([
      {
        grantsAll: false,
        permissionKeys: ['teams.view'],
        scopeType: 'team',
        departmentId: null,
        teamId: T1,
      },
      {
        grantsAll: false,
        permissionKeys: ['teams.view'],
        scopeType: 'department',
        departmentId: D1,
        teamId: null,
      },
    ]);
    const a = new Access('o', 'u', grants, false);
    expect(a.coversTeam('teams.view', { id: T1, departmentId: null })).toBe(true);
    expect(a.coversTeam('teams.view', { id: T2, departmentId: D1 })).toBe(true);
    expect(a.coversTeam('teams.view', { id: T2, departmentId: 'other' })).toBe(false);
    expect(a.coversDepartment('teams.view', D1)).toBe(true);
    expect(a.coversDepartment('teams.view', null)).toBe(false);
  });

  test('an organization-wide assignment wins over narrower ones', () => {
    const { grants } = buildGrants([
      {
        grantsAll: false,
        permissionKeys: ['teams.view'],
        scopeType: 'team',
        departmentId: null,
        teamId: T1,
      },
      {
        grantsAll: false,
        permissionKeys: ['teams.view'],
        scopeType: 'organization',
        departmentId: null,
        teamId: null,
      },
    ]);
    expect(grants.get('teams.view')).toEqual({ all: true });
  });

  test('non-scopable permissions are organization-level regardless of assignment scope', () => {
    const { grants } = buildGrants([
      {
        grantsAll: false,
        permissionKeys: ['games.view'],
        scopeType: 'team',
        departmentId: null,
        teamId: T1,
      },
    ]);
    expect(grants.get('games.view')).toEqual({ all: true });
  });

  test('owner-only keys on a non-owner role are ignored even if present in the database', () => {
    const { grants, isOwner } = buildGrants([
      {
        grantsAll: false,
        permissionKeys: ['roles.manage', 'members.manage', 'teams.view'],
        scopeType: 'organization',
        departmentId: null,
        teamId: null,
      },
    ]);
    expect(isOwner).toBe(false);
    expect(grants.has('roles.manage')).toBe(false);
    expect(grants.has('members.manage')).toBe(false);
    expect(grants.has('teams.view')).toBe(true);
  });

  test('unknown permission keys are ignored', () => {
    const { grants } = buildGrants([
      {
        grantsAll: false,
        permissionKeys: ['finance.delete_everything'],
        scopeType: 'organization',
        departmentId: null,
        teamId: null,
      },
    ]);
    expect(grants.size).toBe(0);
  });

  test('grantsAll yields every permission organization-wide and marks owner', () => {
    const { grants, isOwner } = buildGrants([
      {
        grantsAll: true,
        permissionKeys: [],
        scopeType: 'organization',
        departmentId: null,
        teamId: null,
      },
    ]);
    expect(isOwner).toBe(true);
    expect(grants.get('roles.manage')).toEqual({ all: true });
    expect(grants.get('teams.delete')).toEqual({ all: true });
  });

  test('Access survives a JSON round-trip (Redis cache)', () => {
    const { grants } = buildGrants([
      {
        grantsAll: false,
        permissionKeys: ['teams.view'],
        scopeType: 'department',
        departmentId: D1,
        teamId: null,
      },
    ]);
    const a = new Access('o', 'u', grants, false);
    const b = Access.fromJSON('o', 'u', false, JSON.parse(JSON.stringify(a.toJSON())));
    expect(b.coversTeam('teams.view', { id: 'x', departmentId: D1 })).toBe(true);
    expect(b.has('teams.edit')).toBe(false);
  });
});

describe('CSV export', () => {
  test('escapes quotes/commas and neutralises spreadsheet formulas', () => {
    const csv = toCsv(
      ['a', 'b'],
      [
        ['=HYPERLINK("x")', 'he said "hi", ok'],
        ['فريق', null],
      ],
    );
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain('"he said ""hi"", ok"');
    expect(csv).toContain('فريق,');
  });
});

describe('CSV numbers', () => {
  test('negative amounts stay numbers; formula-like text is still neutralised', () => {
    const csv = toCsv(['v'], [['-500.00'], ['-1+2'], ['-']]);
    expect(csv).toContain('\r\n-500.00\r\n');
    expect(csv).toContain("'-1+2");
    expect(csv).toContain("'-\r\n");
  });
});

describe('database error mapping', () => {
  // Drizzle wraps the driver error and keeps the Postgres error (with its SQLSTATE) on `cause`.
  const wrapped = (code: string, detail = '') =>
    Object.assign(new Error('Failed query: insert …'), {
      cause: Object.assign(new Error('pg error'), { code, detail, severity: 'ERROR' }),
    });
  function run(err: unknown) {
    let status = 0;
    let body: { error: { code: string } } | null = null;
    const res = { status: (s: number) => ((status = s), { json: (b: typeof body) => (body = b) }) };
    const host = { switchToHttp: () => ({ getResponse: () => res }) };
    new GlobalExceptionFilter().catch(err, host as never);
    return { status, code: body!.error.code };
  }

  test('a wrapped unique violation is a 409 conflict', () => {
    expect(run(wrapped('23505'))).toEqual({ status: 409, code: 'conflict' });
  });
  test('deleting a referenced record is 409 in_use; a bad reference is 400', () => {
    expect(
      run(wrapped('23503', 'Key (id)=(…) is still referenced from table "finance_entries".')),
    ).toEqual({ status: 409, code: 'in_use' });
    expect(run(wrapped('23503', 'Key (team_id)=(…) is not present in table "teams".'))).toEqual({
      status: 400,
      code: 'validation_failed',
    });
  });
  test('anything else is a 500 without details', () => {
    Logger.overrideLogger(false); // the filter logs the stack; keep test output clean
    expect(run(new Error('boom'))).toEqual({ status: 500, code: 'internal_error' });
  });
});

describe('environment validation', () => {
  const base = {
    DATABASE_URL: 'postgres://x',
    REDIS_URL: 'redis://x',
    WEB_APP_URL: 'https://app.example.com',
    SESSION_SECRET: 'x'.repeat(40),
  };

  test('production refuses the plain-text outbox mail transport', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production' })).toThrow(/MAIL_TRANSPORT/);
  });

  test('secure cookies default on in production', () => {
    const env = loadEnv({
      ...base,
      NODE_ENV: 'production',
      MAIL_TRANSPORT: 'smtp',
      SMTP_HOST: 'smtp.example.com',
      MAIL_FROM: 'a@example.com',
      DOCUMENT_ENCRYPTION_KEY: 'k'.repeat(40), // required in production since the ID-document patch
    });
    expect(env.cookieSecure).toBe(true);
    expect(env.apiDocsEnabled).toBe(false);
  });

  test('production requires a dedicated key for identity documents (ID-document patch)', () => {
    const prod = {
      ...base,
      NODE_ENV: 'production',
      MAIL_TRANSPORT: 'smtp',
      SMTP_HOST: 'smtp.example.com',
      MAIL_FROM: 'a@example.com',
    };
    expect(() => loadEnv(prod)).toThrow(/DOCUMENT_ENCRYPTION_KEY/);
    expect(() => loadEnv({ ...prod, DOCUMENT_ENCRYPTION_KEY: 'short' })).toThrow(
      /DOCUMENT_ENCRYPTION_KEY/,
    );
    expect(loadEnv({ ...prod, DOCUMENT_ENCRYPTION_KEY: 'k'.repeat(40) }).NODE_ENV).toBe(
      'production',
    );
  });

  test('partial Discord configuration is rejected', () => {
    expect(() => loadEnv({ ...base, DISCORD_CLIENT_ID: 'abc' })).toThrow(/Discord/);
  });

  test('short session secrets are rejected', () => {
    expect(() => loadEnv({ ...base, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
  });

  test('on Vercel: the deployment’s own URL, one proxy hop, and no in-process timer by default', () => {
    const { WEB_APP_URL: _unset, ...noWeb } = base;
    const vercel = {
      ...noWeb,
      VERCEL: '1',
      VERCEL_URL: 'esports-abc123.vercel.app',
      VERCEL_BRANCH_URL: 'esports-git-feature.vercel.app',
      VERCEL_PROJECT_PRODUCTION_URL: 'club.example.com',
    };
    const preview = loadEnv({ ...vercel, VERCEL_ENV: 'preview' });
    expect(preview.WEB_APP_URL).toBe('https://esports-git-feature.vercel.app');
    expect(preview.publicApiUrl).toBe('https://esports-git-feature.vercel.app/api');
    expect(preview.allowedOrigins.sort()).toEqual(
      [
        'https://esports-abc123.vercel.app',
        'https://esports-git-feature.vercel.app',
        'https://club.example.com',
      ].sort(),
    );
    expect([
      preview.TRUST_PROXY_HOPS,
      preview.SCHEDULER_INTERVAL_SECONDS,
      preview.onVercel,
    ]).toEqual([1, 0, true]);
    const prod = loadEnv({
      ...vercel,
      VERCEL_ENV: 'production',
      NODE_ENV: 'production',
      MAIL_TRANSPORT: 'smtp',
      SMTP_HOST: 'smtp.example.com',
      MAIL_FROM: 'a@example.com',
      DOCUMENT_ENCRYPTION_KEY: 'k'.repeat(40),
    });
    expect(prod.WEB_APP_URL).toBe('https://club.example.com');
    // Anything set explicitly wins.
    const explicit = loadEnv({
      ...vercel,
      WEB_APP_URL: 'https://app.example.org',
      TRUST_PROXY_HOPS: '2',
      SCHEDULER_INTERVAL_SECONDS: '60',
    });
    expect([
      explicit.WEB_APP_URL,
      explicit.TRUST_PROXY_HOPS,
      explicit.SCHEDULER_INTERVAL_SECONDS,
    ]).toEqual(['https://app.example.org', 2, 60]);
    expect(explicit.allowedOrigins).toContain('https://app.example.org');
    // Not on Vercel: nothing changes.
    const plain = loadEnv(base);
    expect([plain.TRUST_PROXY_HOPS, plain.SCHEDULER_INTERVAL_SECONDS, plain.onVercel]).toEqual([
      0,
      30,
      false,
    ]);
    expect(plain.allowedOrigins).toEqual(['https://app.example.com']);
  });
});
