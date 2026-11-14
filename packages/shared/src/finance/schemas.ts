/** Request schemas for Phase 2 (rosters, tournaments, finance). Enforced by the API. */
import { z } from 'zod';
import {
  CERTAINTIES,
  CURRENCY_CODES,
  EXPENSE_CATEGORIES,
  OWNERSHIP_TYPES,
  PAY_FREQUENCIES,
  RECURRENCES,
  REVENUE_CATEGORIES,
  ROSTER_ROLES,
  TOURNAMENT_STATUSES,
} from './catalog.js';
import { SCENARIO_NAMES } from './report.js';

const text = (max: number) => z.string().trim().max(max);
const optText = (max: number) => text(max).nullable().optional();

export const isoDateSchema = z.iso.date();
export const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month_format');
export const currencySchema = z.enum(CURRENCY_CODES as [string, ...string[]]);

/** Positive decimal string, up to 14 integer and 4 fractional digits. */
export const amountSchema = z
  .string()
  .trim()
  .regex(/^\d{1,14}(\.\d{1,4})?$/, 'amount_format')
  .refine((v) => Number(v) > 0, 'amount_positive');
/** Same, but zero allowed (scenario inputs, budgets lines are still positive). */
export const nonNegativeAmountSchema = z
  .string()
  .trim()
  .regex(/^\d{1,14}(\.\d{1,4})?$/, 'amount_format');
/** Exchange rate: base-currency units per 1 unit of the transaction currency. */
export const rateSchema = z
  .string()
  .trim()
  .regex(/^\d{1,8}(\.\d{1,12})?$/, 'rate_format')
  .refine((v) => Number(v) > 0, 'rate_positive');

