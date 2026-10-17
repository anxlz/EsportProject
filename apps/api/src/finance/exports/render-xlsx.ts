/**
 * XLSX rendering: an overview sheet (title, report details, notes) followed by one sheet per
 * table. Amounts are real numbers with a currency number format, percentages are real
 * percentages and dates are real dates, so the workbook can be summed and filtered.
 * Arabic workbooks are laid out right-to-left.
 */
import {
  currencyInfo,
  displayCell,
  type FinanceLocale,
  type ReportCell,
  type ReportDocument,
} from '@esports/shared';
import ExcelJS from 'exceljs';

const ISOLATES = /[⁦-⁩]/g;
const INVALID_SHEET_CHARS = /[\\/?*[\]:]/g;

function sheetName(title: string, used: Set<string>): string {
  const base =
    title.replace(INVALID_SHEET_CHARS, ' ').replace(ISOLATES, '').trim().slice(0, 28) || 'Sheet';
  let name = base;
  for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base.slice(0, 26)} ${i}`;
  used.add(name.toLowerCase());
  return name;
}

const moneyFormat = (currency: string, withCode: boolean) => {
  const digits = currencyInfo(currency).minorUnits;
  const number = digits ? `#,##0.${'0'.repeat(digits)}` : '#,##0';
  return withCode ? `"${currency} "${number};"${currency} "-${number}` : number;
};

const isoToDate = (iso: string) => new Date(`${iso}T00:00:00Z`);

function writeCell(cell: ExcelJS.Cell, value: ReportCell, locale: FinanceLocale) {
  if (!value) return;
  switch (value.t) {
    case 'money':
      cell.value = Number(value.v);
      cell.numFmt = moneyFormat(value.c, true);
      break;
    case 'amount': {
      cell.value = Number(value.v);
      // As entered: the currency's minor units, or more decimals when the amount has them.
      const decimals = value.v.includes('.')
        ? (value.v.replace(/0+$/, '').split('.')[1] ?? '').length
        : 0;
      const digits = Math.max(currencyInfo(value.c).minorUnits, decimals);
      cell.numFmt = digits ? `#,##0.${'0'.repeat(digits)}` : '#,##0';
      break;
    }
    case 'percent':
      cell.value = Number(value.v) / 100;
      cell.numFmt = '0.0%';
      break;
    case 'int':
      cell.value = value.v;
      cell.numFmt = '0';
      break;
    case 'rate':
      cell.value = Number(value.v);
      cell.numFmt = '0.############';
      break;
    case 'date':
      cell.value = isoToDate(value.v);
      cell.numFmt = 'yyyy-mm-dd';
      break;
    case 'month':
      cell.value = displayCell(value, locale);
      break;
    case 'text':
      cell.value = value.v;
      break;
  }
}

export async function renderXlsx(doc: ReportDocument, locale: FinanceLocale): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Esports Platform';
  wb.created = new Date(0); // deterministic output; the report's own "as of" date is in the sheet
  const views = [{ rightToLeft: locale === 'ar', state: 'frozen' as const, ySplit: 1 }];
  const used = new Set<string>();

  const overview = wb.addWorksheet(sheetName(doc.title, used), {
    views: [{ rightToLeft: locale === 'ar' }],
  });
  overview.addRow([doc.title]).font = { bold: true, size: 14 };
  overview.addRow([]);
  for (const [k, v] of doc.meta)
    overview.addRow([k, v.replace(ISOLATES, '')]).getCell(1).font = { bold: true };
  overview.addRow([]);
  overview.addRow([doc.footnotesTitle]).font = { bold: true };
  for (const f of doc.footnotes) {
    const row = overview.addRow([f]);
    row.getCell(1).alignment = { wrapText: true, vertical: 'top' };
  }
  overview.getColumn(1).width = 40;
  overview.getColumn(2).width = 60;

  for (const t of doc.tables) {
    const ws = wb.addWorksheet(sheetName(t.title, used), { views });
    const header = ws.addRow(t.columns);
    header.font = { bold: true };
    header.eachCell((c) => {
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFF2' } };
      c.alignment = { wrapText: true, vertical: 'middle' };
    });
    for (const r of t.rows) {
      const row = ws.addRow([]);
      r.forEach((v, i) => writeCell(row.getCell(i + 1), v, locale));
    }
    t.columns.forEach((h, i) => {
      const longest = Math.max(
        h.length,
        ...t.rows.map((r) => displayCell(r[i] ?? null, locale).replace(ISOLATES, '').length),
      );
      ws.getColumn(i + 1).width = Math.min(60, Math.max(10, longest + 2));
    });
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}
