/**
 * Contract wording shared by the dashboard and the generated documents (one source, so the
 * preview, the approved PDF and the screen use the same terms).
 */
import type { PayFrequency } from '../finance/catalog';
import type {
  ApprovalRequestStatus,
  ContractStatus,
  DocumentLanguage,
  MergeField,
  RecipientKind,
  SignatureMethod,
  SignerRole,
  VerificationMethod,
} from './catalog';

export type ContractLocale = 'ar' | 'en';

const en = {
  status: {
    draft: 'Draft',
    pending_approval: 'Awaiting approval',
    changes_requested: 'Changes requested',
    approved: 'Approved',
    awaiting_signatures: 'Awaiting signatures',
    signed: 'Signed',
    cancelled: 'Cancelled',
  } as Record<ContractStatus, string>,
  requestStatus: {
    pending: 'Pending',
    approved: 'Approved',
    rejected: 'Rejected',
    withdrawn: 'Withdrawn',
  } as Record<ApprovalRequestStatus, string>,
  recipientKind: {
    player: 'Player',
    coach: 'Coach',
    manager: 'Manager',
    staff: 'Staff member',
    other: 'Other',
  } as Record<RecipientKind, string>,
  language: {
    bilingual: 'Arabic and English',
    ar: 'Arabic',
    en: 'English',
  } as Record<DocumentLanguage, string>,
  field: {
    organizationName: 'Organization name',
    organizationLegalName: 'Organization legal name',
    contractNumber: 'Contract number',
    recipientName: 'Recipient name',
    teamName: 'Team',
    gameName: 'Game',
    role: 'Role',
    startDate: 'Start date',
    endDate: 'End date',
    duration: 'Duration',
    salary: 'Salary',
    paymentFrequency: 'Payment frequency',
  } as Record<MergeField, string>,
  /** Submission requirements that aren't merge fields. */
  requirement: {
    dateOfBirth: "Recipient's date of birth (decides whether a guardian must also sign)",
    guardianName: "Parent or guardian's name (the recipient is under 18)",
    guardianRelationship: "Parent or guardian's relationship to the recipient",
    guardianContact: "Parent or guardian's email or phone",
  } as Record<string, string>,
  signerRole: { recipient: 'Recipient', guardian: 'Parent or guardian' } as Record<
    SignerRole,
    string
  >,
  verification: {
    email_code: 'Code sent by email',
    access_code: 'Access code given by the organization',
  } as Record<VerificationMethod, string>,
  signatureMethod: { typed: 'Typed', drawn: 'Drawn' } as Record<SignatureMethod, string>,
  frequencyPhrase: {
    weekly: 'per week',
    biweekly: 'every two weeks',
    semimonthly: 'twice a month',
    monthly: 'per month',
    quarterly: 'per quarter',
    annually: 'per year',
    per_event: 'per event',
    one_time: 'as a one-time payment',
  } as Record<PayFrequency, string>,
  doc: {
    contract: 'Contract',
    particulars: 'Contract Particulars',
    clauses: 'Terms',
    contractNumber: 'Contract number',
    type: 'Contract type',
    organization: 'Organization',
    commercialRegistration: 'Commercial registration',
    taxNumber: 'Tax number',
    address: 'Address',
    contact: 'Contact',
    recipient: 'Recipient',
    nationality: 'Nationality',
    dateOfBirth: 'Date of birth',
    idNumber: 'ID / passport number',
    guardian: 'Parent or guardian',
    relationship: 'Relationship',
    team: 'Team',
    game: 'Game',
    role: 'Role',
    term: 'Term',
    salary: 'Salary',
    offSeason: 'Off-season compensation',
    revenueShare: 'Revenue share',
    bonuses: 'Bonuses and conditional payments',
    condition: 'Condition',
    buyout: 'Buyout',
    buyoutTriggers: 'Buyout triggers',
    termination: 'Termination conditions',
    obligations: 'Additional obligations and rights',
    none: '—',
    to: 'to',
    draftWatermark: 'DRAFT — NOT APPROVED',
    approval: 'Approval',
    approvedBy: 'Approved by',
    approvedOn: 'Approved on',
    version: 'Version',
    fingerprint: 'Content fingerprint (SHA-256)',
    noStamp: 'No approval stamp is configured.',
    signatures: 'Signatures',
    signaturesPending: 'Signatures are collected after approval.',
    page: 'Page',
    missing: 'missing',
  },
  certificate: {
    title: 'Signature record',
    lead: 'Electronic signatures collected for this contract through the platform.',
    contract: 'Contract',
    approvedDocument: 'Approved document (SHA-256)',
    signer: 'Signer',
    role: 'Role',
    signature: 'Signature',
    method: 'Method',
    signedAt: 'Signed at (UTC)',
    verification: 'Identity check',
    verifiedAt: 'Checked at (UTC)',
    contact: 'Code sent to',
    ipAddress: 'IP address',
    device: 'Browser',
    consent: 'Statement agreed to',
    completedAt: 'All signatures collected (UTC)',
    onBehalfOf: 'on behalf of',
    approvedVersion: 'Approved version',
    approvedBy: 'Approved by',
    recordHash: 'Signature record fingerprint (SHA-256)',
    accessCode: 'Access code handed over by the organization',
    note: 'This page records how each signature was given. The approved document above is unchanged; its fingerprint lets anyone check that.',
  },
};

