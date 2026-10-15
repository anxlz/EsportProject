/**
 * RFC 4180 CSV with spreadsheet formula-injection protection: a cell beginning with = + - @
 * (or tab/CR) is prefixed with an apostrophe so Excel/Sheets treat it as text, not a formula.
 * A UTF-8 BOM is prepended so Excel opens Arabic text correctly.
 */
export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined): string => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header, ...rows].map((r) => r.map(cell).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}
