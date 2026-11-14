export type MailLocale = 'ar' | 'en';

export interface MailLayoutOptions {
  locale: MailLocale;
  appUrl: string;
  supportContact?: string;
  subject: string;
  preheader: string;
  content: string;
  text: string;
  action?: { label: string; url: string };
  reason: string;
}

export interface MailLayoutResult {
  html: string;
  text: string;
}

const COLORS = {
  background: '#eef1ef',
  card: '#ffffff',
  muted: '#5b6662',
  primary: '#0f5c4a',
  primaryForeground: '#ffffff',
  soft: '#f6f8f7',
  border: '#d5ddd9',
  amber: '#fbebd0',
  amberInk: '#3d2a08',
  success: '#dcebe5',
  successInk: '#0f5c4a',
  danger: '#f6dedc',
  dangerInk: '#8b211b',
  info: '#e5eef7',
  infoInk: '#24486b',
};

const BRAND: Record<MailLocale, string> = {
  en: 'Club Manager',
  ar: 'إدارة النادي',
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function appOrigin(appUrl: string): URL {
  const base = new URL(appUrl);
  const localHttp =
    base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if ((base.protocol !== 'https:' && !localHttp) || base.username || base.password)
    throw new Error('Mail app URL must be HTTPS, or a local development URL.');
  return new URL('/', base);
}

export function safeAppUrl(value: string, appUrl: string): string {
  const base = appOrigin(appUrl);
  const candidate = new URL(value, base);
  if (
    candidate.origin !== base.origin ||
    candidate.protocol !== base.protocol ||
    candidate.username ||
    candidate.password
  )
    throw new Error('Mail links must stay on the configured app URL.');
  return candidate.href;
}

export function heading(text: string, locale: MailLocale): string {
  const align = locale === 'ar' ? 'right' : 'left';
  return `<h1 class="mail-text" dir="${locale === 'ar' ? 'rtl' : 'ltr'}" style="margin:0 0 16px;color:#1c2321;font-family:Cairo,Tahoma,Arial,sans-serif;font-size:24px;font-weight:700;line-height:1.35;text-align:${align};">${escapeHtml(text)}</h1>`;
}

export function paragraph(text: string, locale: MailLocale, className = 'mail-text'): string {
  const align = locale === 'ar' ? 'right' : 'left';
  const lines = text.split(/\r?\n/).map(escapeHtml).join('<br>');
  return `<p class="${className}" dir="${locale === 'ar' ? 'rtl' : 'ltr'}" style="margin:0 0 14px;color:#1c2321;font-family:Cairo,Tahoma,Arial,sans-serif;font-size:16px;line-height:1.7;text-align:${align};">${lines}</p>`;
}

export function infoCard(
  rows: Array<{ label: string; value: string; direction?: 'auto' | 'ltr' }>,
  locale: MailLocale,
): string {
  const align = locale === 'ar' ? 'right' : 'left';
  const content = rows
    .map(
      ({ label, value, direction = 'auto' }) =>
        `<tr><td class="mail-muted mail-border" width="38%" dir="${locale === 'ar' ? 'rtl' : 'ltr'}" align="${align}" style="padding:10px 12px;border-bottom:1px solid #d5ddd9;color:#5b6662;font-family:Cairo,Tahoma,Arial,sans-serif;font-size:14px;line-height:1.5;text-align:${align};">${escapeHtml(label)}</td><td class="mail-text mail-border" dir="${direction}" align="${align}" style="padding:10px 12px;border-bottom:1px solid #d5ddd9;color:#1c2321;font-family:Cairo,Tahoma,Arial,sans-serif;font-size:14px;line-height:1.5;text-align:${align};">${escapeHtml(value)}</td></tr>`,
    )
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="${locale === 'ar' ? 'rtl' : 'ltr'}" bgcolor="${COLORS.soft}" class="mail-panel" style="width:100%;margin:16px 0;background-color:${COLORS.soft};border:1px solid ${COLORS.border};border-collapse:separate;border-spacing:0;border-radius:8px;"><tbody>${content}</tbody></table>`;
}

export function divider(): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:20px 0;border-collapse:collapse;"><tr><td class="mail-border" height="1" bgcolor="${COLORS.border}" style="height:1px;background-color:${COLORS.border};font-size:0;line-height:0;">&nbsp;</td></tr></table>`;
}

export function codeBlock(code: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.soft}" class="mail-panel" style="width:100%;margin:18px 0;background-color:${COLORS.soft};border:1px solid ${COLORS.border};border-collapse:separate;border-spacing:0;border-radius:8px;"><tr><td align="center" dir="ltr" style="padding:18px 12px;color:#1c2321;font-family:Tahoma,Arial,sans-serif;font-size:28px;font-weight:700;letter-spacing:8px;line-height:1.4;text-align:center;"><span dir="ltr">${escapeHtml(code)}</span></td></tr></table>`;
}

