import { describe, expect, test } from 'bun:test';
import { formatDuration } from './i18n';
import {
  completenessIssues,
  contractLength,
  fillTemplate,
  mergeValues,
  placeholdersIn,
} from './merge';
import {
  contractClauseSchema,
  contractDetailsSchema,
  contractSaveSchema,
  rejectionSchema,
} from './schemas';
import { DEFAULT_CONTRACT_TYPES } from './templates';
import { ageOn, isMinorOn, maskEmail, requiredSigners } from './signing';
import { CONSENT_VERSION, consentText } from './i18n';
import { scriptOf, signatureFontsFor } from './catalog';
import { signSchema, strokeLength } from './schemas';
import { MERGE_FIELDS } from './catalog';
import type { ContractSnapshot } from './dto';

const ctx = {
  organizationName: 'Riyadh Falcons',
  legalNameEn: null,
  legalNameAr: null,
  contractNumber: 'CT-2026-0001',
};

function snapshot(
  details: Partial<ContractSnapshot['details']> = {},
  clauses: ContractSnapshot['clauses'] = [],
): ContractSnapshot {
  return {
    contractTypeId: '00000000-0000-4000-8000-000000000000',
    typeNameEn: 'Player contract',
    typeNameAr: 'عقد لاعب',
    teamId: null,
    teamName: 'Team A',
    gameName: 'VALORANT',
    rosterMemberId: null,
    details: contractDetailsSchema.parse({
      recipient: {
        kind: 'player',
        fullNameEn: 'Saad',
        fullNameAr: 'سعد',
        dateOfBirth: '2000-01-01',
      },
      ...details,
    }),
    clauses,
  };
}

describe('contract length', () => {
  test('counts both dates and clamps month ends', () => {
    expect(contractLength('2026-01-01', '2026-12-31')).toEqual({ months: 12, days: 0 });
    expect(contractLength('2026-01-15', '2026-02-14')).toEqual({ months: 1, days: 0 });
    // 31 Jan + 1 month clamps to 28 Feb (exclusive), so the month ends on 27 Feb.
    expect(contractLength('2026-01-31', '2026-02-27')).toEqual({ months: 1, days: 0 });
    expect(contractLength('2026-01-30', '2026-02-26')).toEqual({ months: 0, days: 28 });
    expect(contractLength('2026-03-01', '2026-04-15')).toEqual({ months: 1, days: 15 });
    expect(contractLength('2026-05-05', '2026-05-05')).toEqual({ months: 0, days: 1 });
  });

  test('durations read naturally in English and Arabic (number agreement)', () => {
    expect(formatDuration(12, 0, 'en')).toBe('12 months');
    expect(formatDuration(1, 1, 'en')).toBe('1 month 1 day');
    expect(formatDuration(1, 0, 'ar')).toBe('شهر واحد');
    expect(formatDuration(2, 0, 'ar')).toBe('شهران');
    expect(formatDuration(6, 0, 'ar')).toBe('6 أشهر');
    expect(formatDuration(12, 15, 'ar')).toBe('12 شهرًا و15 يومًا');
  });
});

describe('merge fields', () => {
  test('fills known fields and marks missing ones instead of hiding them', () => {
    const values = mergeValues(snapshot({ startDate: '2026-01-01' }), ctx, 'en');
    const parts = fillTemplate(
      'From {{startDate}} to {{endDate}} for {{ recipientName }}; {{unknownThing}}.',
      values,
    );
    expect(parts).toEqual([
      { text: 'From ' },
      { text: '1 Jan 2026' },
      { text: ' to ' },
      { missing: 'endDate' },
      { text: ' for ' },
      { text: 'Saad' },
      { text: '; ' },
      { missing: 'unknownThing' },
      { text: '.' },
    ]);
    expect(placeholdersIn('{{a}} {{ b }}')).toEqual(['a', 'b']);
  });

  test('Arabic values use the Arabic name and Arabic month names', () => {
    const v = mergeValues(
      snapshot({
        startDate: '2026-01-01',
        compensation: { amount: '1000', currency: 'SAR', frequency: 'monthly' },
      }),
      ctx,
      'ar',
    );
    expect(v.recipientName).toBe('سعد');
    expect(v.startDate).toContain('يناير');
    expect(v.paymentFrequency).toBe('شهريًا');
    expect(v.salary).toContain('SAR');
  });

  test('every placeholder in the default templates is a known merge field', () => {
    for (const t of DEFAULT_CONTRACT_TYPES) {
      for (const c of t.clauses) {
        for (const p of [...placeholdersIn(c.bodyEn), ...placeholdersIn(c.bodyAr)])
          expect(MERGE_FIELDS as readonly string[]).toContain(p);
        // Both languages use the same placeholders.
        expect(placeholdersIn(c.bodyAr).sort()).toEqual(placeholdersIn(c.bodyEn).sort());
      }
    }
  });

  test('completeness: required values, unresolved placeholders, and text for each document language', () => {
    const clause = {
      id: '11111111-1111-4111-8111-111111111111',
      templateClauseId: null,
      source: 'custom' as const,
      required: false,
      included: true,
      titleEn: 'Pay',
      titleAr: '',
      bodyEn: 'Paid {{salary}}.',
      bodyAr: '',
    };
    const issues = completenessIssues(snapshot({}, [clause]), ctx);
    expect(issues).toContain('startDate');
    expect(issues).toContain('salary');
    expect(issues).toContain(`clause_text_ar:${clause.id}`);
    // An English-only document doesn't need the Arabic text; an excluded clause doesn't count.
    const en = completenessIssues(
      snapshot({ language: 'en', startDate: '2026-01-01' }, [
        { ...clause, bodyEn: 'Paid monthly.' },
      ]),
      ctx,
    );
    expect(en).toEqual([]);
    expect(
      completenessIssues(
        snapshot({ startDate: '2026-01-01' }, [{ ...clause, included: false }]),
        ctx,
      ),
    ).toEqual([]);
  });
});

