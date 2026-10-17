/**
 * Finance vocabulary and report footnotes in Arabic and English.
 *
 * Kept in the shared package (not only in the web app's message files) because the server-side
 * exports (PDF, CSV, XLSX, TXT) must use exactly the same words and footnotes as the dashboard.
 * Footnotes state what every number includes and excludes (brief §6.6).
 */
import type { FootnoteKey, ScenarioName, ScenarioOutcome, ScopeKind } from './report';

export type FinanceLocale = 'ar' | 'en';

type Dict = Record<string, string>;

const en = {
  category: {
    salary_player: 'Player salaries',
    salary_coach: 'Coach salaries',
    salary_manager: 'Manager salaries',
    salary_staff: 'Staff salaries',
    bonus: 'Bonuses and conditional payments',
    bootcamp_facility: 'Bootcamps and training facilities',
    accommodation_food_transport: 'Accommodation, food and local transport',
    flights_travel: 'Flights and travel',
    visas: 'Visas',
    tournament_fees: 'Tournament registration and entry fees',
    equipment_operational: 'Equipment and operations',
    other_expense: 'Other costs',
    prize_money: 'Prize money',
    sponsorship_fixed: 'Sponsorship (fixed fee)',
    sponsorship_revenue_share: 'Sponsorship (revenue share)',
    media_streaming_share: 'Media and streaming revenue share',
    merchandising: 'Merchandising',
    brand_content_deal: 'Brand and content deals',
    other_revenue: 'Other revenue',
  } as Dict,
  recurrence: { one_time: 'One-time', recurring: 'Recurring' } as Dict,
  ownership: { rental: 'Rental', owned: 'Owned / one-time purchase' } as Dict,
  certainty: { certain: 'Certain (contracted)', uncertain: 'Uncertain' } as Dict,
  payFrequency: {
    weekly: 'Weekly',
    biweekly: 'Every two weeks',
    semimonthly: 'Twice a month',
    monthly: 'Monthly',
    quarterly: 'Quarterly',
    annually: 'Yearly',
    per_event: 'Per event',
    one_time: 'One-time',
  } as Dict,
  rosterRole: {
    starter: 'Starter',
    substitute: 'Substitute',
    head_coach: 'Head coach',
    assistant_coach: 'Assistant coach',
    analyst: 'Analyst',
    manager: 'Manager',
    staff: 'Staff',
  } as Dict,
  tournamentStatus: {
    researching: 'Researching',
    planned: 'Planned',
    registered: 'Registered',
    competing: 'Competing',
    completed: 'Completed',
    declined: 'Declined',
  } as Dict,
  scopeKind: {
    organization: 'Whole organization',
    team: 'Team',
    tournament: 'Tournament',
    season: 'Season',
  } as Record<ScopeKind, string>,
  scenario: { pessimistic: 'Pessimistic', base: 'Base case', optimistic: 'Optimistic' } as Record<
    ScenarioName,
    string
  >,
  outcome: {
    already_covered: 'Already covered',
    reaches_break_even: 'Breaks even within the horizon',
    beyond_horizon: 'Breaks even after the horizon (estimate)',
    never: 'Does not break even with these inputs',
  } as Record<ScenarioOutcome, string>,
  report: {
    title: 'Financial report',
    scope: 'Scope',
    period: 'Period',
    allTime: 'All dates',
    generated: 'As of',
    currency: 'Reporting currency',
    rates: 'Exchange rates',
    rateSnapshot: 'Rate on each transaction date (snapshot)',
    rateCurrent: "Today's rates (for comparison only)",
    summary: 'Summary',
    totalCost: 'Total costs',
    realizedRevenue: 'Realized revenue',
    net: 'Net result (realized revenue − costs)',
    costsByCategory: 'Costs by category',
    revenueByCategory: 'Realized revenue by category',
    byTeam: 'By team',
    noTeam: 'Organization-wide (no team)',
    monthly: 'By month',
    month: 'Month',
    cost: 'Costs',
    revenue: 'Realized revenue',
    monthNet: 'Net',
    cumulative: 'Cumulative net',
    breakEven: 'Break-even and payback (realized)',
    firstCostMonth: 'First month with costs',
    firstBreakEvenMonth: 'First break-even month',
    paybackMonths: 'Payback period (months)',
    currentPosition: 'Current cumulative result',
    revenueNeeded: 'Realized revenue still needed to cover costs so far',
    notReached: 'Not reached yet',
    noCosts: 'No costs recorded',
    projections: 'Projections (not realized — shown separately)',
    certainUnrealized: 'Certain, not yet received',
    uncertainUnrealized: 'Uncertain, not yet received',
    expectedOn: 'Expected on',
    scenarios: 'Scenario modeling',
    monthlyRevenue: 'Monthly revenue',
    monthlyCost: 'Monthly costs',
    oneOffRevenue: 'One-off revenue (month 1)',
    oneOffCost: 'One-off cost (month 1)',
    horizonMonths: 'Horizon (months)',
    startPosition: 'Starting cumulative result',
    monthlyNetInput: 'Monthly net',
    outcome: 'Outcome',
    monthsToBreakEven: 'Months to break even',
    breakEvenMonth: 'Break-even month',
    endPosition: 'Result at end of horizon',
    lowestPosition: 'Lowest point',
    requiredMonthlyRevenue: 'Monthly revenue needed to finish the horizon at break-even',
    transactions: 'Transactions',
    date: 'Date',
    type: 'Type',
    category: 'Category',
    description: 'Description',
    team: 'Team',
    amountOriginal: 'Original amount',
    rate: 'Rate',
    rateDate: 'Rate date',
    amountBase: 'Amount',
    expense: 'Cost',
    revenueRow: 'Revenue',
    status: 'Status',
    realized: 'Realized',
    expected: 'Expected',
    share: 'Share',
    notes: 'Notes',
    none: 'None',
    item: 'Item',
    value: 'Value',
    originalCurrency: 'Original currency',
    expectedItems: 'Expected income',
    total: 'Total',
  },
  footnote: {
    rates_snapshot:
      'Amounts in other currencies are converted with the exchange rate stored on each transaction for its own date. Reopening this report later gives the same numbers.',
    rates_current:
      "Amounts are converted with today's exchange rates, for comparison only. Official figures use the rate stored on each transaction.",
    current_rate_missing:
      "Today's rate is unavailable for {currencies}; those transactions use their stored rate.",
    realized_only:
      'Revenue counts only when it has been received. Expected or uncertain income is never added to realized totals.',
    projections_separate:
      'Projections list income that is expected but not received. They are not part of the realized totals or the break-even figures.',
    break_even_definition:
      'Break-even month: the first month, from the first month with costs, from which cumulative realized revenue minus cumulative costs has stayed at zero or more up to the latest month. Money received up front that later costs use up does not count as break-even.',
    payback_definition:
      'Payback period: months counted inclusively from the first month with costs to the break-even month (costs in January, recovered in March = 3).',
    scenario_definition:
      'Scenarios project the current cumulative result forward with constant monthly revenue and costs; one-off items land in the first projected month. They are assumptions, not predictions.',
    scenario_defaults:
      'Scenario starting values come from your data: monthly costs = payroll projected from roster terms plus average non-salary costs of the last 3 full months (or average total costs when no payroll is set); base and optimistic monthly revenue = average realized revenue of the last 3 full months; pessimistic assumes no new monthly revenue. One-off revenue: certain unreceived income (all scenarios) plus uncertain income (optimistic only).',
    scenario_customized:
      'Scenario inputs were edited by a user and differ from the calculated starting values.',
    payroll_projection:
      'Projected payroll converts each roster member’s pay to a monthly equivalent (weekly ×52/12, every two weeks ×26/12, quarterly ÷3, yearly ÷12) at today’s exchange rate, uses off-season pay outside configured seasons, and excludes per-event and one-time payments.',
    payroll_not_periodic:
      'Projected payroll leaves out pay that is per event or one-time (roster members affected: {count}). Add it to monthly costs if it applies.',
    payroll_no_rate:
      "Projected payroll leaves out pay in {currencies}: today's exchange rate is unavailable. Add those amounts to monthly costs, or try again later.",
    tax_not_calculated:
      'No tax (Zakat, corporate income tax, VAT or withholding) is calculated. Tax amounts entered on transactions are recorded for your accountant only and are not included in any figure.',
    rounding:
      'Amounts are rounded half away from zero to the minor unit of {currency} once, when converted.',
  } as Record<FootnoteKey, string>,
};

