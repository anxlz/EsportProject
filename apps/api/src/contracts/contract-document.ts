/**
 * The contract document: one HTML layout for the on-screen preview, draft PDFs and the stamped
 * approved PDF, so what the approver reviews is exactly what gets stamped.
 *
 * Layout (A4): letterhead (logo, legal name, header text) and footer repeat on every page via a
 * table header/footer group; the page border and the draft watermark use fixed positioning,
 * which Chromium repeats per page; a background image/PDF is composited beneath by PdfService.
 * Bilingual documents put English and Arabic side by side; Arabic text is right-to-left.
 * All user content is HTML-escaped.
 */
import {
  type ContractLocale,
  type ContractSnapshot,
  cl,
  contractLength,
  documentLocales,
  type DocumentSettingsDto,
  fillTemplate,
  formatDuration,
  formatIsoDate,
  formatMoney,
  type MergeContext,
  mergeValues,
} from '@esports/shared';
import { escapeHtml as esc, pdfFonts } from '../pdf/pdf.service';

export interface DocumentAssets {
  logo: { data: Buffer; contentType: string } | null;
  stamp: { data: Buffer; contentType: string } | null;
}

export interface ApprovalInfo {
  approverName: string;
  approvedAt: Date;
  version: number;
  sha256: string;
}

export interface RenderInput {
  snapshot: ContractSnapshot;
  contractNumber: string;
  settings: DocumentSettingsDto;
  assets: DocumentAssets;
  /** null → draft (watermarked, no stamp). */
  approval: ApprovalInfo | null;
  /**
   * "print" (default) for Chromium's PDF printer; "screen" for the in-app preview: an A4-wide
   * sheet with the margins as padding and an image background tiled per page height. Page breaks
   * and PDF backgrounds only exist in the PDF.
   */
  mode?: 'print' | 'screen';
  background?: { data: Buffer; contentType: string } | null;
}

const dataUri = (f: { data: Buffer; contentType: string }) => `data:${f.contentType};base64,${f.data.toString('base64')}`;
const nl = (s: string) => esc(s).replace(/\n/g, '<br>');

function mergeCtx(input: RenderInput): MergeContext {
  return {
    organizationName: input.settings.organizationName,
    legalNameEn: input.settings.legalNameEn,
    legalNameAr: input.settings.legalNameAr,
    contractNumber: input.contractNumber,
  };
}

/** Clause text with merge fields filled; missing values are highlighted, never hidden. */
function clauseBody(body: string, input: RenderInput, loc: ContractLocale): string {
  const values = mergeValues(input.snapshot, mergeCtx(input), loc);
  const L = cl(loc);
  return fillTemplate(body, values)
    .map((p) =>
      'text' in p
        ? nl(p.text)
        : `<mark class="missing">[${esc(L.doc.missing)}: ${esc((L.field as Record<string, string>)[p.missing] ?? p.missing)}]</mark>`,
    )
    .join('');
}

