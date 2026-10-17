/**
 * PDF rendering of the financial report: the report document laid out as HTML and printed by the
 * shared PdfService (headless Chromium, IBM Plex embedded).
 */
import { Injectable } from '@nestjs/common';
import { displayCell, type FinanceLocale, type ReportDocument } from '@esports/shared';
import { escapeHtml as esc, PdfService, pdfFonts as fonts } from '../../pdf/pdf.service';

export function reportHtml(doc: ReportDocument, locale: FinanceLocale): string {
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  const tables = doc.tables
    .map((t) => {
      const numeric = t.columns.map(
        (_, i) => t.rows.length > 0 && t.rows.every((r) => !r[i] || r[i]!.t !== 'text'),
      );
      const head = t.columns
        .map((h, i) => `<th class="${numeric[i] && i > 0 ? 'num' : ''}">${esc(h)}</th>`)
        .join('');
      const body = t.rows.length
        ? t.rows
            .map(
              (r) =>
                `<tr>${r
                  .map((c, i) => {
                    const cls = [
                      numeric[i] && i > 0 ? 'num' : '',
                      c && c.t !== 'text' ? 'nowrap' : '',
                    ]
                      .filter(Boolean)
                      .join(' ');
                    return `<td class="${cls}">${esc(displayCell(c, locale))}</td>`;
                  })
                  .join('')}</tr>`,
            )
            .join('')
        : `<tr><td colspan="${t.columns.length}" class="empty">—</td></tr>`;
      return `<section><h2>${esc(t.title)}</h2><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></section>`;
    })
    .join('');
  const meta = doc.meta.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  const notes = doc.footnotes.map((f) => `<li>${esc(f)}</li>`).join('');
  return `<!doctype html><html lang="${locale}" dir="${dir}"><head><meta charset="utf-8"><title>${esc(doc.title)}</title><style>
${fonts()}
*{box-sizing:border-box}
html{font-family:'Plex',sans-serif;font-size:9pt;color:#1b1d22;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0}
h1{font-size:16pt;font-weight:600;margin:0 0 8pt}
h2{font-size:11pt;font-weight:600;margin:14pt 0 5pt;break-after:avoid}
dl{display:grid;grid-template-columns:max-content 1fr;gap:2pt 12pt;margin:0 0 6pt}
dt{color:#5b606b}dd{margin:0}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th{font-weight:600;text-align:start;background:#f0f1f4;border-bottom:1px solid #c9ccd3;padding:4pt 5pt;vertical-align:bottom}
td{padding:3pt 5pt;border-bottom:1px solid #e4e6ea;vertical-align:top}
.num{text-align:end;white-space:nowrap}
.nowrap{white-space:nowrap}
.empty{color:#5b606b}
tr{break-inside:avoid}
thead{display:table-header-group}
section.notes ol{padding-inline-start:14pt;margin:0}
section.notes li{margin-bottom:3pt;color:#3a3e46}
</style></head><body>
<h1>${esc(doc.title)}</h1><dl>${meta}</dl>${tables}
<section class="notes"><h2>${esc(doc.footnotesTitle)}</h2><ol>${notes}</ol></section>
</body></html>`;
}

@Injectable()
export class PdfRenderer {
  constructor(private readonly pdf: PdfService) {}

  render(doc: ReportDocument, locale: FinanceLocale): Promise<Buffer> {
    return this.pdf.render(reportHtml(doc, locale), {
      margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' },
      footerTemplate:
        '<div style="width:100%;font-size:7pt;color:#5b606b;text-align:center;font-family:sans-serif"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    });
  }
}