const ar: typeof en = {
  status: {
    draft: 'مسودة',
    pending_approval: 'بانتظار الاعتماد',
    changes_requested: 'مطلوب تعديلات',
    approved: 'معتمد',
    awaiting_signatures: 'بانتظار التوقيعات',
    signed: 'موقّع',
    cancelled: 'ملغى',
  },
  requestStatus: {
    pending: 'قيد المراجعة',
    approved: 'معتمد',
    rejected: 'مرفوض',
    withdrawn: 'مسحوب',
  },
  recipientKind: {
    player: 'لاعب',
    coach: 'مدرب',
    manager: 'مدير',
    staff: 'موظف',
    other: 'أخرى',
  },
  language: {
    bilingual: 'العربية والإنجليزية',
    ar: 'العربية',
    en: 'الإنجليزية',
  },
  field: {
    organizationName: 'اسم المنظمة',
    organizationLegalName: 'الاسم القانوني للمنظمة',
    contractNumber: 'رقم العقد',
    recipientName: 'اسم الطرف الثاني',
    teamName: 'الفريق',
    gameName: 'اللعبة',
    role: 'الدور',
    startDate: 'تاريخ البدء',
    endDate: 'تاريخ الانتهاء',
    duration: 'المدة',
    salary: 'الراتب',
    paymentFrequency: 'دورية الدفع',
  },
  requirement: {
    dateOfBirth: 'تاريخ ميلاد الطرف الثاني (يحدد ما إذا كان يلزم توقيع وليّ الأمر)',
    guardianName: 'اسم وليّ الأمر (الطرف الثاني دون 18 عامًا)',
    guardianRelationship: 'صلة قرابة وليّ الأمر بالطرف الثاني',
    guardianContact: 'البريد الإلكتروني أو الهاتف لوليّ الأمر',
  },
  signerRole: { recipient: 'الطرف الثاني', guardian: 'وليّ الأمر' },
  verification: {
    email_code: 'رمز يُرسل بالبريد الإلكتروني',
    access_code: 'رمز دخول تقدّمه المنظمة',
  },
  signatureMethod: { typed: 'مكتوب', drawn: 'مرسوم' },
  frequencyPhrase: {
    weekly: 'أسبوعيًا',
    biweekly: 'كل أسبوعين',
    semimonthly: 'مرتين في الشهر',
    monthly: 'شهريًا',
    quarterly: 'كل ثلاثة أشهر',
    annually: 'سنويًا',
    per_event: 'عن كل فعالية',
    one_time: 'دفعةً واحدة',
  },
  doc: {
    contract: 'عقد',
    particulars: 'بيانات العقد',
    clauses: 'البنود',
    contractNumber: 'رقم العقد',
    type: 'نوع العقد',
    organization: 'المنظمة',
    commercialRegistration: 'السجل التجاري',
    taxNumber: 'الرقم الضريبي',
    address: 'العنوان',
    contact: 'التواصل',
    recipient: 'الطرف الثاني',
    nationality: 'الجنسية',
    dateOfBirth: 'تاريخ الميلاد',
    idNumber: 'رقم الهوية / الجواز',
    guardian: 'وليّ الأمر',
    relationship: 'صلة القرابة',
    team: 'الفريق',
    game: 'اللعبة',
    role: 'الدور',
    term: 'المدة',
    salary: 'الراتب',
    offSeason: 'المقابل خارج الموسم',
    revenueShare: 'حصة الإيرادات',
    bonuses: 'المكافآت والمدفوعات المشروطة',
    condition: 'الشرط',
    buyout: 'مبلغ فسخ العقد',
    buyoutTriggers: 'حالات استحقاق مبلغ الفسخ',
    termination: 'شروط الإنهاء',
    obligations: 'التزامات وحقوق إضافية',
    none: '—',
    to: 'إلى',
    draftWatermark: 'مسودة — غير معتمدة',
    approval: 'الاعتماد',
    approvedBy: 'اعتمده',
    approvedOn: 'تاريخ الاعتماد',
    version: 'النسخة',
    fingerprint: 'بصمة المحتوى (SHA-256)',
    noStamp: 'لم يُضبط ختم اعتماد.',
    signatures: 'التوقيعات',
    signaturesPending: 'تُجمع التوقيعات بعد الاعتماد.',
    page: 'صفحة',
    missing: 'غير محدد',
  },
  certificate: {
    title: 'سجل التوقيعات',
    lead: 'التوقيعات الإلكترونية التي جُمعت لهذا العقد عبر المنصة.',
    contract: 'العقد',
    approvedDocument: 'المستند المعتمد (SHA-256)',
    signer: 'الموقّع',
    role: 'الصفة',
    signature: 'التوقيع',
    method: 'الطريقة',
    signedAt: 'وقت التوقيع (UTC)',
    verification: 'التحقق من الهوية',
    verifiedAt: 'وقت التحقق (UTC)',
    contact: 'أُرسل الرمز إلى',
    ipAddress: 'عنوان IP',
    device: 'المتصفح',
    consent: 'الإقرار الذي وافق عليه',
    completedAt: 'اكتمال التوقيعات (UTC)',
    onBehalfOf: 'نيابةً عن',
    approvedVersion: 'النسخة المعتمدة',
    approvedBy: 'اعتمده',
    recordHash: 'بصمة سجل التوقيع (SHA-256)',
    accessCode: 'رمز دخول سلّمته الجهة',
    note: 'تسجّل هذه الصفحة كيفية إعطاء كل توقيع. المستند المعتمد أعلاه لم يتغير، وتتيح بصمته لأي شخص التحقق من ذلك.',
  },
};

