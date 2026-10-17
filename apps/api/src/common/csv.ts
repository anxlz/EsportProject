/**
 * RFC 4180 CSV with spreadsheet formula-injection protection: a cell beginning with = + - @
 * (or tab/CR) is prefixed with an apostrophe so Excel/Sheets treat it as text, not a formula.
 * Plain numbers (including negatives such as "-500.00") are left as numbers.
 * A UTF-8 BOM is prepended so Excel opens Arabic text correctly.
 */
type CsvValue = string | number | null | undefined;

const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

export function csvCell(v: CsvValue): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows of cells → CSV text (BOM + CRLF). */
export function csvLines(rows: CsvValue[][]): string {
  return `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export function toCsv(header: string[], rows: CsvValue[][]): string {
  return csvLines([header, ...rows]);
}
