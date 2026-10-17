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
} from './catalog';

export type ContractLocale = 'ar' | 'en';

const en = {
  status: {
    draft: 'Draft',
    pending_approval: 'Awaiting approval',
    changes_requested: 'Changes requested',
    approved: 'Approved',
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
};

const ar: typeof en = {
  status: {
    draft: 'مسودة',
    pending_approval: 'بانتظار الاعتماد',
    changes_requested: 'مطلوب تعديلات',
    approved: 'معتمد',
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
};

export const CONTRACT_LABELS: Record<ContractLocale, typeof en> = { en, ar };
export const cl = (locale: ContractLocale) => CONTRACT_LABELS[locale];

/** "12 months", "1 month 15 days" / "12 شهرًا"… Arabic number agreement for months and days. */
export function formatDuration(months: number, days: number, locale: ContractLocale): string {
  const part = (n: number, unit: 'm' | 'd') => {
    if (locale === 'en') return `${n} ${unit === 'm' ? (n === 1 ? 'month' : 'months') : n === 1 ? 'day' : 'days'}`;
    const [one, two, few, many] =
      unit === 'm' ? ['شهر واحد', 'شهران', 'أشهر', 'شهرًا'] : ['يوم واحد', 'يومان', 'أيام', 'يومًا'];
    if (n === 1) return one;
    if (n === 2) return two;
    if (n >= 3 && n <= 10) return `${n} ${few}`;
    return `${n} ${many}`;
  };
  const parts = [months ? part(months, 'm') : '', days ? part(days, 'd') : ''].filter(Boolean);
  if (!parts.length) return part(0, 'd');
  return parts.join(locale === 'en' ? ' ' : ' و');
}
