import {
  alertBox,
  codeBlock,
  divider,
  heading,
  infoCard,
  paragraph,
  renderLayout,
  safeAppUrl,
  type MailLocale,
  type MailLayoutResult,
} from './components.js';

export type MailTemplate =
  | 'invitation'
  | 'password_reset'
  | 'password_changed'
  | 'signing_code'
  | 'assistant_email'
  | 'contract_termination';

export interface InvitationEmailData {
  organizationName: string;
  inviterName: string | null;
  url: string;
  expiresAt: Date;
}

export interface PasswordResetEmailData {
  url: string;
  minutes: number;
}

export interface SigningCodeEmailData {
  organizationName: string;
  contractNumber: string;
  code: string;
  minutes: number;
}

export interface ContractTerminationEmailData {
  contractNumber: string;
  status: string;
  note: string | null;
}

export interface AssistantEmailData {
  subject: string;
  body: string;
}

export type EmailInput =
  | { type: 'invitation'; data: InvitationEmailData }
  | { type: 'password_reset'; data: PasswordResetEmailData }
  | { type: 'password_changed'; data: Record<string, never> }
  | { type: 'signing_code'; data: SigningCodeEmailData }
  | { type: 'assistant_email'; data: AssistantEmailData }
  | { type: 'contract_termination'; data: ContractTerminationEmailData };

export interface EmailRenderOptions {
  locale: MailLocale;
  appUrl: string;
  supportContact?: string;
}

export interface RenderedEmail extends MailLayoutResult {
  subject: string;
  preheader: string;
}

const cleanSubject = (value: string) => value.replace(/[\r\n\0-\x1f\x7f]+/g, ' ').trim();

