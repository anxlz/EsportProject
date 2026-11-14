import { describe, expect, test } from 'bun:test';
import { createTranslator } from 'next-intl';
import {
  ANALYST_SCENARIOS,
  ASSISTANT_KEYS,
  CONFIDENCE_LEVELS,
  EMAIL_TONES,
  ERROR_CODES,
  GUARDRAIL_CODES,
  ID_DOCUMENT_TYPES,
  INCOMING_WEBHOOK_ACTIONS,
  INTEGRATION_EVENT_CODES,
  INTEGRATION_PROVIDERS,
  INTEGRATION_STATUSES,
  MEETING_KINDS,
  MEETING_STATUSES,
  NOTIFICATION_TYPES,
  type OfferCostNote,
  PERMISSION_DOMAINS,
  PERMISSION_KEYS,
  REPLY_LANGUAGES,
  RECURRENCE_FREQUENCIES,
  RISK_LEVELS,
  RSVP_RESPONSES,
  SOURCE_KINDS,
  SOURCE_LABELS,
  SYNC_DIRECTIONS,
  SYNCED_FIELDS,
  TOOL_CALL_OUTCOMES,
  WEBHOOK_EVENT_TYPES,
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
// A `{word}` right after a plural selector (`one {day}`) is branch text, not a placeholder.
const placeholders = (s: string) =>
  [...s.matchAll(/(?<!(?:zero|one|two|few|many|other|=\d+)\s?)\{(\w+)(?:,|\})/g)]
    .map((m) => m[1])
    .sort();

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
    // ID-document patch
    'contract.signer_id_uploaded',
    'contract.signer_id_viewed',
    'contract.termination_requested',
    'contract.termination_accepted',
    'contract.termination_rejected',
    'contract.termination_withdrawn',
    'contract.termination_expired',
    'contract.terminated',
    // Phase 6
    'meeting.created',
    'meeting.updated',
    'meeting.cancelled',
    'meeting.occurrence_cancelled',
    'meeting.occurrence_moved',
    'meeting.responded',
    'integration.connected',
    'integration.updated',
    'integration.disconnected',
    'integration.secret_rotated',
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
          contractNumber: 'CT-2026-0001',
          status: 'accepted',
          requestedBy: 'R',
          approvedBy: 'A',
          rejectedBy: 'J',
          reason: 'Why',
          signerName: 'S',
          title: 'T',
          when: 'W',
          participantName: 'P',
          response: 'Going',
          name: 'N',
          code: 'auth',
          fields: 'title',
        });
      for (const a of auditActions) resolved(`audit.actions.${a}`);
    });
  }
});

/** Phase 6: every meeting / integration vocabulary value has a label. Dotted values nest. */
const meetingGroups: [string, readonly string[]][] = [
  ['meetings.kinds', MEETING_KINDS],
  ['meetings.status', MEETING_STATUSES],
  ['meetings.responses', RSVP_RESPONSES],
  ['meetings.repeat', RECURRENCE_FREQUENCIES],
  ['integrations.providers', INTEGRATION_PROVIDERS],
  ['integrations.status', INTEGRATION_STATUSES],
  ['integrations.direction', SYNC_DIRECTIONS],
  ['integrations.eventCodes', INTEGRATION_EVENT_CODES],
  ['integrations.descriptions', INTEGRATION_PROVIDERS],
  ['integrations.fieldNames', SYNCED_FIELDS],
  ['integrations.webhookEvents', WEBHOOK_EVENT_TYPES],
  ['integrations.actions', INCOMING_WEBHOOK_ACTIONS],
  ['assistants.providerNames', ['anthropic', 'qwen']],
  // ID-document patch
  ['signPage.id.types', ID_DOCUMENT_TYPES],
  ['contracts.signing.idDocument.types', ID_DOCUMENT_TYPES],
];

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
    for (const [prefix, values] of [...groups, ...meetingGroups])
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
        for (const key of [
          'meetings.fields.invitedCount',
          'meetings.repeat.unit.daily',
          'meetings.repeat.unit.weekly',
          'meetings.repeat.unit.monthly',
          'meetings.recurrenceText.count',
          'meetings.reminderLabels.minutes',
          'meetings.reminderLabels.hours',
          'meetings.reminderLabels.days',
          'integrations.linked',
        ])
          expect(t(key as never, { count: n } as never)).not.toContain('{');
        for (const key of ['daily', 'weekly', 'monthly'])
          expect(
            t(
              `meetings.recurrenceText.${key}` as never,
              { interval: n, days: 'MO', day: '3' } as never,
            ),
          ).not.toContain('{');
      }
    }
  });
  test('legacy plural messages render in both languages', () => {
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
