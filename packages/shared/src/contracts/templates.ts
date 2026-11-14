/**
 * Default contract types and their clause templates, seeded into every organization.
 *
 * THIS IS SAMPLE WORDING, NOT LEGAL ADVICE. It gives each type a sensible structure (which
 * clauses exist, which are required, which details they draw on) so drafting can start. Owners
 * edit the wording in the template editor; the product tells users to have counsel review
 * templates before use. Nothing here claims a clause is valid or enforceable (spec §7.4, §7.8).
 * The governing-law clause is deliberately left as a placeholder for counsel to complete.
 */
import type { SystemContractType } from './catalog.js';

export interface DefaultClause {
  key: string;
  required: boolean;
  titleEn: string;
  titleAr: string;
  bodyEn: string;
  bodyAr: string;
}

export interface DefaultContractType {
  key: SystemContractType;
  nameEn: string;
  nameAr: string;
  clauses: DefaultClause[];
}

const PARTY: Record<SystemContractType, { en: string; ar: string }> = {
  player: { en: 'Player', ar: 'اللاعب' },
  coach: { en: 'Coach', ar: 'المدرب' },
  manager: { en: 'Manager', ar: 'المدير' },
  staff: { en: 'Staff Member', ar: 'الموظف' },
};

const ROLE_CLAUSE: Record<SystemContractType, { en: string; ar: string }> = {
  player: {
    en: 'The Player will represent the Organization as a member of {{teamName}} in {{gameName}} in the role of {{role}}, and will take part in training, official matches, tournaments and team activities scheduled by the Organization.',
    ar: 'يمثّل اللاعب المنظمة بصفته عضوًا في فريق {{teamName}} في لعبة {{gameName}} بدور {{role}}، ويشارك في التدريبات والمباريات الرسمية والبطولات وأنشطة الفريق التي تحددها المنظمة.',
  },
  coach: {
    en: 'The Coach will coach {{teamName}} in {{gameName}} as {{role}}, including planning and running training, match preparation and player development.',
    ar: 'يتولى المدرب تدريب فريق {{teamName}} في لعبة {{gameName}} بصفته {{role}}، بما في ذلك تخطيط التدريبات وإدارتها والإعداد للمباريات وتطوير اللاعبين.',
  },
  manager: {
    en: 'The Manager will manage {{teamName}} as {{role}}, including team operations, scheduling, travel and communication with the Organization.',
    ar: 'يتولى المدير إدارة فريق {{teamName}} بصفته {{role}}، بما في ذلك عمليات الفريق والجداول والسفر والتواصل مع المنظمة.',
  },
  staff: {
    en: 'The Staff Member will work for the Organization as {{role}} and carry out the duties reasonably assigned to that role.',
    ar: 'يعمل الموظف لدى المنظمة بصفته {{role}} ويؤدي المهام المسندة إلى هذا الدور بشكل معقول.',
  },
};

