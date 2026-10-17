/**
 * Fixed vocabularies for the accounting module. Stored as these exact keys in the database;
 * labels live in ./i18n.ts so the dashboard and every export use the same words.
 */

/** Expense categories from the implementation brief §6.2. */
export const EXPENSE_CATEGORIES = [
  'salary_player',
  'salary_coach',
  'salary_manager',
  'salary_staff',
  'bonus',
  'bootcamp_facility',
  'accommodation_food_transport',
  'flights_travel',
  'visas',
  'tournament_fees',
  'equipment_operational',
  'other_expense',
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

/** Salary categories are treated as payroll when deriving scenario starting points. */
export const SALARY_CATEGORIES: readonly ExpenseCategory[] = [
  'salary_player',
  'salary_coach',
  'salary_manager',
  'salary_staff',
];

/** Revenue categories from §6.3. Sponsorship has fixed-fee and revenue-share variants. */
export const REVENUE_CATEGORIES = [
  'prize_money',
  'sponsorship_fixed',
  'sponsorship_revenue_share',
  'media_streaming_share',
  'merchandising',
  'brand_content_deal',
  'other_revenue',
] as const;
export type RevenueCategory = (typeof REVENUE_CATEGORIES)[number];

export const RECURRENCES = ['one_time', 'recurring'] as const;
export type Recurrence = (typeof RECURRENCES)[number];

/** Rental vs owned / one-time purchase (§6.2), relevant for equipment and facilities. */
export const OWNERSHIP_TYPES = ['rental', 'owned'] as const;
export type OwnershipType = (typeof OWNERSHIP_TYPES)[number];

/** Revenue certainty (§6.3). Uncertain revenue is never counted as realized. */
export const CERTAINTIES = ['certain', 'uncertain'] as const;
export type Certainty = (typeof CERTAINTIES)[number];

export const PAY_FREQUENCIES = [
  'weekly',
  'biweekly',
  'semimonthly',
  'monthly',
  'quarterly',
  'annually',
  'per_event',
  'one_time',
] as const;
export type PayFrequency = (typeof PAY_FREQUENCIES)[number];

export const ROSTER_ROLES = [
  'starter',
  'substitute',
  'head_coach',
  'assistant_coach',
  'analyst',
  'manager',
  'staff',
] as const;
export type RosterRole = (typeof ROSTER_ROLES)[number];

/** Which salary category a roster role's pay belongs to (used when recording payroll). */
export const ROSTER_ROLE_SALARY_CATEGORY: Record<RosterRole, ExpenseCategory> = {
  starter: 'salary_player',
  substitute: 'salary_player',
  head_coach: 'salary_coach',
  assistant_coach: 'salary_coach',
  analyst: 'salary_staff',
  manager: 'salary_manager',
  staff: 'salary_staff',
};

export const TOURNAMENT_STATUSES = [
  'researching',
  'planned',
  'registered',
  'competing',
  'completed',
  'declined',
] as const;
export type TournamentStatus = (typeof TOURNAMENT_STATUSES)[number];

export interface CurrencyInfo {
  code: string;
  /** Digits after the decimal point (ISO 4217 minor units). */
  minorUnits: number;
  /** ISO 3166 alpha-2 country (or EU) used to show a flag. */
  flag: string;
  nameEn: string;
  nameAr: string;
}

/**
 * Currencies an organization can enable. USD and SAR are enabled by default (§5). The list can
 * grow freely; the exchange-rate provider must support a currency for automatic rates, otherwise
 * rates are typed in manually on each transaction.
 */
export const CURRENCIES: CurrencyInfo[] = [
  { code: 'USD', minorUnits: 2, flag: 'US', nameEn: 'US dollar', nameAr: 'دولار أمريكي' },
  { code: 'SAR', minorUnits: 2, flag: 'SA', nameEn: 'Saudi riyal', nameAr: 'ريال سعودي' },
  { code: 'AED', minorUnits: 2, flag: 'AE', nameEn: 'UAE dirham', nameAr: 'درهم إماراتي' },
  { code: 'KWD', minorUnits: 3, flag: 'KW', nameEn: 'Kuwaiti dinar', nameAr: 'دينار كويتي' },
  { code: 'QAR', minorUnits: 2, flag: 'QA', nameEn: 'Qatari riyal', nameAr: 'ريال قطري' },
  { code: 'BHD', minorUnits: 3, flag: 'BH', nameEn: 'Bahraini dinar', nameAr: 'دينار بحريني' },
  { code: 'OMR', minorUnits: 3, flag: 'OM', nameEn: 'Omani rial', nameAr: 'ريال عماني' },
  { code: 'EGP', minorUnits: 2, flag: 'EG', nameEn: 'Egyptian pound', nameAr: 'جنيه مصري' },
  { code: 'JOD', minorUnits: 3, flag: 'JO', nameEn: 'Jordanian dinar', nameAr: 'دينار أردني' },
  { code: 'MAD', minorUnits: 2, flag: 'MA', nameEn: 'Moroccan dirham', nameAr: 'درهم مغربي' },
  { code: 'TRY', minorUnits: 2, flag: 'TR', nameEn: 'Turkish lira', nameAr: 'ليرة تركية' },
  { code: 'EUR', minorUnits: 2, flag: 'EU', nameEn: 'Euro', nameAr: 'يورو' },
  { code: 'GBP', minorUnits: 2, flag: 'GB', nameEn: 'British pound', nameAr: 'جنيه إسترليني' },
  { code: 'CHF', minorUnits: 2, flag: 'CH', nameEn: 'Swiss franc', nameAr: 'فرنك سويسري' },
  { code: 'SEK', minorUnits: 2, flag: 'SE', nameEn: 'Swedish krona', nameAr: 'كرونة سويدية' },
  { code: 'DKK', minorUnits: 2, flag: 'DK', nameEn: 'Danish krone', nameAr: 'كرونة دنماركية' },
  { code: 'NOK', minorUnits: 2, flag: 'NO', nameEn: 'Norwegian krone', nameAr: 'كرونة نرويجية' },
  { code: 'PLN', minorUnits: 2, flag: 'PL', nameEn: 'Polish złoty', nameAr: 'زلوتي بولندي' },
  { code: 'CAD', minorUnits: 2, flag: 'CA', nameEn: 'Canadian dollar', nameAr: 'دولار كندي' },
  { code: 'BRL', minorUnits: 2, flag: 'BR', nameEn: 'Brazilian real', nameAr: 'ريال برازيلي' },
  { code: 'JPY', minorUnits: 0, flag: 'JP', nameEn: 'Japanese yen', nameAr: 'ين ياباني' },
  { code: 'KRW', minorUnits: 0, flag: 'KR', nameEn: 'South Korean won', nameAr: 'وون كوري جنوبي' },
  { code: 'CNY', minorUnits: 2, flag: 'CN', nameEn: 'Chinese yuan', nameAr: 'يوان صيني' },
  { code: 'SGD', minorUnits: 2, flag: 'SG', nameEn: 'Singapore dollar', nameAr: 'دولار سنغافوري' },
  { code: 'INR', minorUnits: 2, flag: 'IN', nameEn: 'Indian rupee', nameAr: 'روبية هندية' },
  { code: 'PKR', minorUnits: 2, flag: 'PK', nameEn: 'Pakistani rupee', nameAr: 'روبية باكستانية' },
  {
    code: 'IDR',
    minorUnits: 2,
    flag: 'ID',
    nameEn: 'Indonesian rupiah',
    nameAr: 'روبية إندونيسية',
  },
  { code: 'PHP', minorUnits: 2, flag: 'PH', nameEn: 'Philippine peso', nameAr: 'بيزو فلبيني' },
  { code: 'AUD', minorUnits: 2, flag: 'AU', nameEn: 'Australian dollar', nameAr: 'دولار أسترالي' },
];

export const CURRENCY_CODES = CURRENCIES.map((c) => c.code);
/**
 * New organizations report in SAR (the first tenant is Saudi-based; salaries and local costs are
 * in riyals) with USD enabled alongside for prize money and foreign deals. Owners can change the
 * reporting currency until the first finance record exists. Decided 17 Oct 2026 (DECISIONS.md).
 */
export const DEFAULT_ENABLED_CURRENCIES = ['SAR', 'USD'];
export const DEFAULT_BASE_CURRENCY = 'SAR';

export function currencyInfo(code: string): CurrencyInfo {
  const c = CURRENCIES.find((x) => x.code === code);
  if (!c) throw new Error(`Unknown currency ${code}`);
  return c;
}