const uuid = z.uuid();
const optUuid = uuid.nullable().optional();
const httpUrl = z
  .url()
  .max(2000)
  .refine((u) => /^https?:\/\//i.test(u), 'url_scheme');

// ---------- Settings & seasons ----------

export const updateFinanceSettingsSchema = z
  .object({
    baseCurrency: currencySchema.optional(),
    enabledCurrencies: z.array(currencySchema).min(1).max(40).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'empty_update');

export const seasonInputSchema = z
  .object({ name: text(120).min(1), startDate: isoDateSchema, endDate: isoDateSchema })
  .refine((s) => s.startDate <= s.endDate, 'season_dates');

// ---------- Rosters ----------

export const compensationSchema = z
  .object({
    currency: currencySchema,
    amount: amountSchema,
    /** Pay outside configured seasons. Omit to use the same amount all year. */
    offSeasonAmount: amountSchema.nullable().optional(),
    frequency: z.enum(PAY_FREQUENCIES),
    contractStart: isoDateSchema.nullable().optional(),
    contractEnd: isoDateSchema.nullable().optional(),
    signingBonus: amountSchema.nullable().optional(),
    notes: optText(1000),
  })
  .refine(
    (c) => !c.contractStart || !c.contractEnd || c.contractStart <= c.contractEnd,
    'contract_dates',
  );
export type CompensationInput = z.infer<typeof compensationSchema>;

const rosterFields = {
  fullName: text(160).min(1),
  handle: optText(80),
  role: z.enum(ROSTER_ROLES),
  position: optText(80),
  nationality: optText(80),
  dateOfBirth: isoDateSchema.nullable().optional(),
  email: z.email().max(254).nullable().optional(),
  phone: optText(40),
  joinedOn: isoDateSchema.nullable().optional(),
  leftOn: isoDateSchema.nullable().optional(),
  active: z.boolean().optional(),
  notes: optText(2000),
  compensation: compensationSchema.nullable().optional(),
};

export const rosterMemberCreateSchema = z.object({ teamId: uuid, ...rosterFields });
export type RosterMemberCreateInput = z.infer<typeof rosterMemberCreateSchema>;
export const rosterMemberUpdateSchema = z
  .object({
    teamId: uuid.optional(),
    ...rosterFields,
    fullName: text(160).min(1).optional(),
    role: z.enum(ROSTER_ROLES).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'empty_update');
export type RosterMemberUpdateInput = z.infer<typeof rosterMemberUpdateSchema>;

// ---------- Tournaments (manual research) ----------

export const placementRewardSchema = z.object({
  placement: text(40).min(1),
  amount: amountSchema,
  currency: currencySchema,
});

export const tournamentInputSchema = z
  .object({
    name: text(200).min(1),
    organizer: optText(200),
    gameId: optUuid,
    region: optText(80),
    startDate: isoDateSchema.nullable().optional(),
    endDate: isoDateSchema.nullable().optional(),
    status: z.enum(TOURNAMENT_STATUSES).default('researching'),
    eligibility: optText(4000),
    qualification: optText(4000),
    entryFeeAmount: amountSchema.nullable().optional(),
    entryFeeCurrency: currencySchema.nullable().optional(),
    prizePoolAmount: amountSchema.nullable().optional(),
    prizePoolCurrency: currencySchema.nullable().optional(),
    placementRewards: z.array(placementRewardSchema).max(64).optional(),
    travelRequirements: optText(4000),
    historicalResults: optText(8000),
    sponsorCoverage: optText(4000),
    /** Where this information came from (brief §6.5). */
    sourceUrl: httpUrl.nullable().optional(),
    /** When someone last checked it against the source. */
    lastVerifiedOn: isoDateSchema.nullable().optional(),
    notes: optText(4000),
    teamIds: z.array(uuid).max(50).optional(),
  })
  .refine((t) => !t.startDate || !t.endDate || t.startDate <= t.endDate, 'tournament_dates')
  .refine((t) => !t.entryFeeAmount || !!t.entryFeeCurrency, 'entry_fee_currency')
  .refine((t) => !t.prizePoolAmount || !!t.prizePoolCurrency, 'prize_pool_currency');
export type TournamentInput = z.infer<typeof tournamentInputSchema>;

// ---------- Ledger (expenses & revenue) ----------

const ledgerCommon = {
  /** Scope hierarchy: none = organization-wide; team; team + roster member (player level). */
  teamId: optUuid,
  rosterMemberId: optUuid,
  tournamentId: optUuid,
  /** Assigned automatically from the date when omitted. */
  seasonId: optUuid,
  description: optText(500),
  date: isoDateSchema,
  amount: amountSchema,
  currency: currencySchema,
  /** Manual exchange rate override. Omit to use the stored/provider rate for `date`. */
  rate: rateSchema.nullable().optional(),
  recurrence: z.enum(RECURRENCES).default('one_time'),
  /** Recorded for your accountant only. Never calculated, never included in totals (§6.7). */
  taxAmount: nonNegativeAmountSchema.nullable().optional(),
  taxJurisdiction: optText(80),
};

const hierarchy = (v: { teamId?: string | null; rosterMemberId?: string | null }) =>
  !v.rosterMemberId || !!v.teamId;

export const expenseInputSchema = z
  .object({
    ...ledgerCommon,
    category: z.enum(EXPENSE_CATEGORIES),
    ownership: z.enum(OWNERSHIP_TYPES).nullable().optional(),
  })
  .refine(hierarchy, 'player_requires_team');
export type ExpenseInput = z.infer<typeof expenseInputSchema>;

export const revenueInputSchema = z
  .object({
    ...ledgerCommon,
    category: z.enum(REVENUE_CATEGORIES),
    counterparty: optText(200),
    /** Received (counts in realized totals) or still expected (projection only). */
    realized: z.boolean(),
    certainty: z.enum(CERTAINTIES),
  })
  .refine(hierarchy, 'player_requires_team');
export type RevenueInput = z.infer<typeof revenueInputSchema>;

export const ledgerQuerySchema = z.object({
  teamId: z.union([uuid, z.literal('none')]).optional(),
  rosterMemberId: uuid.optional(),
  tournamentId: uuid.optional(),
  seasonId: uuid.optional(),
  category: z.string().max(60).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---------- Budgets ----------

export const budgetInputSchema = z
  .object({
    name: text(160).min(1),
    teamId: optUuid,
    tournamentId: optUuid,
    seasonId: optUuid,
    periodStart: isoDateSchema.nullable().optional(),
    periodEnd: isoDateSchema.nullable().optional(),
    /** Planned total in the reporting currency. */
    total: amountSchema,
    lines: z
      .array(z.object({ category: z.enum(EXPENSE_CATEGORIES), amount: amountSchema }))
      .max(EXPENSE_CATEGORIES.length)
      .optional(),
    notes: optText(2000),
  })
  .refine((b) => !b.periodStart || !b.periodEnd || b.periodStart <= b.periodEnd, 'budget_dates')
  .refine(
    (b) => new Set((b.lines ?? []).map((l) => l.category)).size === (b.lines ?? []).length,
    'duplicate_category',
  );
export type BudgetInput = z.infer<typeof budgetInputSchema>;

// ---------- Reports, scenarios, exports ----------

export const reportQuerySchema = z
  .object({
    scope: z.enum(['organization', 'team', 'tournament', 'season']),
    scopeId: uuid.optional(),
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
    rateMode: z.enum(['snapshot', 'current']).default('snapshot'),
  })
  .refine((q) => (q.scope === 'organization' ? !q.scopeId : !!q.scopeId), 'scope_id_mismatch')
  .refine((q) => !q.from || !q.to || q.from <= q.to, 'report_dates');
export type ReportQuery = z.infer<typeof reportQuerySchema>;

export const scenarioInputsSchema = z.object({
  monthlyRevenue: nonNegativeAmountSchema,
  monthlyCost: nonNegativeAmountSchema,
  oneOffRevenue: nonNegativeAmountSchema,
  oneOffCost: nonNegativeAmountSchema,
  horizonMonths: z.number().int().min(1).max(120),
});
export const scenarioSetSchema = z.object(
  Object.fromEntries(SCENARIO_NAMES.map((n) => [n, scenarioInputsSchema])) as Record<
    (typeof SCENARIO_NAMES)[number],
    typeof scenarioInputsSchema
  >,
);

export const saveScenariosSchema = z.object({
  scope: z.enum(['organization', 'team', 'tournament', 'season']),
  scopeId: uuid.nullable().optional(),
  scenarios: scenarioSetSchema,
});

export const EXPORT_FORMATS = ['pdf', 'csv', 'xlsx', 'txt'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const reportExportSchema = z.object({
  query: reportQuerySchema,
  /** The scenario inputs currently on screen, so the export matches exactly. */
  scenarios: scenarioSetSchema.optional(),
  format: z.enum(EXPORT_FORMATS),
  locale: z.enum(['ar', 'en']).default('en'),
});
export type ReportExportInput = z.infer<typeof reportExportSchema>;

export const rateLookupSchema = z.object({ currency: currencySchema, date: isoDateSchema });