export const CONTRACT_LABELS: Record<ContractLocale, typeof en> = { en, ar };
export const cl = (locale: ContractLocale) => CONTRACT_LABELS[locale];

/** "12 months", "1 month 15 days" / "12 شهرًا"… Arabic number agreement for months and days. */
export function formatDuration(months: number, days: number, locale: ContractLocale): string {
  const part = (n: number, unit: 'm' | 'd') => {
    if (locale === 'en')
      return `${n} ${unit === 'm' ? (n === 1 ? 'month' : 'months') : n === 1 ? 'day' : 'days'}`;
    const [one, two, few, many] =
      unit === 'm'
        ? ['شهر واحد', 'شهران', 'أشهر', 'شهرًا']
        : ['يوم واحد', 'يومان', 'أيام', 'يومًا'];
    if (n === 1) return one;
    if (n === 2) return two;
    if (n >= 3 && n <= 10) return `${n} ${few}`;
    return `${n} ${many}`;
  };
  const parts = [months ? part(months, 'm') : '', days ? part(days, 'd') : ''].filter(Boolean);
  if (!parts.length) return part(0, 'd');
  return parts.join(locale === 'en' ? ' ' : ' و');
}

/**
 * The statement each signer agrees to before signing. Stored verbatim (with its version and
 * language) next to every signature, so the record shows exactly what was agreed. Worded
 * neutrally: it records consent and identity, and makes no claim about legal effect.
 */
export const CONSENT_VERSION = 'v1';
export function consentText(
  role: SignerRole,
  locale: ContractLocale,
  p: {
    signerName: string;
    recipientName: string;
    contractNumber: string;
    organizationName: string;
  },
): string {
  if (locale === 'ar') {
    return role === 'guardian'
      ? `أقرّ بأنني ${p.signerName}، وليّ أمر ${p.recipientName}، وأنني قرأت العقد ${p.contractNumber} مع ${p.organizationName}، وأوافق عليه نيابةً عنه، وأوافق على التوقيع إلكترونيًا.`
      : `أقرّ بأنني ${p.signerName}، وأنني قرأت العقد ${p.contractNumber} مع ${p.organizationName}، وأوافق على التوقيع عليه إلكترونيًا.`;
  }
  return role === 'guardian'
    ? `I confirm that I am ${p.signerName}, parent or guardian of ${p.recipientName}; that I have read contract ${p.contractNumber} with ${p.organizationName}; that I consent to it on their behalf; and that I agree to sign it electronically.`
    : `I confirm that I am ${p.signerName}, that I have read contract ${p.contractNumber} with ${p.organizationName}, and that I agree to sign it electronically.`;
}