function particularRows(input: RenderInput, loc: ContractLocale): [string, string][] {
  const L = cl(loc).doc;
  const s = input.settings;
  const d = input.snapshot.details;
  const r = d.recipient;
  const pick = (en: string | null | undefined, ar: string | null | undefined) => (loc === 'ar' ? ar || en : en || ar) || '';
  const money = (amount: string | null | undefined, currency: string | null | undefined) =>
    amount && currency ? formatMoney(amount, currency, loc) : '';
  const rows: [string, string][] = [
    [L.contractNumber, input.contractNumber],
    [L.type, loc === 'ar' ? input.snapshot.typeNameAr : input.snapshot.typeNameEn],
    [L.organization, pick(s.legalNameEn, s.legalNameAr) || s.organizationName],
  ];
  if (s.commercialRegistration) rows.push([L.commercialRegistration, s.commercialRegistration]);
  if (s.taxNumber) rows.push([L.taxNumber, s.taxNumber]);
  const orgAddress = pick(s.addressEn, s.addressAr);
  if (orgAddress) rows.push([L.address, orgAddress]);
  rows.push([L.recipient, pick(r.fullNameEn, r.fullNameAr)]);
  if (r.nationality) rows.push([L.nationality, r.nationality]);
  if (r.dateOfBirth) rows.push([L.dateOfBirth, formatIsoDate(r.dateOfBirth, loc)]);
  if (r.idNumber) rows.push([L.idNumber, r.idNumber]);
  const contact = [r.email, r.phone].filter(Boolean).join(' · ');
  if (contact) rows.push([L.contact, contact]);
  if (r.address) rows.push([L.address, r.address]);
  const g = d.guardian;
  if (g?.fullName) rows.push([L.guardian, [g.fullName, g.relationship ? `(${g.relationship})` : '', [g.email, g.phone].filter(Boolean).join(' · ')].filter(Boolean).join(' ')]);
  if (input.snapshot.teamName) rows.push([L.team, input.snapshot.teamName]);
  if (input.snapshot.gameName) rows.push([L.game, input.snapshot.gameName]);
  if (d.role) rows.push([L.role, d.role]);
  if (d.startDate || d.endDate) {
    const span = [d.startDate ? formatIsoDate(d.startDate, loc) : '…', d.endDate ? formatIsoDate(d.endDate, loc) : '…'].join(` ${L.to} `);
    const len = d.startDate && d.endDate ? contractLength(d.startDate, d.endDate) : null;
    rows.push([L.term, len ? `${span} (${formatDuration(len.months, len.days, loc)})` : span]);
  }
  const c = d.compensation;
  if (c?.amount) rows.push([L.salary, `${money(c.amount, c.currency)} ${cl(loc).frequencyPhrase[c.frequency]}`]);
  if (c?.offSeasonAmount || c?.offSeasonNotes)
    rows.push([L.offSeason, [money(c.offSeasonAmount, c.currency), c.offSeasonNotes ?? ''].filter(Boolean).join(' — ')]);
  if (d.revenueShare?.percent || d.revenueShare?.description)
    rows.push([L.revenueShare, [d.revenueShare.percent ? `${d.revenueShare.percent}%` : '', d.revenueShare.description ?? ''].filter(Boolean).join(' — ')]);
  if (d.bonuses?.length)
    rows.push([
      L.bonuses,
      d.bonuses
        .map((b) => [b.description, money(b.amount, b.currency), b.condition ? `${L.condition}: ${b.condition}` : ''].filter(Boolean).join(' — '))
        .join('\n'),
    ]);
  if (d.buyout?.amount || d.buyout?.triggers) {
    if (d.buyout.amount) rows.push([L.buyout, money(d.buyout.amount, d.buyout.currency)]);
    if (d.buyout.triggers) rows.push([L.buyoutTriggers, d.buyout.triggers]);
  }
  if (d.terminationConditions) rows.push([L.termination, d.terminationConditions]);
  if (d.obligations) rows.push([L.obligations, d.obligations]);
  return rows;
}