function short(value: string, max: number): string {
  const chars = Array.from(value.trim());
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 3).join('')}...`;
}

function dateLabel(date: Date, locale: MailLocale): string {
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

function layout(
  options: EmailRenderOptions,
  data: {
    subject: string;
    preheader: string;
    content: string;
    text: string;
    reason: string;
    action?: { label: string; url: string };
  },
): RenderedEmail {
  const rendered = renderLayout({
    ...options,
    ...data,
  });
  return { subject: cleanSubject(data.subject), preheader: data.preheader, ...rendered };
}

function renderInvitation(data: InvitationEmailData, options: EmailRenderOptions): RenderedEmail {
  const { locale } = options;
  const en = locale === 'en';
  const expires = dateLabel(data.expiresAt, locale);
  const inviter = data.inviterName?.trim();
  const url = safeAppUrl(data.url, options.appUrl);
  const subject = en
    ? `Invitation to join ${short(data.organizationName, 38)}`
    : `دعوة للانضمام إلى ${short(data.organizationName, 34)}`;
  const greeting = en
    ? `${inviter || 'You'} ${inviter ? 'invited you' : 'have been invited'} to join Club Manager.`
    : inviter
      ? `دعاك ${inviter} للانضمام إلى إدارة النادي.`
      : 'تمت دعوتك للانضمام إلى إدارة النادي.';
  const content = [
    heading(en ? "You're invited" : 'تمت دعوتك', locale),
    paragraph(greeting, locale),
    infoCard(
      [
        { label: en ? 'Organization' : 'المنظمة', value: data.organizationName },
        ...(inviter ? [{ label: en ? 'Invited by' : 'الداعي', value: inviter }] : []),
        { label: en ? 'Valid until' : 'صالحة حتى', value: expires, direction: 'ltr' as const },
      ],
      locale,
    ),
    alertBox(
      'warning',
      en
        ? 'If you were not expecting this invitation, you can ignore this message.'
        : 'إذا لم تكن تتوقع هذه الدعوة، يمكنك تجاهل الرسالة.',
      locale,
    ),
  ].join('');
  const text = [
    greeting,
    '',
    `${en ? 'Organization' : 'المنظمة'}: ${data.organizationName}`,
    ...(inviter ? [`${en ? 'Invited by' : 'الداعي'}: ${inviter}`] : []),
    `${en ? 'Valid until' : 'صالحة حتى'}: ${expires}`,
    `${en ? 'Accept invitation' : 'قبول الدعوة'}: ${url}`,
    '',
    en
      ? 'If you were not expecting this invitation, you can ignore this message.'
      : 'إذا لم تكن تتوقع هذه الدعوة، يمكنك تجاهل الرسالة.',
  ].join('\n');
  return layout(options, {
    subject,
    preheader: en
      ? `Join ${short(data.organizationName, 40)}. The invitation expires ${expires}.`
      : `انضم إلى ${short(data.organizationName, 36)}. تنتهي الدعوة في ${expires}.`,
    content,
    text,
    action: { label: en ? 'Accept invitation' : 'قبول الدعوة', url },
    reason: en
      ? 'You received this because someone invited you to an organization.'
      : 'وصلتك هذه الرسالة لأن شخصًا دعاك للانضمام إلى منظمة.',
  });
}

function renderPasswordReset(
  data: PasswordResetEmailData,
  options: EmailRenderOptions,
): RenderedEmail {
  const { locale } = options;
  const en = locale === 'en';
  const url = safeAppUrl(data.url, options.appUrl);
  const subject = en ? 'Reset your password' : 'إعادة تعيين كلمة المرور';
  const expiry = en
    ? `This link expires in ${data.minutes} minutes. Only the newest reset link works.`
    : `تنتهي صلاحية هذا الرابط خلال ${data.minutes} دقيقة. يعمل أحدث رابط لإعادة التعيين فقط.`;
  const ignored = en
    ? 'If you did not request a password reset, ignore this message. Your password will not change.'
    : 'إذا لم تطلب إعادة تعيين كلمة المرور، فتجاهل هذه الرسالة. لن تتغير كلمة مرورك.';
  const content = [
    heading(subject, locale),
    paragraph(
      en
        ? 'Use the button below to choose a new password.'
        : 'استخدم الزر أدناه لاختيار كلمة مرور جديدة.',
      locale,
    ),
    alertBox('warning', expiry, locale),
    paragraph(ignored, locale, 'mail-muted'),
  ].join('');
  const text = [
    en ? 'Use this link to choose a new password:' : 'استخدم هذا الرابط لاختيار كلمة مرور جديدة:',
    url,
    '',
    expiry,
    ignored,
  ].join('\n');
  return layout(options, {
    subject,
    preheader: en
      ? 'A password reset was requested for your account.'
      : 'طُلبت إعادة تعيين كلمة المرور لحسابك.',
    content,
    text,
    action: { label: en ? 'Reset password' : 'إعادة تعيين كلمة المرور', url },
    reason: en
      ? 'You received this because a password reset was requested for your account.'
      : 'وصلتك هذه الرسالة لأنه تم طلب إعادة تعيين كلمة المرور لحسابك.',
  });
}

function renderPasswordChanged(options: EmailRenderOptions): RenderedEmail {
  const { locale } = options;
  const en = locale === 'en';
  const subject = en ? 'Your password was changed' : 'تم تغيير كلمة مرورك';
  const message = en
    ? 'Your Club Manager password was changed successfully.'
    : 'تم تغيير كلمة مرورك في إدارة النادي بنجاح.';
  const warning = en
    ? 'If you did not make this change, reset your password and contact your organization administrator.'
    : 'إذا لم تكن أنت من أجرى هذا التغيير، فأعد تعيين كلمة المرور وتواصل مع مسؤول مؤسستك.';
  return layout(options, {
    subject,
    preheader: message,
    content: [
      heading(subject, locale),
      paragraph(message, locale),
      alertBox('danger', warning, locale),
    ].join(''),
    text: `${message}\n\n${warning}`,
    action: { label: en ? 'Open Club Manager' : 'فتح إدارة النادي', url: options.appUrl },
    reason: en
      ? 'You received this because the password for your account changed.'
      : 'وصلتك هذه الرسالة لأنه تم تغيير كلمة مرور حسابك.',
  });
}

function renderSigningCode(data: SigningCodeEmailData, options: EmailRenderOptions): RenderedEmail {
  const { locale } = options;
  const en = locale === 'en';
  const subject = en ? 'Contract signing code' : 'رمز توقيع العقد';
  const opening = en
    ? 'Use this one-time code to verify your identity and open the contract for signing.'
    : 'استخدم رمز التحقق لمرة واحدة لإثبات هويتك وفتح العقد للتوقيع.';
  const expiry = en
    ? `The code expires in ${data.minutes} minutes. Do not share it with anyone.`
    : `تنتهي صلاحية الرمز خلال ${data.minutes} دقيقة. لا تشاركه مع أحد.`;
  const ignored = en
    ? 'If you did not request this code, you can ignore this message.'
    : 'إذا لم تطلب هذا الرمز، يمكنك تجاهل الرسالة.';
  const content = [
    heading(subject, locale),
    paragraph(opening, locale),
    infoCard(
      [
        { label: en ? 'Organization' : 'المنظمة', value: data.organizationName },
        {
          label: en ? 'Contract' : 'العقد',
          value: data.contractNumber,
          direction: 'ltr',
        },
      ],
      locale,
    ),
    codeBlock(data.code),
    alertBox('warning', expiry, locale),
    paragraph(ignored, locale, 'mail-muted'),
  ].join('');
  const text = [
    opening,
    '',
    `${en ? 'Organization' : 'المنظمة'}: ${data.organizationName}`,
    `${en ? 'Contract' : 'العقد'}: ${data.contractNumber}`,
    '',
    data.code,
    '',
    expiry,
    ignored,
  ].join('\n');
  return layout(options, {
    subject,
    preheader: en
      ? `Your one-time signing code expires in ${data.minutes} minutes.`
      : `ينتهي رمز التوقيع لمرة واحدة خلال ${data.minutes} دقيقة.`,
    content,
    text,
    action: { label: en ? 'Open Club Manager' : 'فتح إدارة النادي', url: options.appUrl },
    reason: en
      ? 'You received this because a contract signer requested a verification code.'
      : 'وصلتك هذه الرسالة لأن أحد موقّعي العقد طلب رمز تحقق.',
  });
}

const TERMINATION_STATUS: Record<string, Record<MailLocale, string>> = {
  requested: { en: 'Under review', ar: 'قيد المراجعة' },
  accepted: { en: 'Accepted', ar: 'مقبول' },
  rejected: { en: 'Rejected', ar: 'مرفوض' },
  withdrawn: { en: 'Withdrawn', ar: 'مسحوب' },
  executed: { en: 'Executed', ar: 'تم التنفيذ' },
  expired: { en: 'Expired', ar: 'منتهي الصلاحية' },
};

function renderContractTermination(
  data: ContractTerminationEmailData,
  options: EmailRenderOptions,
): RenderedEmail {
  const { locale } = options;
  const en = locale === 'en';
  const status = TERMINATION_STATUS[data.status]?.[locale] ?? data.status;
  const subject = en ? 'Contract termination update' : 'تحديث إنهاء العقد';
  const title = en ? 'Contract termination update' : 'تحديث بشأن إنهاء العقد';
  const noteLabel = en ? 'Additional note' : 'ملاحظة إضافية';
  const legal = en
    ? 'This message is a status notification, not legal advice.'
    : 'هذه الرسالة إشعار بالحالة وليست استشارة قانونية.';
  const content = [
    heading(title, locale),
    infoCard(
      [
        { label: en ? 'Contract' : 'العقد', value: data.contractNumber, direction: 'ltr' },
        { label: en ? 'Status' : 'الحالة', value: status },
      ],
      locale,
    ),
    ...(data.note ? [heading(noteLabel, locale), paragraph(data.note, locale)] : []),
    divider(),
    paragraph(legal, locale, 'mail-muted'),
  ].join('');
  const text = [
    title,
    '',
    `${en ? 'Contract' : 'العقد'}: ${data.contractNumber}`,
    `${en ? 'Status' : 'الحالة'}: ${status}`,
    ...(data.note ? ['', `${noteLabel}:`, data.note] : []),
    '',
    legal,
  ].join('\n');
  return layout(options, {
    subject,
    preheader: `${en ? 'Status' : 'الحالة'}: ${status}`,
    content,
    text,
    action: { label: en ? 'Open Club Manager' : 'فتح إدارة النادي', url: options.appUrl },
    reason: en
      ? 'You received this because you are connected to this contract.'
      : 'وصلتك هذه الرسالة لارتباطك بهذا العقد.',
  });
}

function renderAssistantEmail(
  data: AssistantEmailData,
  options: EmailRenderOptions,
): RenderedEmail {
  const { locale } = options;
  const en = locale === 'en';
  const subject = cleanSubject(data.subject);
  const content = [
    heading(en ? 'A message from Club Manager' : 'رسالة من إدارة النادي', locale),
    ...data.body
      .split(/\r?\n\s*\r?\n/)
      .filter((part) => part.length > 0)
      .map((part) => paragraph(part, locale)),
  ].join('');
  return layout(options, {
    subject,
    preheader: subject,
    content,
    text: data.body,
    action: { label: en ? 'Open Club Manager' : 'فتح إدارة النادي', url: options.appUrl },
    reason: en
      ? 'You received this message from a Club Manager user.'
      : 'وصلتك هذه الرسالة من أحد مستخدمي إدارة النادي.',
  });
}

export function renderEmail(input: EmailInput, options: EmailRenderOptions): RenderedEmail {
  switch (input.type) {
    case 'invitation':
      return renderInvitation(input.data, options);
    case 'password_reset':
      return renderPasswordReset(input.data, options);
    case 'password_changed':
      return renderPasswordChanged(options);
    case 'signing_code':
      return renderSigningCode(input.data, options);
    case 'assistant_email':
      return renderAssistantEmail(input.data, options);
    case 'contract_termination':
      return renderContractTermination(input.data, options);
  }
}
