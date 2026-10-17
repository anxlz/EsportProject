import { describe, expect, test } from 'bun:test';
import { createTranslator } from 'next-intl';
import {
  ERROR_CODES,
  NOTIFICATION_TYPES,
  PERMISSION_DOMAINS,
  PERMISSION_KEYS,
} from '@esports/shared';
import ar from './ar.json';
import en from './en.json';

type Tree = { [k: string]: string | Tree };

function leaves(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.set(key, v);
    else for (const [kk, vv] of leaves(v, key)) out.set(kk, vv);
  }
  return out;
}

const enLeaves = leaves(en as Tree);
const arLeaves = leaves(ar as Tree);
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)(?:,|\})/g)].map((m) => m[1]).sort();

describe('message catalogs', () => {
  test('Arabic and English have exactly the same keys', () => {
    expect([...arLeaves.keys()].sort()).toEqual([...enLeaves.keys()].sort());
  });

  test('every message uses the same placeholders in both languages', () => {
    for (const [key, enText] of enLeaves) {
      expect({ key, vars: placeholders(arLeaves.get(key) ?? '') }).toEqual({
        key,
        vars: placeholders(enText),
      });
    }
  });

  test('no empty messages', () => {
    for (const [key, v] of [...enLeaves, ...arLeaves])
      expect({ key, empty: v.trim() === '' }).toEqual({ key, empty: false });
  });

  test('every API error code, permission, domain and notification type has a translation', () => {
    for (const code of ERROR_CODES) expect(enLeaves.has(`errors.${code}`)).toBe(true);
    for (const key of PERMISSION_KEYS) expect(enLeaves.has(`permissions.${key}`)).toBe(true);
    for (const d of PERMISSION_DOMAINS) expect(enLeaves.has(`permissionDomains.${d}`)).toBe(true);
    for (const n of NOTIFICATION_TYPES) expect(enLeaves.has(`notifications.types.${n}`)).toBe(true);
  });
});

describe('keys resolve through next-intl (dots in keys are nesting, not literal)', () => {
  const auditActions = [
    'organization.created',
    'role.created',
    'role.updated',
    'member.suspended',
    'member.ownership_granted',
    'invitation.accepted',
    'team.exported',
    'auth.login_failed',
    'platform.members_viewed',
    'finance.expense_created',
    'finance.report_exported',
    'budget.exceeded',
    'roster.compensation_changed',
    'tournament.created',
    'season.created',
    'contract.created',
    'contract.approved',
    'contract.rejected',
    'contract.clause_accepted',
    'contract_type.template_updated',
    'document_settings.updated',
    'approval_stamp.updated',
    'file.uploaded',
  ];
  for (const [locale, messages] of [
    ['en', en],
    ['ar', ar],
  ] as const) {
    test(`${locale}: every label renders as text, never as its own key`, () => {
      const t = createTranslator({ locale, messages: messages as never });
      const resolved = (key: string, values?: Record<string, string>) => {
        const out = t(key as never, values as never);
        expect({ key, raw: out === key || out.includes(key) }).toEqual({ key, raw: false });
      };
      for (const key of PERMISSION_KEYS) resolved(`permissions.${key}`);
      for (const code of ERROR_CODES) resolved(`errors.${code}`);
      for (const n of NOTIFICATION_TYPES)
        resolved(`notifications.types.${n}`, {
          memberName: 'X',
          byName: 'Y',
          budgetName: 'B',
          line: 'L',
          actual: '1',
          planned: '2',
          number: 'CT-2026-0001',
          requestedBy: 'R',
          approvedBy: 'A',
          rejectedBy: 'J',
          reason: 'Why',
        });
      for (const a of auditActions) resolved(`audit.actions.${a}`);
    });
  }
});
