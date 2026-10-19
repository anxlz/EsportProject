/**
 * The signature record appended to the approved PDF when the last required signature is in
 * (spec §7.7): who signed, in what role, how they were checked, when, from where, the exact
 * statement they agreed to, and the fingerprint of the approved document they signed.
 *
 * Typed signatures are drawn in blue in the font the signer chose (bundled OFL fonts, inlined);
 * drawn signatures are the signer's own strokes, re-drawn as an SVG path in the same blue.
 * All user content is HTML-escaped. Wording is factual and makes no claim of legal effect.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  cl,
  type ContractLocale,
  DRAW_CANVAS,
  documentLocales,
  type DocumentLanguage,
  SIGNATURE_FONTS,
  SIGNATURE_INK,
  type SignatureFontKey,
  type SignatureMethod,
  type SignerRole,
  type VerificationMethod,
} from '@esports/shared';
import { escapeHtml as esc, pdfFonts } from '../pdf/pdf.service';

const require = createRequire(import.meta.url);

/** Subset files per signature font (fontsource names). */
const FONT_FILES: Record<SignatureFontKey, string[]> = {
  'dancing-script': ['latin', 'latin-ext'],
  'great-vibes': ['latin', 'latin-ext'],
  caveat: ['latin', 'latin-ext'],
  'aref-ruqaa': ['arabic', 'latin'],
  amiri: ['arabic', 'latin'],
};
const RANGES: Record<string, string> = {
  latin:
    'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
  'latin-ext':
    'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF',
  arabic:
    'U+0600-06FF,U+0750-077F,U+0870-088E,U+0890-0891,U+0897-08E1,U+08E3-08FF,U+200C-200E,U+2010-2011,U+204F,U+2E41,U+FB50-FDFF,U+FE70-FE74,U+FE76-FEFC',
};

export const signatureFamily = (key: SignatureFontKey) => `Sig ${key}`;

let sigCss: string | null = null;
/** @font-face rules for every signature font, as data: URIs (family "Sig <key>"). */
export function signatureFontCss(): string {
  sigCss ??= SIGNATURE_FONTS.flatMap((f) => {
    const dir = dirname(require.resolve(`@fontsource/${f.key}/LICENSE`));
    return FONT_FILES[f.key].map((subset) => {
      const data = readFileSync(join(dir, 'files', `${f.key}-${subset}-400-normal.woff2`));
      return `@font-face{font-family:'${signatureFamily(f.key)}';font-weight:400;font-style:normal;font-display:block;src:url(data:font/woff2;base64,${data.toString('base64')}) format('woff2');unicode-range:${RANGES[subset]};}`;
    });
  }).join('');
  return sigCss;
}

/** A drawn signature as SVG (the stored strokes on the fixed canvas). */
export function strokesSvg(strokes: [number, number][][], heightMm = 22): string {
  const r = (n: number) => Math.round(n * 10) / 10;
  const paths = strokes
    .map((st) =>
      st.length === 1
        ? `<circle cx="${r(st[0]![0])}" cy="${r(st[0]![1])}" r="2" fill="${SIGNATURE_INK}"/>`
        : `<path d="M${st.map(([x, y]) => `${r(x)} ${r(y)}`).join('L')}"/>`,
    )
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${DRAW_CANVAS.width} ${DRAW_CANVAS.height}" style="height:${heightMm}mm;width:auto;max-width:100%" fill="none" stroke="${SIGNATURE_INK}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

export function typedSignatureHtml(name: string, fontKey: SignatureFontKey): string {
  return `<span class="typed" dir="auto" style="font-family:'${signatureFamily(fontKey)}';color:${SIGNATURE_INK}">${esc(name)}</span>`;
}

export interface CertificateSigner {
  role: SignerRole;
  nameEn: string | null;
  nameAr: string | null;
  relationship: string | null;
  signatureMethod: SignatureMethod;
  typedName: string | null;
  fontKey: SignatureFontKey | null;
  strokes: [number, number][][] | null;
  signedAt: Date;
  verificationMethod: VerificationMethod;
  verificationDestination: string | null;
  verifiedAt: Date;
  ip: string | null;
  userAgent: string | null;
  consentText: string;
  consentLocale: ContractLocale;
  recordSha256: string;
}

export interface CertificateInput {
  /** The organization's legal name per language (falls back to its display name). */
  organizationName: { en: string; ar: string };
  contractNumber: string;
  contractTitle: { en: string; ar: string };
  language: DocumentLanguage;
  recipientName: { en: string | null; ar: string | null };
  approvedVersion: number;
  approverName: string;
  approvedDocumentSha256: string;
  completedAt: Date;
  signers: CertificateSigner[];
}

const utc = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 19);