const ar: typeof en = {
  category: {
    salary_player: 'رواتب اللاعبين',
    salary_coach: 'رواتب المدربين',
    salary_manager: 'رواتب المديرين',
    salary_staff: 'رواتب الطاقم',
    bonus: 'المكافآت والمدفوعات المشروطة',
    bootcamp_facility: 'المعسكرات ومرافق التدريب',
    accommodation_food_transport: 'السكن والطعام والتنقل المحلي',
    flights_travel: 'الطيران والسفر',
    visas: 'التأشيرات',
    tournament_fees: 'رسوم التسجيل والمشاركة في البطولات',
    equipment_operational: 'المعدات والتشغيل',
    other_expense: 'تكاليف أخرى',
    prize_money: 'جوائز البطولات',
    sponsorship_fixed: 'الرعاية (مبلغ ثابت)',
    sponsorship_revenue_share: 'الرعاية (مشاركة في الإيرادات)',
    media_streaming_share: 'حصة إيرادات الإعلام والبث',
    merchandising: 'المنتجات والبضائع',
    brand_content_deal: 'صفقات العلامات التجارية والمحتوى',
    other_revenue: 'إيرادات أخرى',
  },
  recurrence: { one_time: 'لمرة واحدة', recurring: 'متكرر' },
  ownership: { rental: 'إيجار', owned: 'ملكية / شراء لمرة واحدة' },
  certainty: { certain: 'مؤكد (متعاقد عليه)', uncertain: 'غير مؤكد' },
  payFrequency: {
    weekly: 'أسبوعي',
    biweekly: 'كل أسبوعين',
    semimonthly: 'مرتين في الشهر',
    monthly: 'شهري',
    quarterly: 'ربع سنوي',
    annually: 'سنوي',
    per_event: 'لكل حدث',
    one_time: 'لمرة واحدة',
  },
  rosterRole: {
    starter: 'أساسي',
    substitute: 'احتياطي',
    head_coach: 'المدرب الرئيسي',
    assistant_coach: 'مدرب مساعد',
    analyst: 'محلل',
    manager: 'مدير',
    staff: 'طاقم',
  },
  tournamentStatus: {
    researching: 'قيد البحث',
    planned: 'مخطط لها',
    registered: 'مسجّل',
    competing: 'نشارك حاليًا',
    completed: 'منتهية',
    declined: 'مستبعدة',
  },
  scopeKind: {
    organization: 'المنظمة بأكملها',
    team: 'فريق',
    tournament: 'بطولة',
    season: 'موسم',
  },
  scenario: { pessimistic: 'متشائم', base: 'أساسي', optimistic: 'متفائل' },
  outcome: {
    already_covered: 'مغطّى بالفعل',
    reaches_break_even: 'يبلغ نقطة التعادل خلال الفترة',
    beyond_horizon: 'يبلغ نقطة التعادل بعد الفترة (تقدير)',
    never: 'لا يبلغ نقطة التعادل بهذه المدخلات',
  },
  report: {
    title: 'التقرير المالي',
    scope: 'النطاق',
    period: 'الفترة',
    allTime: 'كل التواريخ',
    generated: 'حتى تاريخ',
    currency: 'عملة التقرير',
    rates: 'أسعار الصرف',
    rateSnapshot: 'سعر تاريخ كل معاملة (مثبّت)',
    rateCurrent: 'أسعار اليوم (للمقارنة فقط)',
    summary: 'الملخص',
    totalCost: 'إجمالي التكاليف',
    realizedRevenue: 'الإيرادات المحققة',
    net: 'صافي النتيجة (الإيرادات المحققة − التكاليف)',
    costsByCategory: 'التكاليف حسب الفئة',
    revenueByCategory: 'الإيرادات المحققة حسب الفئة',
    byTeam: 'حسب الفريق',
    noTeam: 'على مستوى المنظمة (بلا فريق)',
    monthly: 'حسب الشهر',
    month: 'الشهر',
    cost: 'التكاليف',
    revenue: 'الإيرادات المحققة',
    monthNet: 'الصافي',
    cumulative: 'الصافي التراكمي',
    breakEven: 'نقطة التعادل وفترة الاسترداد (محققة)',
    firstCostMonth: 'أول شهر فيه تكاليف',
    firstBreakEvenMonth: 'أول شهر لبلوغ التعادل',
    paybackMonths: 'فترة الاسترداد (بالأشهر)',
    currentPosition: 'النتيجة التراكمية الحالية',
    revenueNeeded: 'الإيرادات المحققة اللازمة لتغطية التكاليف حتى الآن',
    notReached: 'لم يتحقق بعد',
    noCosts: 'لا توجد تكاليف مسجّلة',
    projections: 'التوقعات (غير محققة — معروضة منفصلة)',
    certainUnrealized: 'مؤكدة ولم تُستلم بعد',
    uncertainUnrealized: 'غير مؤكدة ولم تُستلم بعد',
    expectedOn: 'التاريخ المتوقع',
    scenarios: 'نمذجة السيناريوهات',
    monthlyRevenue: 'الإيرادات الشهرية',
    monthlyCost: 'التكاليف الشهرية',
    oneOffRevenue: 'إيراد لمرة واحدة (الشهر الأول)',
    oneOffCost: 'تكلفة لمرة واحدة (الشهر الأول)',
    horizonMonths: 'مدة التوقع (بالأشهر)',
    startPosition: 'النتيجة التراكمية عند البداية',
    monthlyNetInput: 'الصافي الشهري',
    outcome: 'النتيجة',
    monthsToBreakEven: 'الأشهر حتى نقطة التعادل',
    breakEvenMonth: 'شهر التعادل',
    endPosition: 'النتيجة في نهاية المدة',
    lowestPosition: 'أدنى نقطة',
    requiredMonthlyRevenue: 'الإيراد الشهري اللازم لبلوغ التعادل بنهاية المدة',
    transactions: 'المعاملات',
    date: 'التاريخ',
    type: 'النوع',
    category: 'الفئة',
    description: 'الوصف',
    team: 'الفريق',
    amountOriginal: 'المبلغ الأصلي',
    rate: 'السعر',
    rateDate: 'تاريخ السعر',
    amountBase: 'المبلغ',
    expense: 'تكلفة',
    revenueRow: 'إيراد',
    status: 'الحالة',
    realized: 'محقق',
    expected: 'متوقع',
    share: 'النسبة',
    notes: 'ملاحظات',
    none: 'لا يوجد',
    item: 'البند',
    value: 'القيمة',
    originalCurrency: 'العملة الأصلية',
    expectedItems: 'الإيرادات المتوقعة',
    total: 'الإجمالي',
  },
  footnote: {
    rates_snapshot:
      'تُحوَّل المبالغ بالعملات الأخرى بسعر الصرف المحفوظ مع كل معاملة لتاريخها، فيعطي فتح هذا التقرير لاحقًا الأرقام نفسها.',
    rates_current:
      'تُحوَّل المبالغ بأسعار صرف اليوم للمقارنة فقط، أما الأرقام الرسمية فتستخدم السعر المحفوظ مع كل معاملة.',
    current_rate_missing:
      'سعر اليوم غير متاح للعملات {currencies}، لذا تستخدم معاملاتها السعر المحفوظ.',
    realized_only:
      'لا يُحتسب الإيراد إلا بعد استلامه، ولا يُضاف الدخل المتوقع أو غير المؤكد إلى الإجماليات المحققة أبدًا.',
    projections_separate:
      'تعرض التوقعات الدخل المتوقع الذي لم يُستلم بعد، وهي ليست جزءًا من الإجماليات المحققة ولا من أرقام نقطة التعادل.',
    break_even_definition:
      'شهر التعادل: أول شهر، ابتداءً من أول شهر فيه تكاليف، يبقى منه مجموع الإيرادات المحققة التراكمي ناقص التكاليف التراكمية صفرًا أو أكثر حتى آخر شهر. المبالغ المستلمة مقدمًا التي تستهلكها التكاليف لاحقًا لا تُعد تعادلًا.',
    payback_definition:
      'فترة الاسترداد: عدد الأشهر محسوبًا شاملًا من أول شهر فيه تكاليف حتى شهر التعادل (تكاليف في يناير واسترداد في مارس = 3).',
    scenario_definition:
      'تمدّ السيناريوهات النتيجة التراكمية الحالية إلى الأمام بإيرادات وتكاليف شهرية ثابتة، وتُحسب البنود لمرة واحدة في أول شهر متوقع. هي افتراضات وليست تنبؤات.',
    scenario_defaults:
      'القيم الابتدائية للسيناريوهات مأخوذة من بياناتك: التكاليف الشهرية = الرواتب المتوقعة من شروط القائمة مضافًا إليها متوسط التكاليف غير الرواتب في آخر 3 أشهر كاملة (أو متوسط إجمالي التكاليف عند عدم تحديد رواتب)؛ والإيراد الشهري في السيناريو الأساسي والمتفائل = متوسط الإيرادات المحققة في آخر 3 أشهر كاملة؛ ويفترض المتشائم عدم وجود إيراد شهري جديد. الإيراد لمرة واحدة: الدخل المؤكد غير المستلم (كل السيناريوهات) مضافًا إليه الدخل غير المؤكد (المتفائل فقط).',
    scenario_customized:
      'عدّل أحد المستخدمين مدخلات السيناريوهات فأصبحت تختلف عن القيم الابتدائية المحسوبة.',
    payroll_projection:
      'تحوّل الرواتب المتوقعة أجر كل عضو في القائمة إلى ما يعادله شهريًا (الأسبوعي ×52/12، وكل أسبوعين ×26/12، والربع سنوي ÷3، والسنوي ÷12) بسعر صرف اليوم، وتستخدم أجر خارج الموسم خارج المواسم المحددة، وتستبعد المدفوعات لكل حدث أو لمرة واحدة.',
    payroll_not_periodic:
      'تستبعد الرواتب المتوقعة المدفوعات لكل فعالية أو لمرة واحدة (عدد أعضاء القائمة المعنيين: {count}). أضفها إلى التكاليف الشهرية إن كانت تنطبق.',
    payroll_no_rate:
      'تستبعد الرواتب المتوقعة الرواتب بعملة {currencies} لعدم توفر سعر صرف اليوم. أضف هذه المبالغ إلى التكاليف الشهرية أو حاول لاحقًا.',
    tax_not_calculated:
      'لا تُحسب أي ضريبة (الزكاة أو ضريبة الدخل على الشركات أو ضريبة القيمة المضافة أو الاستقطاع). مبالغ الضريبة المُدخلة في المعاملات تُحفظ لمحاسبك فقط ولا تدخل في أي رقم.',
    rounding:
      'تُقرَّب المبالغ إلى أصغر وحدة في {currency} مرة واحدة عند التحويل، والنصف يُقرَّب بعيدًا عن الصفر.',
  },
};

export const FINANCE_LABELS: Record<FinanceLocale, typeof en> = { en, ar };

export function fl(locale: FinanceLocale) {
  return FINANCE_LABELS[locale];
}

export function footnoteText(
  locale: FinanceLocale,
  key: FootnoteKey,
  params: Record<string, string> = {},
): string {
  return FINANCE_LABELS[locale].footnote[key].replace(
    /\{(\w+)\}/g,
    (_, p: string) => params[p] ?? '',
  );
}

export function categoryLabel(locale: FinanceLocale, category: string): string {
  return FINANCE_LABELS[locale].category[category] ?? category;
}
