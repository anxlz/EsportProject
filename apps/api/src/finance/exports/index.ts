import {
  type ExportFormat,
  type FinanceLocale,
  type FinancialReport,
  reportDocument,
} from '@esports/shared';
import type { PdfRenderer } from './render-pdf.js';
import { renderCsv, renderTxt } from './render-text.js';
import { renderXlsx } from './render-xlsx.js';

export interface RenderedExport {
  body: Buffer;
  contentType: string;
  extension: string;
}

/** Every format renders the same report document, built from the same FinancialReport. */
export async function renderReport(
  format: ExportFormat,
  report: FinancialReport,
  locale: FinanceLocale,
  pdf: PdfRenderer,
): Promise<RenderedExport> {
  const doc = reportDocument(report, locale);
  switch (format) {
    case 'csv':
      return {
        body: Buffer.from(renderCsv(doc), 'utf8'),
        contentType: 'text/csv; charset=utf-8',
        extension: 'csv',
      };
    case 'txt':
      return {
        body: Buffer.from(renderTxt(doc, locale), 'utf8'),
        contentType: 'text/plain; charset=utf-8',
        extension: 'txt',
      };
    case 'xlsx':
      return {
        body: await renderXlsx(doc, locale),
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        extension: 'xlsx',
      };
    case 'pdf':
      return {
        body: await pdf.render(doc, locale),
        contentType: 'application/pdf',
        extension: 'pdf',
      };
  }
}