function clausesFor(type: SystemContractType): DefaultClause[] {
  const p = PARTY[type];
  const list: DefaultClause[] = [
    {
      key: 'parties',
      required: true,
      titleEn: 'Parties',
      titleAr: 'الطرفان',
      bodyEn: `This contract is made between {{organizationLegalName}} (the “Organization”) and {{recipientName}} (the “${p.en}”).`,
      bodyAr: `أُبرم هذا العقد بين {{organizationLegalName}} (ويُشار إليها بـ«المنظمة») و{{recipientName}} (ويُشار إليه بـ«${p.ar}»).`,
    },
    {
      key: 'term',
      required: true,
      titleEn: 'Term',
      titleAr: 'مدة العقد',
      bodyEn:
        'This contract starts on {{startDate}} and ends on {{endDate}} ({{duration}}), unless ended earlier under its terms.',
      bodyAr:
        'يبدأ هذا العقد في {{startDate}} وينتهي في {{endDate}} ({{duration}})، ما لم يُنهَ قبل ذلك وفق أحكامه.',
    },
    {
      key: 'role',
      required: true,
      titleEn: 'Role and duties',
      titleAr: 'الدور والمهام',
      bodyEn: ROLE_CLAUSE[type].en,
      bodyAr: ROLE_CLAUSE[type].ar,
    },
    {
      key: 'compensation',
      required: true,
      titleEn: 'Compensation',
      titleAr: 'المقابل المالي',
      bodyEn:
        'The Organization will pay {{salary}} {{paymentFrequency}}. Off-season pay, bonuses and any revenue share are set out in the Contract Particulars.',
      bodyAr:
        'تدفع المنظمة مبلغ {{salary}} {{paymentFrequency}}. ويُحدَّد أجر خارج الموسم والمكافآت وأي حصة من الإيرادات في بيانات العقد.',
    },
    {
      key: 'bonuses',
      required: false,
      titleEn: 'Bonuses and revenue share',
      titleAr: 'المكافآت وحصة الإيرادات',
      bodyEn:
        'Bonuses, conditional payments and revenue shares listed in the Contract Particulars are payable only when their stated conditions are met.',
      bodyAr:
        'تُستحق المكافآت والمدفوعات المشروطة وحصص الإيرادات المذكورة في بيانات العقد عند تحقق شروطها المحددة فقط.',
    },
    {
      key: 'conduct',
      required: false,
      titleEn: 'Conduct',
      titleAr: 'السلوك',
      bodyEn: `The ${p.en} will follow the Organization’s code of conduct, tournament rules and the integrity rules of the competitions entered.`,
      bodyAr: `يلتزم ${p.ar} بقواعد السلوك المعتمدة لدى المنظمة وأنظمة البطولات وقواعد النزاهة في المسابقات التي تشارك فيها المنظمة.`,
    },
  ];
  if (type === 'player') {
    list.push({
      key: 'content',
      required: false,
      titleEn: 'Content and sponsor activities',
      titleAr: 'أنشطة المحتوى والرعاة',
      bodyEn:
        'The Player agrees to take part in reasonable content, streaming and sponsor activities arranged by the Organization, as further described in the Contract Particulars.',
      bodyAr:
        'يوافق اللاعب على المشاركة في أنشطة المحتوى والبث والرعاة التي ترتّبها المنظمة بشكل معقول، وفق ما تبيّنه بيانات العقد.',
    });
  }
  list.push(
    {
      key: 'confidentiality',
      required: false,
      titleEn: 'Confidentiality',
      titleAr: 'السرية',
      bodyEn:
        'Both parties will keep confidential the terms of this contract and any non-public information about the other party, except where disclosure is required by law.',
      bodyAr:
        'يلتزم الطرفان بالحفاظ على سرية شروط هذا العقد وأي معلومات غير معلنة تخص الطرف الآخر، إلا إذا تطلّب القانون الإفصاح عنها.',
    },
    {
      key: 'termination',
      required: true,
      titleEn: 'Termination and buyout',
      titleAr: 'الإنهاء ومبلغ فسخ العقد',
      bodyEn:
        'This contract may be ended under the termination conditions and, where applicable, the buyout terms set out in the Contract Particulars.',
      bodyAr:
        'يجوز إنهاء هذا العقد وفق شروط الإنهاء المبيّنة في بيانات العقد، ووفق شروط مبلغ فسخ العقد عند الاقتضاء.',
    },
  );
  if (type === 'player') {
    list.push({
      key: 'guardian',
      required: false,
      titleEn: 'Players under 18',
      titleAr: 'اللاعبون دون الثامنة عشرة',
      bodyEn:
        'If the Player is under 18 when this contract is signed, it also requires the signature of the Player’s parent or legal guardian.',
      bodyAr:
        'إذا كان اللاعب دون الثامنة عشرة عند توقيع هذا العقد، فيلزم أيضًا توقيع والده أو وليّ أمره.',
    });
  }
  list.push(
    {
      key: 'amendments',
      required: false,
      titleEn: 'Changes to this contract',
      titleAr: 'تعديل العقد',
      bodyEn:
        'Changes to this contract are valid only if made in writing and agreed by both parties.',
      bodyAr: 'لا يُعتد بأي تعديل على هذا العقد ما لم يكن مكتوبًا ومتفقًا عليه من الطرفين.',
    },
    {
      key: 'governing_law',
      required: false,
      titleEn: 'Governing law and disputes',
      titleAr: 'القانون الواجب التطبيق والنزاعات',
      bodyEn: '[To be completed after legal review.]',
      bodyAr: '[يُستكمل بعد المراجعة القانونية.]',
    },
  );
  return list;
}

export const DEFAULT_CONTRACT_TYPES: DefaultContractType[] = [
  { key: 'player', nameEn: 'Player contract', nameAr: 'عقد لاعب', clauses: clausesFor('player') },
  { key: 'coach', nameEn: 'Coach contract', nameAr: 'عقد مدرب', clauses: clausesFor('coach') },
  {
    key: 'manager',
    nameEn: 'Manager contract',
    nameAr: 'عقد مدير',
    clauses: clausesFor('manager'),
  },
  { key: 'staff', nameEn: 'Staff contract', nameAr: 'عقد موظف', clauses: clausesFor('staff') },
];