describe('schemas', () => {
  test('rejections need a reason', () => {
    expect(rejectionSchema.safeParse({ reason: '' }).success).toBe(false);
    expect(rejectionSchema.safeParse({ reason: '   ' }).success).toBe(false);
    expect(rejectionSchema.safeParse({ reason: 'Fix the salary' }).success).toBe(true);
  });

  test('a required clause must be included; dates must be in order; ids unique', () => {
    const c = {
      id: '11111111-1111-4111-8111-111111111111',
      source: 'template',
      required: true,
      included: false,
      titleEn: 'A',
      titleAr: 'أ',
      bodyEn: 'x',
      bodyAr: 'س',
    };
    expect(contractClauseSchema.safeParse(c).success).toBe(false);
    const details = contractDetailsSchema.parse({
      recipient: { kind: 'player' },
      startDate: '2026-02-01',
      endDate: '2026-01-01',
    });
    expect(contractSaveSchema.safeParse({ details, clauses: [] }).success).toBe(false);
    const ok = { ...c, included: true };
    expect(
      contractSaveSchema.safeParse({ details: { ...details, endDate: null }, clauses: [ok, ok] })
        .success,
    ).toBe(false);
    expect(
      contractSaveSchema.safeParse({ details: { ...details, endDate: null }, clauses: [ok] })
        .success,
    ).toBe(true);
  });

  test('amounts are decimal strings and the default currency is SAR', () => {
    const d = contractDetailsSchema.parse({ recipient: { kind: 'staff' } });
    expect(d.compensation.currency).toBe('SAR');
    expect(
      contractDetailsSchema.safeParse({
        recipient: { kind: 'staff' },
        compensation: { amount: '1e5', currency: 'SAR', frequency: 'monthly' },
      }).success,
    ).toBe(false);
  });
});

describe('electronic signatures: who signs', () => {
  const adult = {
    kind: 'player' as const,
    fullNameEn: 'Saad',
    fullNameAr: 'سعد',
    email: 's@x.io',
    dateOfBirth: '2008-10-17',
  };
  test('age is counted in whole years, birthday inclusive', () => {
    expect(ageOn('2008-10-17', '2026-10-16')).toBe(17);
    expect(ageOn('2008-10-17', '2026-10-17')).toBe(18);
    expect(ageOn('2008-02-29', '2026-02-28')).toBe(17);
    expect(isMinorOn(null, '2026-10-17')).toBeNull();
  });

  test('the recipient signs; a guardian too, second, while the recipient is under 18', () => {
    const on18th = requiredSigners(snapshot({ recipient: adult }), '2026-10-17');
    expect(on18th).toEqual({
      minor: false,
      signers: [
        {
          role: 'recipient',
          order: 1,
          nameEn: 'Saad',
          nameAr: 'سعد',
          email: 's@x.io',
          phone: null,
          relationship: null,
        },
      ],
    });
    const guardian = { fullName: 'Huda', relationship: 'Mother', phone: '+966500000000' };
    const dayBefore = requiredSigners(snapshot({ recipient: adult, guardian }), '2026-10-16');
    expect('signers' in dayBefore && dayBefore.signers.map((s) => [s.role, s.order])).toEqual([
      ['recipient', 1],
      ['guardian', 2],
    ]);
  });

  test('an unknown date of birth or missing guardian details stop signing (never guessed)', () => {
    expect(
      requiredSigners(snapshot({ recipient: { ...adult, dateOfBirth: null } }), '2026-10-17'),
    ).toEqual({
      error: 'date_of_birth_required',
    });
    for (const guardian of [
      null,
      { fullName: 'Huda' },
      { fullName: 'Huda', relationship: 'Mother' },
    ]) {
      expect(requiredSigners(snapshot({ recipient: adult, guardian }), '2026-10-16')).toEqual({
        error: 'guardian_required',
      });
    }
  });

  test('submission requires the date of birth, and guardian details for a minor', () => {
    const base = { language: 'en' as const, startDate: '2026-11-01' };
    expect(
      completenessIssues(snapshot({ ...base, recipient: { ...adult, dateOfBirth: null } }), ctx),
    ).toEqual(['dateOfBirth']);
    expect(
      completenessIssues(snapshot({ ...base, recipient: adult }), ctx, '2026-10-16').sort(),
    ).toEqual(['guardianContact', 'guardianName', 'guardianRelationship']);
    expect(completenessIssues(snapshot({ ...base, recipient: adult }), ctx, '2026-10-17')).toEqual(
      [],
    );
  });

  test('masked addresses keep the domain only', () => {
    expect(maskEmail('saad@example.com')).toBe('s•••@example.com');
    expect(maskEmail('nope')).toBe('•••');
  });
});

