import { describe, expect, test } from 'bun:test';
import { Access, buildGrants } from '../src/authz/access';
import { toCsv } from '../src/common/csv';
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
    });
    expect(env.cookieSecure).toBe(true);
    expect(env.apiDocsEnabled).toBe(false);
  });

  test('partial Discord configuration is rejected', () => {
    expect(() => loadEnv({ ...base, DISCORD_CLIENT_ID: 'abc' })).toThrow(/Discord/);
  });

  test('short session secrets are rejected', () => {
    expect(() => loadEnv({ ...base, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
  });
});
