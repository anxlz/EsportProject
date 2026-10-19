import { describe, expect, test } from 'bun:test';
import { ASSISTANT_KEYS, ASSISTANT_PERMISSION, detectLanguage, replyLanguageFor } from './catalog';
import { costDelta, offerCost, type OfferTerms } from './offer';
import { ASSISTANT_CONTEXT_SCHEMAS, offerTermsSchema, sendProposedEmailSchema } from './schemas';
import { DEFAULT_ROLE_TEMPLATES, PERMISSIONS } from '../permissions';

const terms = (over: Partial<OfferTerms>): OfferTerms => ({
  currency: 'SAR',
  frequency: 'monthly',
  bonuses: [],
  ...over,
});

describe('offer cost (hand-computed)', () => {
  test('monthly pay over a term, plus signing bonus and every bonus earned', () => {
    // 15,000 × 12 = 180,000; + 10,000 signing; + 25,000 + 5,000 bonuses = 220,000.
    const c = offerCost(
      terms({
        salaryAmount: '15000',
        durationMonths: 12,
        signingBonus: '10000',
        bonuses: [
          { description: 'Masters qualification', amount: '25000' },
          { description: 'MVP', amount: '5000' },
        ],
      }),
    );
    expect(c).toEqual({
      currency: 'SAR',
      monthly: '15000.00',
      base: '180000.00',
      signingBonus: '10000.00',
      bonusesMax: '30000.00',
      totalUpperBound: '220000.00',
      notes: [],
    });
  });

  test('weekly, quarterly and annual pay convert to monthly equivalents exactly', () => {
    // 1,000 × 52 / 12 = 4,333.33…; × 6 months = 26,000.00 exactly.
    const weekly = offerCost(
      terms({ salaryAmount: '1000', frequency: 'weekly', durationMonths: 6 }),
    );
    expect(weekly.monthly).toBe('4333.33');
    expect(weekly.base).toBe('26000.00');
    // 9,000 per quarter = 3,000 a month; × 18 = 54,000.
    expect(
      offerCost(terms({ salaryAmount: '9000', frequency: 'quarterly', durationMonths: 18 })).base,
    ).toBe('54000.00');
    // 120,000 a year over 30 months = 300,000.
    expect(
      offerCost(terms({ salaryAmount: '120000', frequency: 'annually', durationMonths: 30 }))
        .totalUpperBound,
    ).toBe('300000.00');
    // KWD has 3 minor units: 1,000 a fortnight × 26 / 12 = 2,166.667 a month.
    expect(
      offerCost(terms({ currency: 'KWD', salaryAmount: '1000', frequency: 'biweekly' })).monthly,
    ).toBe('2166.667');
  });

  test('what cannot be computed is reported, not guessed', () => {
    expect(
      offerCost(terms({ salaryAmount: '500', frequency: 'per_event', durationMonths: 12 })),
    ).toMatchObject({ base: null, totalUpperBound: null, notes: ['per_event_not_projected'] });
    expect(offerCost(terms({ salaryAmount: '15000' }))).toMatchObject({
      totalUpperBound: null,
      notes: ['duration_unknown'],
    });
    expect(offerCost(terms({ durationMonths: 12 })).notes).toEqual(['salary_unknown']);
    expect(
      offerCost(
        terms({
          salaryAmount: '15000',
          durationMonths: 12,
          revenueSharePercent: '10',
          bonuses: [{ description: 'Win a final' }],
        }),
      ).notes.sort(),
    ).toEqual(['bonus_amount_unknown', 'revenue_share_not_costed']);
    // One-time pay is the amount itself, whatever the duration.
    expect(
      offerCost(terms({ salaryAmount: '40000', frequency: 'one_time', durationMonths: 24 }))
        .totalUpperBound,
    ).toBe('40000.00');
  });

  test('differences only between comparable totals', () => {
    const preferred = offerCost(terms({ salaryAmount: '15000', durationMonths: 12 }));
    const requested = offerCost(
      terms({ salaryAmount: '18000', durationMonths: 24, signingBonus: '20000' }),
    );
    // 432,000 + 20,000 − 180,000 = 272,000.
    expect(costDelta(requested, preferred)).toBe('272000.00');
    expect(costDelta(preferred, requested)).toBe('-272000.00');
    const usd = offerCost(terms({ currency: 'USD', salaryAmount: '4000', durationMonths: 12 }));
    expect(costDelta(usd, preferred)).toBeNull();
    expect(costDelta(offerCost(terms({ salaryAmount: '1' })), preferred)).toBeNull();
  });
});

describe('language per message', () => {
  test('the script with more letters wins', () => {
    expect(detectLanguage('What did Team A spend on travel?')).toBe('en');
    expect(detectLanguage('كم أنفق فريق Team A على السفر؟')).toBe('ar');
    expect(detectLanguage('Draft a message to سعد about training')).toBe('en');
    expect(detectLanguage('12345')).toBe('en');
  });
  test('a fixed conversation language overrides detection', () => {
    expect(replyLanguageFor('auto', 'مرحبا')).toBe('ar');
    expect(replyLanguageFor('en', 'مرحبا')).toBe('en');
    expect(replyLanguageFor('ar', 'Hello')).toBe('ar');
  });
});

describe('assistant access and schemas', () => {
  test('each assistant has its own permission in the catalog', () => {
    for (const k of ASSISTANT_KEYS) {
      expect(PERMISSIONS[ASSISTANT_PERMISSION[k]]).toMatchObject({ domain: 'assistants' });
      expect(ASSISTANT_CONTEXT_SCHEMAS[k]).toBeDefined();
    }
    const ops = DEFAULT_ROLE_TEMPLATES.find((r) => r.templateKey === 'esports_operations')!;
    expect(ops.permissions).toContain('assistants.general');
    expect(ops.permissions).not.toContain('assistants.offer_optimizer');
    expect(ops.permissions).not.toContain('assistants.send_email');
  });

  test('offer terms and email sending are validated', () => {
    expect(offerTermsSchema.safeParse({ salaryAmount: '-5' }).success).toBe(false);
    expect(offerTermsSchema.safeParse({ revenueSharePercent: '120' }).success).toBe(false);
    expect(offerTermsSchema.parse({ salaryAmount: '1500.5' })).toMatchObject({
      currency: 'SAR',
      frequency: 'monthly',
      bonuses: [],
    });
    const ok = { to: [{ email: 'a@b.co' }], subject: 'Hi', body: 'Text' };
    expect(sendProposedEmailSchema.safeParse(ok).success).toBe(true);
    expect(sendProposedEmailSchema.safeParse({ ...ok, to: [] }).success).toBe(false);
    expect(
      sendProposedEmailSchema.safeParse({
        ...ok,
        to: Array.from({ length: 11 }, (_, i) => ({ email: `p${i}@b.co` })),
      }).success,
    ).toBe(false);
  });
});