export function certificateHtml(input: CertificateInput): string {
  const locales = documentLocales(input.language);
  const bilingual = locales.length === 2;
  const main: ContractLocale = bilingual ? 'en' : locales[0]!;
  const dir = !bilingual && main === 'ar' ? 'rtl' : 'ltr';
  const C = (l: ContractLocale) => cl(l).certificate;
  const ar = (html: string) => `<span lang="ar" dir="rtl">${html}</span>`;
  const nameIn = (en: string | null, ar: string | null, l: ContractLocale) =>
    esc((l === 'ar' ? ar || en : en || ar) ?? '');
  const ltr = (s: string) => `<span dir="ltr" class="mono">${esc(s)}</span>`;
  const hash = (s: string) => `<span dir="ltr" class="mono hash">${esc(s)}</span>`;

  /**
   * Rows like the contract's particulars: bilingual documents use four columns (English label,
   * English value, Arabic value, Arabic label); a value that reads the same in both languages
   * (a date, a hash, the stored statement) spans the two middle columns.
   */
  type Label = (l: ContractLocale) => string;
  const same = (label: Label, html: string) =>
    bilingual
      ? `<tr><th>${esc(label('en'))}</th><td colspan="2">${html}</td><th class="ar">${ar(esc(label('ar')))}</th></tr>`
      : `<tr><th>${esc(label(main))}</th><td>${html}</td></tr>`;
  const each = (label: Label, value: (l: ContractLocale) => string) =>
    bilingual
      ? `<tr><th>${esc(label('en'))}</th><td>${value('en')}</td><td class="ar">${ar(value('ar'))}</td><th class="ar">${ar(esc(label('ar')))}</th></tr>`
      : `<tr><th>${esc(label(main))}</th><td>${value(main)}</td></tr>`;
  const table = (rows: string[]) =>
    `<table class="${bilingual ? 'bi' : 'mono-lang'}"><tbody>${rows.join('')}</tbody></table>`;
  const heading = (f: Label, tag: 'h1' | 'p', cls = '') =>
    bilingual
      ? `<div class="bi-head ${cls}"><${tag}>${esc(f('en'))}</${tag}><${tag} lang="ar" dir="rtl">${esc(f('ar'))}</${tag}></div>`
      : `<${tag} class="${cls}">${esc(f(main))}</${tag}>`;

  const signerBlock = (s: CertificateSigner, i: number) => {
    const sig =
      s.signatureMethod === 'drawn' && s.strokes
        ? strokesSvg(s.strokes)
        : typedSignatureHtml(s.typedName ?? '', s.fontKey ?? 'dancing-script');
    const names = bilingual
      ? [...new Set([s.nameEn, s.nameAr].filter(Boolean))].map((n) => esc(n!)).join(' · ')
      : nameIn(s.nameEn, s.nameAr, main);
    const rows = [
      each(
        (l) => C(l).role,
        (l) =>
          s.role === 'guardian'
            ? `${esc(cl(l).signerRole.guardian)}${s.relationship ? ` (${esc(s.relationship)})` : ''}${l === 'ar' ? '، ' : ', '}${esc(C(l).onBehalfOf)} ${nameIn(input.recipientName.en, input.recipientName.ar, l)}`
            : esc(cl(l).signerRole.recipient),
      ),
      each(
        (l) => C(l).method,
        (l) => esc(cl(l).signatureMethod[s.signatureMethod]),
      ),
      same((l) => C(l).signedAt, ltr(utc(s.signedAt))),
      each(
        (l) => C(l).verification,
        (l) =>
          esc(
            s.verificationMethod === 'email_code' ? cl(l).verification.email_code : C(l).accessCode,
          ),
      ),
      ...(s.verificationDestination
        ? [same((l) => C(l).contact, ltr(s.verificationDestination))]
        : []),
      same((l) => C(l).verifiedAt, ltr(utc(s.verifiedAt))),
      same((l) => C(l).ipAddress, s.ip ? ltr(s.ip) : '—'),
      same(
        (l) => C(l).device,
        s.userAgent ? `<span dir="ltr" class="ua">${esc(s.userAgent)}</span>` : '—',
      ),
      same(
        (l) => C(l).consent,
        `<div lang="${s.consentLocale}" dir="${s.consentLocale === 'ar' ? 'rtl' : 'ltr'}" class="consent">${esc(s.consentText)}</div>`,
      ),
      same((l) => C(l).recordHash, hash(s.recordSha256)),
    ];
    return `<section class="signer"><h2><span class="n">${i + 1}</span> ${names}</h2>
<div class="sigbox">${sig}</div>${table(rows)}</section>`;
  };

  const summary = [
    same((l) => C(l).contract, ltr(input.contractNumber)),
    each(
      (l) => cl(l).doc.type,
      (l) => esc(input.contractTitle[l]),
    ),
    each(
      (l) => cl(l).doc.organization,
      (l) => esc(input.organizationName[l]),
    ),
    same((l) => C(l).approvedVersion, ltr(String(input.approvedVersion))),
    same((l) => C(l).approvedBy, esc(input.approverName)),
    same((l) => C(l).approvedDocument, hash(input.approvedDocumentSha256)),
    same((l) => C(l).completedAt, ltr(utc(input.completedAt))),
  ];

  return `<!doctype html><html lang="${main}" dir="${dir}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:">
<style>${pdfFonts()}${signatureFontCss()}
*{box-sizing:border-box}
body{margin:0;font-family:'Plex',sans-serif;font-size:8.6pt;line-height:1.4;color:#1c1f24}
h1{font-size:14pt;margin:0 0 1.5mm;font-weight:600}
.bi-head{display:flex;justify-content:space-between;gap:8mm}
.bi-head>*{margin-top:0}
.lead{color:#5b6068;margin:0 0 4mm}
.bi-head.lead p{margin:0 0 4mm;color:#5b6068}
table{width:100%;border-collapse:collapse;table-layout:fixed}
th{text-align:start;vertical-align:top;font-weight:600;color:#3b4048;padding:1.1mm 2.5mm 1.1mm 0}
td{vertical-align:top;padding:1.1mm 2mm 1.1mm 0;overflow-wrap:anywhere}
table.mono-lang th{width:32%}
table.bi th{width:19%}
table.bi td{width:31%}
table.bi .ar{text-align:right;padding:1.1mm 0 1.1mm 2mm}
[dir=rtl] th{padding:1.1mm 0 1.1mm 2.5mm}
tr+tr th,tr+tr td{border-top:0.2mm solid #e3e5e8}
.mono{font-variant-numeric:tabular-nums;letter-spacing:.01em}
.ua{font-size:7.2pt;color:#5b6068}
.hash{font-size:6.9pt;word-break:break-all}
.summary{border:0.3mm solid #c9cdd2;border-radius:2mm;padding:1.5mm 4mm;margin-bottom:5mm}
.signer{break-inside:avoid;border:0.3mm solid #c9cdd2;border-radius:2mm;padding:3mm 4mm 2mm;margin-bottom:4mm}
.signer h2{font-size:10.5pt;margin:0 0 1mm;font-weight:600}
.signer h2 .n{display:inline-block;min-width:5.2mm;height:5.2mm;border-radius:50%;background:#1c1f24;color:#fff;text-align:center;font-size:7.5pt;line-height:5.2mm;margin-inline-end:2mm}
.sigbox{border-bottom:0.3mm solid #9aa0a8;min-height:18mm;display:flex;align-items:flex-end;padding:1mm 2mm 1.5mm;margin:0 0 2mm;max-width:105mm}
.typed{font-size:24pt;line-height:1.2}
.note{color:#5b6068;font-size:7.6pt;margin-top:3mm}
</style></head><body>
${heading((l) => C(l).title, 'h1')}
${heading((l) => C(l).lead, 'p', 'lead')}
<div class="summary">${table(summary)}</div>
${input.signers.map(signerBlock).join('\n')}
${heading((l) => C(l).note, 'p', 'note')}
</body></html>`;
}

/** Footer for the record pages: contract number and page x / y (Chromium template; Latin only). */
export const certificateFooter = (number: string) =>
  `<div style="width:100%;font-size:7pt;color:#6b7078;text-align:center;font-family:sans-serif">${esc(number)} · <span class="pageNumber"></span> / <span class="totalPages"></span></div>`;