describe('electronic signatures: the signature itself', () => {
  const base = { locale: 'en', consentVersion: CONSENT_VERSION, consent: true, confirm: true };
  test('typed signatures need a name and a font that can write it', () => {
    expect(scriptOf('سعد')).toBe('arabic');
    expect(signatureFontsFor('سعد').map((f) => f.key)).toEqual(['aref-ruqaa', 'amiri']);
    expect(signatureFontsFor('Saad').length).toBe(5);
    const ok = (v: object) => signSchema.safeParse({ ...base, ...v }).success;
    expect(ok({ method: 'typed', typedName: 'Saad Alharbi', fontKey: 'caveat' })).toBe(true);
    expect(ok({ method: 'typed', typedName: 'سعد الحربي', fontKey: 'amiri' })).toBe(true);
    expect(ok({ method: 'typed', typedName: 'سعد الحربي', fontKey: 'caveat' })).toBe(false);
    expect(ok({ method: 'typed', typedName: 'S', fontKey: 'caveat' })).toBe(false);
    expect(ok({ method: 'typed', typedName: 'Saad' })).toBe(false);
  });

  test('drawn signatures are bounded vector strokes with a minimum length', () => {
    const ok = (strokes: unknown) =>
      signSchema.safeParse({ ...base, method: 'drawn', strokes }).success;
    expect(
      ok([
        [
          [0, 0],
          [100, 50],
        ],
      ]),
    ).toBe(true);
    expect(
      ok([
        [
          [0, 0],
          [10, 5],
        ],
      ]),
    ).toBe(false); // a dot is not a signature
    expect(
      ok([
        [
          [0, 0],
          [700, 50],
        ],
      ]),
    ).toBe(false); // off the canvas
    expect(
      ok(
        Array.from({ length: 61 }, () => [
          [0, 0],
          [100, 0],
        ]),
      ),
    ).toBe(false);
    expect(ok(null)).toBe(false);
    expect(
      strokeLength([
        [
          [0, 0],
          [3, 4],
        ],
        [
          [0, 0],
          [0, 10],
        ],
      ]),
    ).toBe(15);
  });

  test('consent and confirmation are both required, on the current statement', () => {
    const v = { method: 'typed', typedName: 'Saad', fontKey: 'caveat' };
    expect(signSchema.safeParse({ ...base, ...v, consent: false }).success).toBe(false);
    expect(signSchema.safeParse({ ...base, ...v, confirm: false }).success).toBe(false);
    expect(signSchema.safeParse({ ...base, ...v, consentVersion: 'v0' }).success).toBe(false);
  });

  test('the statement names the signer, the contract and, for a guardian, the recipient', () => {
    const p = {
      signerName: 'Huda',
      recipientName: 'Saad',
      contractNumber: 'CT-1',
      organizationName: 'Falcons',
    };
    expect(consentText('guardian', 'en', p)).toContain('parent or guardian of Saad');
    expect(consentText('recipient', 'en', p)).not.toContain('guardian');
    expect(consentText('guardian', 'ar', p)).toContain('وليّ أمر Saad');
    // Neutral wording: no claim about legal effect or compliance.
    for (const l of ['en', 'ar'] as const)
      for (const r of ['recipient', 'guardian'] as const)
        expect(consentText(r, l, p)).not.toMatch(
          /legally binding|compliant|federation|ملزم قانون/i,
        );
  });
});
