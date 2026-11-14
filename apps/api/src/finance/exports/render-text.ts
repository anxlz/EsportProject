/**
 * CSV and plain-text renderings of the report document.
 *
 * CSV: one file, sections in report order — a title line, a header line, the rows, a blank line.
 * Values are machine-readable (plain decimals in the reporting currency, ISO dates); labels are
 * in the chosen language.
 * TXT: the same sections with values formatted exactly as on screen, columns padded.
 */
import { displayCell, type FinanceLocale, rawCell, type ReportDocument } from '@esports/shared';
import { csvLines } from '../../common/csv.js';

const ISOLATES = /[⁦-⁩]/g;

export function renderCsv(doc: ReportDocument): string {
  const rows: (string | null)[][] = [[doc.title], ...doc.meta.map(([k, v]) => [k, v]), []];
  for (const t of doc.tables) {
    rows.push([t.title], t.columns, ...t.rows.map((r) => r.map(rawCell)), []);
  }
  rows.push([doc.footnotesTitle], ...doc.footnotes.map((f) => [f]));
  return csvLines(rows);
}

/** Visible width: ignores bidi isolates and combining marks so columns line up. */
const width = (s: string) =>
  [...s.replace(ISOLATES, '').normalize('NFC')].filter((ch) => !/\p{M}/u.test(ch)).length;

function pad(s: string, w: number, alignEnd: boolean) {
  const gap = ' '.repeat(Math.max(0, w - width(s)));
  return alignEnd ? gap + s : s + gap;
}

export function renderTxt(doc: ReportDocument, locale: FinanceLocale): string {
  // English text needs no bidi isolates; Arabic keeps them so amounts read correctly in RTL.
  const clean = (s: string) => (locale === 'en' ? s.replace(ISOLATES, '') : s);
  const out: string[] = [doc.title, '='.repeat(width(doc.title)), ''];
  const keyW = Math.max(...doc.meta.map(([k]) => width(k)));
  for (const [k, v] of doc.meta) out.push(`${pad(k, keyW, false)}  ${clean(v)}`);
  out.push('');

  for (const t of doc.tables) {
    out.push(t.title, '-'.repeat(width(t.title)));
    if (!t.rows.length) {
      out.push('—', '');
      continue;
    }
    const cells = t.rows.map((r) => r.map((c) => clean(displayCell(c, locale))));
    const numeric = t.columns.map((_, i) => t.rows.every((r) => !r[i] || r[i]!.t !== 'text'));
    const widths = t.columns.map((h, i) =>
      Math.max(width(h), ...cells.map((r) => width(r[i] ?? ''))),
    );
    out.push(
      t.columns
        .map((h, i) => pad(h, widths[i]!, numeric[i]! && i > 0))
        .join('  ')
        .trimEnd(),
    );
    for (const r of cells)
      out.push(
        r
          .map((v, i) => pad(v, widths[i]!, numeric[i]! && i > 0))
          .join('  ')
          .trimEnd(),
      );
    out.push('');
  }

  out.push(doc.footnotesTitle, '-'.repeat(width(doc.footnotesTitle)));
  doc.footnotes.forEach((f, i) => out.push(`${i + 1}. ${f}`));
  return `${out.join('\n')}\n`;
}