export function alertBox(
  tone: 'info' | 'success' | 'warning' | 'danger',
  text: string,
  locale: MailLocale,
): string {
  const palette = {
    info: [COLORS.info, COLORS.infoInk],
    success: [COLORS.success, COLORS.successInk],
    warning: [COLORS.amber, COLORS.amberInk],
    danger: [COLORS.danger, COLORS.dangerInk],
  }[tone];
  const align = locale === 'ar' ? 'right' : 'left';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${palette[0]}" style="width:100%;margin:16px 0;border-collapse:collapse;background-color:${palette[0]};"><tr><td dir="${locale === 'ar' ? 'rtl' : 'ltr'}" align="${align}" style="padding:12px 14px;color:${palette[1]};font-family:Cairo,Tahoma,Arial,sans-serif;font-size:14px;line-height:1.6;text-align:${align};">${escapeHtml(text)}</td></tr></table>`;
}

export function button(url: string, label: string, appUrl: string): string {
  const href = escapeHtml(safeAppUrl(url, appUrl));
  const text = escapeHtml(label);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:22px auto 8px;border-collapse:collapse;"><tr><td align="center" bgcolor="${COLORS.primary}" style="background-color:${COLORS.primary};"><!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:48px;v-text-anchor:middle;width:240px;" arcsize="8%" stroke="f" fillcolor="${COLORS.primary}"><w:anchorlock/><center style="color:#ffffff;font-family:Tahoma,Arial,sans-serif;font-size:16px;font-weight:bold;">${text}</center></v:roundrect><![endif]--><!--[if !mso]><!--><a href="${href}" target="_blank" style="display:inline-block;min-width:196px;min-height:48px;padding:0 22px;background-color:${COLORS.primary};color:${COLORS.primaryForeground};font-family:Cairo,Tahoma,Arial,sans-serif;font-size:16px;font-weight:700;line-height:48px;text-align:center;text-decoration:none;">${text}</a><!--<![endif]--></td></tr></table>`;
}

function footer(
  locale: MailLocale,
  appUrl: string,
  supportContact: string | undefined,
  reason: string,
) {
  const home = safeAppUrl('/', appUrl);
  const support =
    supportContact?.replace(/[\r\n]+/g, ' ').trim() ||
    (locale === 'ar' ? 'مسؤول المؤسسة' : 'your organization administrator');
  const text =
    locale === 'ar'
      ? `${reason}\nللمساعدة: ${support}\nالمنصة: ${home}`
      : `${reason}\nSupport: ${support}\nClub Manager: ${home}`;
  const html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;"><tr><td class="mail-muted mail-border" dir="${locale === 'ar' ? 'rtl' : 'ltr'}" align="${locale === 'ar' ? 'right' : 'left'}" style="padding:18px 0 0;border-top:1px solid ${COLORS.border};color:${COLORS.muted};font-family:Cairo,Tahoma,Arial,sans-serif;font-size:13px;line-height:1.7;text-align:${locale === 'ar' ? 'right' : 'left'};"><p style="margin:0 0 8px;">${escapeHtml(reason)}</p><p style="margin:0 0 8px;">${locale === 'ar' ? 'للمساعدة:' : 'Support:'} <span dir="ltr">${escapeHtml(support)}</span></p><p style="margin:0;"><a href="${escapeHtml(home)}" target="_blank" style="color:${COLORS.primary};font-family:Cairo,Tahoma,Arial,sans-serif;text-decoration:underline;">${locale === 'ar' ? 'زيارة المنصة' : 'Visit Club Manager'}</a></p></td></tr></table>`;
  return { html, text };
}

