import { describe, expect, test } from 'bun:test';
import { createTranslator } from 'next-intl';
import {
  ANALYST_SCENARIOS,
  ASSISTANT_KEYS,
  CONFIDENCE_LEVELS,
  EMAIL_TONES,
  ERROR_CODES,
  GUARDRAIL_CODES,
  NOTIFICATION_TYPES,
  type OfferCostNote,
  PERMISSION_DOMAINS,
  PERMISSION_KEYS,
  REPLY_LANGUAGES,
  RISK_LEVELS,
  SOURCE_KINDS,
  SOURCE_LABELS,
  TOOL_CALL_OUTCOMES,
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
    'contract.signing_started',
    'contract.signing_link_created',
    'contract.signer_verification_failed',
    'contract.signed',
    'contract.fully_signed',
    'contract.signing_cancelled',
    'contract_type.template_updated',
    'document_settings.updated',
    'approval_stamp.updated',
    'file.uploaded',
    'assistant.email_sent',
    'assistant.offer_applied',
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
          signerName: 'S',
        });
      for (const a of auditActions) resolved(`audit.actions.${a}`);
    });
  }
});

describe('assistant vocabularies all have labels', () => {
  const groups: [string, readonly string[]][] = [
    ['assistants.names', ASSISTANT_KEYS],
    ['assistants.short', ASSISTANT_KEYS],
    ['assistants.descriptions', ASSISTANT_KEYS],
    ['assistants.placeholder', ASSISTANT_KEYS],
    ['assistants.languages', REPLY_LANGUAGES],
    ['assistants.confidence', CONFIDENCE_LEVELS],
    ['assistants.sourceKinds', SOURCE_KINDS],
    ['assistants.sourceLabels', SOURCE_LABELS],
    ['assistants.outcomes', TOOL_CALL_OUTCOMES],
    ['assistants.flags', GUARDRAIL_CODES],
    ['assistants.offer.risks', RISK_LEVELS],
    ['assistants.analyst.scenarioNames', ANALYST_SCENARIOS],
    ['assistants.forms.tones', EMAIL_TONES],
    [
      'assistants.offer.costNotes',
      [
        'salary_unknown',
        'duration_unknown',
        'per_event_not_projected',
        'revenue_share_not_costed',
        'bonus_amount_unknown',
      ] satisfies OfferCostNote[],
    ],
  ];
  test('in English and Arabic', () => {
    for (const [prefix, values] of groups)
      for (const v of values) {
        expect({ key: `${prefix}.${v}`, en: enLeaves.has(`${prefix}.${v}`) }).toEqual({
          key: `${prefix}.${v}`,
          en: true,
        });
        expect({ key: `${prefix}.${v}`, ar: arLeaves.has(`${prefix}.${v}`) }).toEqual({
          key: `${prefix}.${v}`,
          ar: true,
        });
      }
  });
  test('plural messages render in both languages', () => {
    for (const [locale, messages] of [
      ['en', en],
      ['ar', ar],
    ] as const) {
      const t = createTranslator({ locale, messages: messages as never });
      for (const n of [0, 1, 2, 3, 11, 100]) {
        expect(
          t('assistants.offer.termsLine.duration' as never, { months: n } as never),
        ).not.toContain('{');
        expect(t('assistants.toolLog.results' as never, { count: n } as never)).not.toContain('{');
      }
    }
  });
});
