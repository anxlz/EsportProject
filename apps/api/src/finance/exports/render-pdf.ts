/**
 * PDF rendering: the report document laid out as HTML and printed by headless Chromium, with
 * IBM Plex Sans / Plex Sans Arabic embedded so Arabic shapes correctly and both languages print
 * identically on any server. One browser is started lazily and shared; each export gets its own
 * page, which is closed afterwards.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { displayCell, type FinanceLocale, type ReportDocument } from '@esports/shared';
import type { Browser } from 'puppeteer-core';
import { ENV, type Env } from '../../config/env';

const require = createRequire(import.meta.url);

function fontFace(pkg: string, file: string, family: string, weight: number, range?: string) {
  const dir = dirname(require.resolve(`${pkg}/LICENSE`));
  const data = readFileSync(join(dir, 'files', file)).toString('base64');
  return `@font-face{font-family:'${family}';font-weight:${weight};font-style:normal;font-display:block;src:url(data:font/woff2;base64,${data}) format('woff2');${range ? `unicode-range:${range};` : ''}}`;
}

const ARABIC_RANGE =
  'U+0600-06FF,U+0750-077F,U+0870-088E,U+0890-0891,U+0897-08E1,U+08E3-08FF,U+200C-200E,U+2010-2011,U+204F,U+2E41,U+FB50-FDFF,U+FE70-FE74,U+FE76-FEFC';

let fontCss: string | null = null;
function fonts(): string {
  fontCss ??= [
    fontFace('@fontsource/ibm-plex-sans', 'ibm-plex-sans-latin-400-normal.woff2', 'Plex', 400),
    fontFace('@fontsource/ibm-plex-sans', 'ibm-plex-sans-latin-600-normal.woff2', 'Plex', 600),
    fontFace(
      '@fontsource/ibm-plex-sans',
      'ibm-plex-sans-latin-ext-400-normal.woff2',
      'Plex',
      400,
      'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1E00-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF',
    ),
    fontFace(
      '@fontsource/ibm-plex-sans-arabic',
      'ibm-plex-sans-arabic-arabic-400-normal.woff2',
      'Plex',
      400,
      ARABIC_RANGE,
    ),
    fontFace(
      '@fontsource/ibm-plex-sans-arabic',
      'ibm-plex-sans-arabic-arabic-600-normal.woff2',
      'Plex',
      600,
      ARABIC_RANGE,
    ),
  ].join('');
  return fontCss;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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
export class PdfRenderer implements OnModuleDestroy {
  private readonly log = new Logger(PdfRenderer.name);
  private browser: Promise<Browser> | null = null;

  constructor(@Inject(ENV) private readonly env: Env) {}

  private async launch(): Promise<Browser> {
    const [{ default: puppeteer }, { default: chromium }] = await Promise.all([
      import('puppeteer-core'),
      import('@sparticuz/chromium'),
    ]);
    const executablePath = this.env.CHROMIUM_EXECUTABLE_PATH ?? (await chromium.executablePath());
    // --single-process makes new browser contexts crash; everything else is the package default.
    const args = chromium.args.filter((a) => a !== '--single-process');
    const browser = await puppeteer.launch({ executablePath, args, headless: true });
    browser.on('disconnected', () => {
      this.browser = null;
    });
    return browser;
  }

  private getBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = this.launch().catch((err: unknown) => {
        this.browser = null;
        throw err;
      });
    }
    return this.browser;
  }

  async render(doc: ReportDocument, locale: FinanceLocale): Promise<Buffer> {
    const browser = await this.getBrowser();
    const page = await browser.newPage();
    try {
      // Nothing outside the document is needed; block any request so a report can't reach out.
      await page.setRequestInterception(true);
      page.on('request', (req) => (req.url().startsWith('data:') ? req.continue() : req.abort()));
      await page.setContent(reportHtml(doc, locale), { waitUntil: 'load', timeout: 30_000 });
      await page.evaluate('document.fonts.ready.then(() => true)');
      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' },
        displayHeaderFooter: true,
        headerTemplate: '<span></span>',
        footerTemplate:
          '<div style="width:100%;font-size:7pt;color:#5b606b;text-align:center;font-family:sans-serif"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
        timeout: 30_000,
      });
      return Buffer.from(pdf);
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  async onModuleDestroy() {
    const b = this.browser;
    this.browser = null;
    if (b)
      await (
        await b.catch(() => null)
      )
        ?.close()
        .catch((e: unknown) => this.log.warn(`Closing browser failed: ${String(e)}`));
  }
}