export function contractHtml(input: RenderInput): string {
  const { snapshot, settings: s } = input;
  const locales = documentLocales(snapshot.details.language);
  const bilingual = locales.length === 2;
  const mainLoc: ContractLocale = bilingual ? 'en' : locales[0]!;
  const dir = !bilingual && mainLoc === 'ar' ? 'rtl' : 'ltr';
  const both = <T,>(f: (l: ContractLocale) => T) => locales.map(f);
  const L = (l: ContractLocale) => cl(l).doc;

  // Letterhead
  const logo = input.assets.logo ? `<img class="logo" src="${dataUri(input.assets.logo)}" alt="">` : '';
  /** One line per language; in bilingual documents English sits at the start and Arabic at the end. */
  const row = (cls: string, f: (l: ContractLocale) => string | null | undefined, html = false) => {
    const parts = both((l) => ({ l, t: f(l) })).filter((p) => p.t);
    if (!parts.length) return '';
    const unique = parts.length === 2 && parts[0]!.t === parts[1]!.t ? [parts[0]!] : parts;
    const cell = (p: { l: ContractLocale; t: string | null | undefined }) =>
      `<div class="${cls}" lang="${p.l}" dir="${p.l === 'ar' ? 'rtl' : 'ltr'}">${html ? p.t : esc(p.t!)}</div>`;
    return unique.length === 2 ? `<div class="bi-row">${unique.map(cell).join('')}</div>` : cell(unique[0]!);
  };
  const orgNames = row('org', (l) => (l === 'ar' ? s.legalNameAr || s.legalNameEn : s.legalNameEn || s.legalNameAr) || s.organizationName);
  const headerTexts = row('htext', (l) => {
    const t = l === 'ar' ? s.headerTextAr : s.headerTextEn;
    return t ? nl(t) : null;
  }, true);
  const footerTexts = both((l) => {
    const t = l === 'ar' ? s.footerTextAr : s.footerTextEn;
    return t ? `<div lang="${l}" dir="${l === 'ar' ? 'rtl' : 'ltr'}">${nl(t)}</div>` : '';
  }).join('');
  const footerIds = [s.commercialRegistration ? `CR ${esc(s.commercialRegistration)}` : '', s.taxNumber ? `VAT/TIN ${esc(s.taxNumber)}` : '', s.email ? esc(s.email) : '', s.phone ? esc(s.phone) : '', s.website ? esc(s.website) : '']
    .filter(Boolean)
    .join(' · ');

  // Title
  const title = row('title', (l) => snapshot.details.title || (l === 'ar' ? snapshot.typeNameAr : snapshot.typeNameEn));

  // Particulars
  let particulars: string;
  if (bilingual) {
    const en = particularRows(input, 'en');
    const ar = particularRows(input, 'ar');
    // Rows correspond one-to-one (same conditions in both languages).
    particulars = `<table class="particulars bi"><tbody>${en
      .map(([le, ve], i) => {
        const [la, va] = ar[i] ?? ['', ''];
        return `<tr><th>${esc(le)}</th><td>${nl(ve)}</td><td dir="rtl" lang="ar">${nl(va)}</td><th dir="rtl" lang="ar">${esc(la)}</th></tr>`;
      })
      .join('')}</tbody></table>`;
  } else {
    particulars = `<table class="particulars"><tbody>${particularRows(input, mainLoc)
      .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${nl(v)}</td></tr>`)
      .join('')}</tbody></table>`;
  }

  // Clauses
  const included = snapshot.clauses.filter((c) => c.included);
  const clauseBlock = (c: (typeof included)[number], n: number, l: ContractLocale) =>
    `<div class="clause" lang="${l}" dir="${l === 'ar' ? 'rtl' : 'ltr'}"><h3><span class="n">${n}.</span> ${esc(l === 'ar' ? c.titleAr || c.titleEn : c.titleEn || c.titleAr)}</h3><p>${clauseBody(l === 'ar' ? c.bodyAr || c.bodyEn : c.bodyEn || c.bodyAr, input, l)}</p></div>`;
  const clauses = included
    .map((c, i) =>
      bilingual
        ? `<div class="pair">${clauseBlock(c, i + 1, 'en')}${clauseBlock(c, i + 1, 'ar')}</div>`
        : clauseBlock(c, i + 1, mainLoc),
    )
    .join('');

  const heading = (key: 'particulars' | 'clauses' | 'approval' | 'signatures') =>
    bilingual
      ? `<h2 class="bi"><span>${esc(L('en')[key])}</span><span dir="rtl" lang="ar">${esc(L('ar')[key])}</span></h2>`
      : `<h2>${esc(L(mainLoc)[key])}</h2>`;
  const textBoth = (f: (l: ContractLocale) => string) =>
    bilingual
      ? `<div class="pair">${both((l) => `<p lang="${l}" dir="${l === 'ar' ? 'rtl' : 'ltr'}">${f(l)}</p>`).join('')}</div>`
      : `<p>${f(mainLoc)}</p>`;

  // Approval
  let approval = '';
  if (input.approval) {
    const a = input.approval;
    const stamp = input.assets.stamp
      ? `<img class="stamp" src="${dataUri(input.assets.stamp)}" alt="" style="width:${s.stampWidthMm}mm">`
      : `<p class="muted">${both((l) => esc(L(l).noStamp)).join(' / ')}</p>`;
    approval = `<section class="approval">${heading('approval')}<div class="stampwrap pos-${s.stampPosition}">${stamp}</div>${textBoth(
      (l) =>
        `${esc(L(l).approvedBy)}: <strong>${esc(a.approverName)}</strong><br>${esc(L(l).approvedOn)}: ${esc(formatIsoDate(a.approvedAt.toISOString().slice(0, 10), l))}<br>${esc(L(l).version)}: ${a.version}`,
    )}<p class="fp">${esc(L('en').fingerprint)}${bilingual ? ` / ${esc(L('ar').fingerprint)}` : ''}: <span dir="ltr">${a.sha256}</span></p></section>`;
  }
  const signatures = `<section class="signatures">${heading('signatures')}${textBoth((l) => `<span class="muted">${esc(L(l).signaturesPending)}</span>`)}</section>`;

  const watermark = input.approval
    ? ''
    : `<div class="watermark">${both((l) => `<span lang="${l}" dir="${l === 'ar' ? 'rtl' : 'ltr'}">${esc(L(l).draftWatermark)}</span>`).join('')}</div>`;

  const screen = input.mode === 'screen';
  const m = contractMargins(input);
  const screenBg =
    screen && input.background && input.background.contentType.startsWith('image/')
      ? `background-image:url(${dataUri(input.background)});background-size:210mm 297mm;background-repeat:repeat-y;`
      : '';
  const screenCss = screen
    ? `html{background:#e6e8eb}body{padding:16px 0}
.sheet{position:relative;background:#fff;${screenBg}width:210mm;max-width:100%;min-height:297mm;margin:0 auto;padding:${m.top} ${m.right} ${m.bottom} ${m.left};box-shadow:0 1px 4px rgba(0,0,0,.18)}
.sheet .border{position:absolute;inset:${m.top} ${m.right} ${m.bottom} ${m.left}}
.sheet .watermark{position:absolute;inset:0;justify-content:flex-start;padding-top:110mm}
@media (max-width:820px){body{padding:0}.sheet{padding:14px;min-height:0;box-shadow:none}.sheet .border{inset:6px}.pair{grid-template-columns:1fr}.particulars.bi th,.particulars.bi td{display:block;width:auto}.particulars.bi tr{display:block;padding:4pt 0;border-bottom:1px solid #eef0f2}.particulars td{border:0}}`
    : '';

  return `<!doctype html><html lang="${mainLoc}" dir="${dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:"><title>${esc(input.contractNumber)}</title><style>
${pdfFonts()}
@page{size:A4}
*{box-sizing:border-box}
html{font-family:'Plex',sans-serif;font-size:${s.fontSizePt}pt;line-height:${s.lineHeight};color:#16191d;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0}
table.frame{width:100%;border-collapse:collapse}
table.frame>thead>tr>td,table.frame>tfoot>tr>td{padding:0}
.letterhead{display:flex;flex-direction:column;gap:2pt;padding-bottom:8pt;margin-bottom:10pt;border-bottom:1px solid #c8ccd2;text-align:${s.logoPosition === 'center' ? 'center' : 'start'}}
.letterhead.pos-end{text-align:end}
.letterhead .logo{max-height:18mm;max-width:60mm;object-fit:contain;display:block;margin-inline-start:${s.logoPosition === 'start' ? '0' : 'auto'};margin-inline-end:${s.logoPosition === 'end' ? '0' : s.logoPosition === 'center' ? 'auto' : 'auto'}}
.letterhead .org{font-weight:600;font-size:1.05em}
.letterhead .htext{color:#4a505a;font-size:.85em}
.bi-row{display:flex;justify-content:space-between;align-items:baseline;gap:14pt}
.bi-row>[dir=rtl]{text-align:right}
.foot{border-top:1px solid #c8ccd2;margin-top:10pt;padding-top:5pt;font-size:.78em;color:#4a505a;display:flex;flex-direction:column;gap:1pt}
.title{font-size:1.45em;font-weight:600;margin:0 0 2pt}
.number{color:#4a505a;margin-bottom:10pt}
h2{font-size:1.08em;font-weight:600;margin:14pt 0 6pt;break-after:avoid;border-bottom:1px solid #e1e4e8;padding-bottom:2pt}
h2.bi{display:flex;justify-content:space-between;gap:12pt}
h3{font-size:1em;font-weight:600;margin:0 0 2pt}
p{margin:0 0 6pt}
.particulars{width:100%;border-collapse:collapse;font-size:.95em}
.particulars th{text-align:start;font-weight:600;color:#3a3f47;width:30%;padding:3pt 6pt 3pt 0;vertical-align:top}
.particulars.bi th{width:17%}
.particulars td{padding:3pt 6pt;vertical-align:top;border-bottom:1px solid #eef0f2}
.particulars.bi td{width:33%}
.clause{margin-bottom:8pt;break-inside:avoid}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:14pt;break-inside:avoid}
[dir=rtl]{text-align:right}
mark.missing{background:#fde7c4;color:#6b3d00;padding:0 2pt;border-radius:2pt}
.approval,.signatures{break-inside:avoid}
.stampwrap{display:flex;margin:4pt 0 6pt}
.stampwrap.pos-start{justify-content:flex-start}.stampwrap.pos-center{justify-content:center}.stampwrap.pos-end{justify-content:flex-end}
.stamp{display:block;height:auto}
.fp{font-size:.72em;color:#4a505a;word-break:break-all}
.muted{color:#5b6068}
.border{position:fixed;inset:0;border:${s.pageBorder ? '1px solid #9aa1aa' : '0'};pointer-events:none}
.watermark{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6pt;transform:rotate(-30deg);color:rgba(180,40,40,.13);font-size:30pt;font-weight:600;pointer-events:none;white-space:nowrap}
${screenCss}
</style></head><body>${screen ? '<div class="sheet">' : ''}
${s.pageBorder ? '<div class="border"></div>' : ''}${watermark}
<table class="frame"><thead><tr><td><div class="letterhead pos-${s.logoPosition}">${logo}${orgNames}${headerTexts}</div></td></tr></thead>
<tfoot><tr><td><div class="foot">${footerTexts}${footerIds ? `<div dir="ltr">${footerIds}</div>` : ''}</div></td></tr></tfoot>
<tbody><tr><td>
${title}<div class="number" dir="ltr">${esc(input.contractNumber)}</div>
<section>${heading('particulars')}${particulars}</section>
<section>${heading('clauses')}${clauses}</section>
${approval}
${signatures}
</td></tr></tbody></table>${screen ? '</div>' : ''}
</body></html>`;
}

/** PDF margins from the document settings ("start/end" follow the reading direction). */
export function contractMargins(input: RenderInput) {
  const s = input.settings;
  const rtl = input.snapshot.details.language === 'ar';
  const start = `${s.marginStartMm}mm`;
  const end = `${s.marginEndMm}mm`;
  return {
    top: `${s.marginTopMm}mm`,
    bottom: `${s.marginBottomMm}mm`,
    left: rtl ? end : start,
    right: rtl ? start : end,
  };
}

export const PAGE_NUMBER_FOOTER =
  '<div style="width:100%;font-size:7pt;color:#6b7078;text-align:center;font-family:sans-serif"><span class="pageNumber"></span> / <span class="totalPages"></span></div>';
