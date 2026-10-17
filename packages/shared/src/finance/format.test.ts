import { describe, expect, test } from 'bun:test';
import { currencyMark, formatMoney, RIYAL_SIGN } from './format';
import { displayCell } from './tables';

const strip = (s: string) => s.replace(/[⁦-⁩]/g, '');

describe('money formatting and the Saudi riyal sign', () => {
  test('the sign is U+20C1, used only for SAR and only when asked for', () => {
    expect(RIYAL_SIGN.codePointAt(0)).toBe(0x20c1);
    expect(currencyMark('SAR', { riyalSign: true })).toBe('⃁');
    expect(currencyMark('SAR')).toBe('SAR');
    expect(currencyMark('USD', { riyalSign: true })).toBe('USD');
  });

  test('sign to the left of the number with a space, in English and Arabic', () => {
    expect(strip(formatMoney('1250', 'SAR', 'en', { riyalSign: true }))).toBe('⃁ 1,250.00');
    expect(strip(formatMoney('1250', 'SAR', 'ar', { riyalSign: true }))).toBe('⃁ 1,250.00');
    // Isolated left-to-right, so it stays left of the digits inside Arabic sentences.
    expect(formatMoney('1250', 'SAR', 'ar', { riyalSign: true }).startsWith('⁦⃁ ')).toBe(true);
    expect(strip(formatMoney('1250', 'SAR', 'en'))).toBe('SAR 1,250.00');
    expect(strip(formatMoney('-5.5', 'USD', 'en', { riyalSign: true }))).toBe('USD -5.50');
  });

  test('report cells follow the same option', () => {
    const cell = { t: 'money' as const, v: '99.5', c: 'SAR' };
    expect(strip(displayCell(cell, 'en'))).toBe('SAR 99.50');
    expect(strip(displayCell(cell, 'en', { riyalSign: true }))).toBe('⃁ 99.50');
  });
});
