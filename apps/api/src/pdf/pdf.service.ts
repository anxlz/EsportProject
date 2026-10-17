/**
 * One PDF engine for the whole platform: HTML printed by headless Chromium with IBM Plex Sans /
 * Plex Sans Arabic embedded (so Arabic shapes correctly and output is identical on any server),
 * plus a one-glyph font for the Saudi riyal sign U+20C1, which IBM Plex doesn't cover yet,
 * plus an optional full-page underlay (a PNG/JPEG image or the first page of a PDF) composited
 * beneath every page with pdf-lib. Used by finance reports (Phase 2) and contracts (Phase 3).
 *
 * One browser is started lazily and shared; each render gets its own page, closed afterwards.
 * Pages cannot make network requests: everything they need is inlined as data: URIs.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { Browser } from 'puppeteer-core';
import { ENV, type Env } from '../config/env';

const require = createRequire(import.meta.url);

function fontFace(pkg: string, file: string, family: string, weight: number, range?: string) {
  const dir = dirname(require.resolve(`${pkg}/LICENSE`));
  const data = readFileSync(join(dir, 'files', file)).toString('base64');
  return `@font-face{font-family:'${family}';font-weight:${weight};font-style:normal;font-display:block;src:url(data:font/woff2;base64,${data}) format('woff2');${range ? `unicode-range:${range};` : ''}}`;
}

/** The bundled riyal-sign font (OFL, see assets/fonts/saudi-riyal/README.md), U+20C1 only. */
export const RIYAL_FONT_FILES = {
  400: new URL('../../assets/fonts/saudi-riyal/saudi-riyal-regular.woff2', import.meta.url),
  600: new URL('../../assets/fonts/saudi-riyal/saudi-riyal-bold.woff2', import.meta.url),
} as const;

function riyalFace(weight: 400 | 600) {
  const data = readFileSync(RIYAL_FONT_FILES[weight]).toString('base64');
  return `@font-face{font-family:'Plex';font-weight:${weight};font-style:normal;font-display:block;src:url(data:font/woff2;base64,${data}) format('woff2');unicode-range:U+20C1;}`;
}

const ARABIC_RANGE =
  'U+0600-06FF,U+0750-077F,U+0870-088E,U+0890-0891,U+0897-08E1,U+08E3-08FF,U+200C-200E,U+2010-2011,U+204F,U+2E41,U+FB50-FDFF,U+FE70-FE74,U+FE76-FEFC';
const LATIN_EXT_RANGE =
  'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1E00-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';

let fontCss: string | null = null;
/** @font-face rules for family 'Plex' (Latin + Arabic + the riyal sign, 400 and 600), inlined. */
export function pdfFonts(): string {
  fontCss ??= [
    fontFace('@fontsource/ibm-plex-sans', 'ibm-plex-sans-latin-400-normal.woff2', 'Plex', 400),
    fontFace('@fontsource/ibm-plex-sans', 'ibm-plex-sans-latin-600-normal.woff2', 'Plex', 600),
    fontFace(
      '@fontsource/ibm-plex-sans',
      'ibm-plex-sans-latin-ext-400-normal.woff2',
      'Plex',
      400,
      LATIN_EXT_RANGE,
    ),
    fontFace(
      '@fontsource/ibm-plex-sans',
      'ibm-plex-sans-latin-ext-600-normal.woff2',
      'Plex',
      600,
      LATIN_EXT_RANGE,
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
    riyalFace(400),
    riyalFace(600),
  ].join('');
  return fontCss;
}

export const escapeHtml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export interface PdfOptions {
  /** CSS lengths, e.g. "20mm". */
  margin: { top: string; bottom: string; left: string; right: string };
  /** Small footer line printed by Chromium on every page (page numbers). Digits/Latin only. */
  footerTemplate?: string;
  underlay?: { data: Buffer; contentType: string } | null;
}

const A4 = { width: 595.28, height: 841.89 }; // points

@Injectable()
export class PdfService implements OnModuleDestroy {
  private readonly log = new Logger(PdfService.name);
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

  async render(html: string, opts: PdfOptions): Promise<Buffer> {
    const browser = await this.getBrowser();
    const page = await browser.newPage();
    let pdf: Uint8Array;
    try {
      await page.setRequestInterception(true);
      page.on('request', (req) => (req.url().startsWith('data:') ? req.continue() : req.abort()));
      await page.setContent(html, { waitUntil: 'load', timeout: 30_000 });
      await page.evaluate('document.fonts.ready.then(() => true)');
      pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: opts.margin,
        displayHeaderFooter: !!opts.footerTemplate,
        headerTemplate: '<span></span>',
        footerTemplate: opts.footerTemplate ?? '<span></span>',
        timeout: 30_000,
      });
    } finally {
      await page.close().catch(() => undefined);
    }
    return opts.underlay ? this.withUnderlay(Buffer.from(pdf), opts.underlay) : Buffer.from(pdf);
  }

  /** Draws the background (image, or a PDF's first page) full-bleed beneath every page. */
  private async withUnderlay(content: Buffer, underlay: { data: Buffer; contentType: string }) {
    const { PDFDocument } = await import('pdf-lib');
    const out = await PDFDocument.create();
    const src = await PDFDocument.load(content);
    const pages = await out.embedPdf(src, src.getPageIndices());
    let draw: (p: ReturnType<typeof out.addPage>) => void;
    if (underlay.contentType === 'application/pdf') {
      const bgDoc = await PDFDocument.load(underlay.data, { ignoreEncryption: false });
      const [bg] = await out.embedPdf(bgDoc, [0]);
      draw = (p) => p.drawPage(bg!, { x: 0, y: 0, width: A4.width, height: A4.height });
    } else {
      const img =
        underlay.contentType === 'image/png'
          ? await out.embedPng(underlay.data)
          : await out.embedJpg(underlay.data);
      draw = (p) => p.drawImage(img, { x: 0, y: 0, width: A4.width, height: A4.height });
    }
    for (const content of pages) {
      const p = out.addPage([A4.width, A4.height]);
      draw(p);
      p.drawPage(content, { x: 0, y: 0, width: A4.width, height: A4.height });
    }
    return Buffer.from(await out.save());
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
