/** Unit tests for the assistants' deterministic helpers (no app, no provider). */
import { describe, expect, test } from 'bun:test';
import { contractDetailsSchema } from '@esports/shared';
import { normalizeTerms } from '../src/assistants/assistant-engine';
import { applyTerms, endDateFor, titleFrom } from '../src/assistants/assistants.service';
import {
  checkClaims,
  checkGuarantees,
  Flags,
  LINK_REMOVED,
  languageMatches,
  scrubLinks,
  SourceRegistry,
  urlsIn,
} from '../src/assistants/guardrails';

describe('source registry', () => {
  test('ids per kind, web results deduplicated by URL, quoted text attached', () => {
    const r = new SourceRegistry(() => new Date('2026-10-18T10:00:00Z'));
    expect(r.addPlatform('Teams', '/dashboard/teams', [{ name: 'A' }])).toBe('P1');
    expect(r.addWeb('https://x.example/a', 'A', '2026')).toBe('W1');
    expect(r.addWeb('https://x.example/a', 'A again', null)).toBe('W1');
    expect(r.addWebExcerpt('https://x.example/b', 'B', 'Quoted')).toBe('W2');
    expect(r.addUser('Context you provided', 'Salary 15000')).toBe('U1');
    expect(r.hasEvidence('P1')).toBe(true);
    expect(r.hasEvidence('W1')).toBe(false);
    expect(r.hasEvidence('W2')).toBe(true);
    expect(r.list().map((s) => [s.id, s.kind, s.excerpt])).toEqual([
      ['P1', 'platform', null],
      ['W1', 'web', null],
      ['W2', 'web', 'Quoted'],
      ['U1', 'user', null],
    ]);
    expect(r.evidencePack()).toContain(
      '[W1] web — A <https://x.example/a> (page updated 2026)\n  (search result only: no quoted text)',
    );
  });

  test('platform and user sources carry a label for a localized name; web sources keep their title', () => {
    const r = new SourceRegistry();
    r.addPlatform('Roster — Najd VALORANT', '/dashboard/teams/t1', [], {
      key: 'roster',
      subject: 'Najd VALORANT',
    });
    r.addWeb('https://x.example/a', 'Page title', null);
    r.addUser('Terms you provided', 'Salary 15000', 'user_terms');
    expect(r.list().map((s) => [s.id, s.title, s.label, s.subject])).toEqual([
      ['P1', 'Roster — Najd VALORANT', 'roster', 'Najd VALORANT'],
      ['W1', 'Page title', null, null],
      ['U1', 'Terms you provided', 'user_terms', null],
    ]);
  });

  test('claims keep only registered sources; "confirmed" needs evidence', () => {
    const r = new SourceRegistry();
    r.addPlatform('Finance', '/dashboard/finance', { total: 1 });
    const f = new Flags();
    expect(
      checkClaims(
        [
          { text: 'a', confidence: 'confirmed', sourceIds: ['P1', 'P1', 'X3'] },
          { text: 'b', confidence: 'confirmed', sourceIds: [] },
          { text: 'c', confidence: 'estimated', sourceIds: ['P1'] },
        ],
        r,
        f,
      ),
    ).toEqual([
      { text: 'a', confidence: 'confirmed', sourceIds: ['P1'] },
      { text: 'b', confidence: 'uncertain', sourceIds: [] },
      { text: 'c', confidence: 'estimated', sourceIds: ['P1'] },
    ]);
    expect(f.all().map((x) => x.code)).toEqual([
      'unknown_source_removed',
      'unsupported_confirmation',
    ]);
  });

  test('links: kept if a tool returned them or the user wrote them', () => {
    const f = new Flags();
    const allowed = ['https://ok.example/a', ...urlsIn(['see https://user.example/doc.'])];
    expect(
      scrubLinks(
        'A https://ok.example/a, B https://user.example/doc and C https://made.up/x.',
        allowed,
        f,
      ),
    ).toBe(`A https://ok.example/a, B https://user.example/doc and C ${LINK_REMOVED}.`);
    expect(f.all()).toEqual([{ code: 'link_removed', detail: 'https://made.up/x' }]);
  });

  test('language check ignores very short text and counts letters', () => {
    expect(languageMatches('OK', 'ar')).toBe(true);
    expect(languageMatches('هذه إجابة باللغة العربية عن Team A.', 'ar')).toBe(true);
    expect(languageMatches('This answer is in English.', 'ar')).toBe(false);
  });
});