export function renderLayout(options: MailLayoutOptions): MailLayoutResult {
  const { locale, appUrl, subject, preheader, content, action, reason } = options;
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  const align = locale === 'ar' ? 'right' : 'left';
  const brand = BRAND[locale];
  const logo = escapeHtml(safeAppUrl('/icon-512.png', appUrl));
  const actionHtml = action ? button(action.url, action.label, appUrl) : '';
  const footerContent = footer(locale, appUrl, options.supportContact, reason);
  const safePreheader = escapeHtml(preheader);
  const paddedPreheader = '&zwnj;&nbsp;'.repeat(12);
  const html = `<!doctype html>
<html lang="${locale}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(subject)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700&display=swap">
<style>
@media screen and (max-width:600px){.mail-gutter{padding:20px!important}.mail-card{width:100%!important}}
@media (prefers-color-scheme:dark){body,.mail-bg{background-color:#141a18!important;color:#e6ece9!important}.mail-card{background-color:#1b2321!important}.mail-panel{background-color:#212a27!important}.mail-text{color:#e6ece9!important}.mail-muted{color:#9aa7a2!important}.mail-border{border-color:#2f3b37!important}}
</style>
</head>
<body class="mail-bg" bgcolor="${COLORS.background}" style="margin:0;padding:0;background-color:${COLORS.background};color:#1c2321;font-family:Cairo,Tahoma,Arial,sans-serif;">
<span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;max-height:0;max-width:0;overflow:hidden;mso-hide:all;">${safePreheader}${paddedPreheader}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="${dir}" bgcolor="${COLORS.background}" class="mail-bg" style="width:100%;background-color:${COLORS.background};border-collapse:collapse;">
<tr><td class="mail-gutter" align="center" style="padding:32px 16px;">
<!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="${dir}" bgcolor="${COLORS.card}" class="mail-card" style="width:100%;max-width:600px;background-color:${COLORS.card};border:1px solid ${COLORS.border};border-collapse:separate;border-spacing:0;">
<tr><td bgcolor="${COLORS.primary}" style="padding:20px 24px;background-color:${COLORS.primary};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="${dir}" style="width:100%;border-collapse:collapse;"><tr><td width="58" valign="middle"><img src="${logo}" width="48" height="48" alt="${escapeHtml(brand)}" style="display:block;width:48px;height:48px;border:0;"></td><td valign="middle" align="${align}" style="color:#ffffff;font-family:Cairo,Tahoma,Arial,sans-serif;font-size:17px;font-weight:700;line-height:1.4;text-align:${align};"><span>${escapeHtml(brand)}</span></td></tr></table></td></tr>
<tr><td class="mail-gutter" dir="${dir}" align="${align}" style="padding:28px 32px 24px;text-align:${align};">${content}${actionHtml}</td></tr>
<tr><td class="mail-gutter" style="padding:0 32px 26px;">${footerContent.html}</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
</body>
</html>`;
  const actionUrl = action ? safeAppUrl(action.url, appUrl) : undefined;
  const actionText =
    action && actionUrl && !options.text.includes(actionUrl) ? `${action.label}\n${actionUrl}` : '';
  const text = [subject, '', options.text, actionText, '', footerContent.text]
    .filter((part) => part !== '')
    .join('\n');
  return { html, text };
}