describe('offer terms and applying them', () => {
  test('model output is normalised field by field', () => {
    expect(
      normalizeTerms({
        salaryAmount: '16,000',
        currency: 'sar',
        frequency: 'fortnightly',
        durationMonths: '18',
        signingBonus: '',
        bonuses: [{ description: 'MVP', amount: 'lots' }, 'junk'],
        revenueSharePercent: '150',
        buyoutAmount: '150000',
      }),
    ).toEqual({
      salaryAmount: '16000',
      currency: 'SAR',
      frequency: 'monthly',
      durationMonths: 18,
      signingBonus: null,
      bonuses: [],
      revenueSharePercent: null,
      buyoutAmount: '150000',
      otherTerms: null,
    });
  });

  test('end dates are inclusive and clamp to month ends', () => {
    expect(endDateFor('2027-01-01', 18)).toBe('2028-06-30');
    expect(endDateFor('2026-01-01', 12)).toBe('2026-12-31');
    expect(endDateFor('2026-01-31', 1)).toBe('2026-02-27');
    expect(endDateFor('2024-03-15', 12)).toBe('2025-03-14');
  });

  test('an alternative fills only the terms it sets, and the result is valid contract details', () => {
    const base = contractDetailsSchema.parse({
      recipient: { kind: 'player', fullNameEn: 'Saad' },
      startDate: '2027-01-01',
      endDate: '2027-12-31',
      compensation: { amount: '15000', currency: 'SAR', frequency: 'monthly' },
      revenueShare: { percent: '3' },
      buyout: { amount: '50000', currency: 'SAR' },
    });
    const out = applyTerms(base, {
      salaryAmount: '18000',
      currency: 'SAR',
      frequency: 'monthly',
      durationMonths: null,
      signingBonus: '0',
      bonuses: [],
      revenueSharePercent: null,
      buyoutAmount: null,
    });
    expect(out.compensation.amount).toBe('18000');
    expect(out.endDate).toBe('2027-12-31');
    expect(out.revenueShare.percent).toBe('3');
    expect(out.buyout.amount).toBe('50000');
    expect(out.bonuses).toEqual([]);
    expect(contractDetailsSchema.safeParse(out).success).toBe(true);
    expect(base.compensation.amount).toBe('15000'); // not mutated
  });
});

describe('guarantee wording', () => {
  const flagged = (text: string) => {
    const f = new Flags();
    checkGuarantees([text], f);
    return f.all().map((x) => x.detail);
  };
  test('promises about outcomes are flagged, in English and Arabic', () => {
    expect(flagged('A guaranteed return within one season.')).toEqual(['guaranteed']);
    expect(flagged('He is sure to reach playoffs.')).toEqual(['sure to']);
    expect(flagged('عائد مضمون خلال موسم واحد')).toEqual(['مضمون']);
    expect(flagged('نضمن التأهل')).toEqual(['نضمن']);
  });
  test('the fixed, guaranteed part of an offer is ordinary contract wording', () => {
    expect(flagged('The player may see less guaranteed pay.')).toEqual([]);
    expect(flagged('A guaranteed base salary of 16,000 a month.')).toEqual([]);
    expect(flagged('Guaranteed minimum plus bonuses.')).toEqual([]);
    expect(flagged('راتب مضمون أقل مع مكافآت أداء')).toEqual([]);
    expect(flagged('يحصل على راتبًا مضمونًا')).toEqual([]);
  });
});

describe('conversation titles', () => {
  test('short messages are the title; long ones are cut at a word with an ellipsis', () => {
    expect(titleFrom('  How are   we doing?  ')).toBe('How are we doing?');
    const long =
      'Ask the arena to reserve their training hall for our bootcamp, 10–20 November, ten people.';
    expect(titleFrom(long)).toBe(
      'Ask the arena to reserve their training hall for our bootcamp, 10–20 November…',
    );
    expect(titleFrom(long).length).toBeLessThanOrEqual(80);
    expect(titleFrom('x'.repeat(200))).toBe(`${'x'.repeat(79)}…`);
  });
});
