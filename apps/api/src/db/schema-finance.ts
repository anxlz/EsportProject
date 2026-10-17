/**
 * Phase 2 schema: rosters, tournament research, seasons, the finance ledger, budgets, scenarios
 * and cached exchange rates. Same rules as Phase 1: `app` schema, RLS on, composite
 * (organization_id, id) foreign keys so cross-tenant references are impossible.
 *
 * Money columns are NUMERIC (exact), read and written as decimal strings.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  jsonb,
  numeric,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { appSchema, games, organizations, teams, users } from './schema';

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => tstz('created_at').notNull().defaultNow();
const updatedAt = () => tstz('updated_at').notNull().defaultNow();
const amount = (name: string) => numeric(name, { precision: 18, scale: 4 });
const day = (name: string) => date(name, { mode: 'string' });

/**
 * Exchange rates fetched from the provider, shared by all tenants (public market data).
 * `rate` means 1 unit of `base` = `rate` units of `quote`. Cached by the date REQUESTED; the
 * provider may answer with the previous trading day, recorded in `rate_date`.
 */
export const fxRates = appSchema.table(
  'fx_rates',
  {
    source: text('source').notNull(),
    base: text('base').notNull(),
    quote: text('quote').notNull(),
    requestedDate: day('requested_date').notNull(),
    rateDate: day('rate_date').notNull(),
    rate: numeric('rate', { precision: 24, scale: 12 }).notNull(),
    fetchedAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: 'fx_rates_pk', columns: [t.source, t.base, t.quote, t.requestedDate] }),
  ],
);

export const seasons = appSchema.table(
  'seasons',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    startDate: day('start_date').notNull(),
    endDate: day('end_date').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('seasons_org_id_unique').on(t.organizationId, t.id),
    check('seasons_dates', sql`${t.startDate} <= ${t.endDate}`),
  ],
);

export const rosterMembers = appSchema.table(
  'roster_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    teamId: uuid('team_id').notNull(),
    fullName: text('full_name').notNull(),
    handle: text('handle'),
    role: text('role').notNull(),
    position: text('position'),
    nationality: text('nationality'),
    /** Needed later for minor-player guardian consent (Phase 4). */
    dateOfBirth: day('date_of_birth'),
    email: text('email'),
    phone: text('phone'),
    joinedOn: day('joined_on'),
    leftOn: day('left_on'),
    active: boolean('active').notNull().default(true),
    notes: text('notes'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('roster_members_org_id_unique').on(t.organizationId, t.id),
    unique('roster_members_org_team_id_unique').on(t.organizationId, t.teamId, t.id),
    index('roster_members_team_idx').on(t.organizationId, t.teamId),
    foreignKey({
      name: 'roster_members_team_fk',
      columns: [t.organizationId, t.teamId],
      foreignColumns: [teams.organizationId, teams.id],
    }).onDelete('restrict'),
  ],
);

/** Pay terms, kept apart from the roster record because they are finance-sensitive. */
export const rosterCompensation = appSchema.table(
  'roster_compensation',
  {
    rosterMemberId: uuid('roster_member_id')
      .primaryKey()
      .references(() => rosterMembers.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').notNull(),
    currency: text('currency').notNull(),
    amount: amount('amount').notNull(),
    offSeasonAmount: amount('off_season_amount'),
    frequency: text('frequency').notNull(),
    contractStart: day('contract_start'),
    contractEnd: day('contract_end'),
    signingBonus: amount('signing_bonus'),
    notes: text('notes'),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'roster_compensation_member_fk',
      columns: [t.organizationId, t.rosterMemberId],
      foreignColumns: [rosterMembers.organizationId, rosterMembers.id],
    }).onDelete('cascade'),
  ],
);

export interface StoredPlacementReward {
  placement: string;
  amount: string;
  currency: string;
}

/** Manual-entry tournament research (no scraping or paid API — brief §6.5). */
export const tournaments = appSchema.table(
  'tournaments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    organizer: text('organizer'),
    gameId: uuid('game_id'),
    region: text('region'),
    startDate: day('start_date'),
    endDate: day('end_date'),
    status: text('status').notNull().default('researching'),
    eligibility: text('eligibility'),
    qualification: text('qualification'),
    entryFeeAmount: amount('entry_fee_amount'),
    entryFeeCurrency: text('entry_fee_currency'),
    prizePoolAmount: amount('prize_pool_amount'),
    prizePoolCurrency: text('prize_pool_currency'),
    placementRewards: jsonb('placement_rewards')
      .$type<StoredPlacementReward[]>()
      .notNull()
      .default([]),
    travelRequirements: text('travel_requirements'),
    historicalResults: text('historical_results'),
    sponsorCoverage: text('sponsor_coverage'),
    sourceUrl: text('source_url'),
    lastVerifiedOn: day('last_verified_on'),
    notes: text('notes'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('tournaments_org_id_unique').on(t.organizationId, t.id),
    foreignKey({
      name: 'tournaments_game_fk',
      columns: [t.organizationId, t.gameId],
      foreignColumns: [games.organizationId, games.id],
    }).onDelete('restrict'),
  ],
);

export const tournamentTeams = appSchema.table(
  'tournament_teams',
  {
    organizationId: uuid('organization_id').notNull(),
    tournamentId: uuid('tournament_id').notNull(),
    teamId: uuid('team_id').notNull(),
  },
  (t) => [
    primaryKey({ name: 'tournament_teams_pk', columns: [t.tournamentId, t.teamId] }),
    foreignKey({
      name: 'tournament_teams_tournament_fk',
      columns: [t.organizationId, t.tournamentId],
      foreignColumns: [tournaments.organizationId, tournaments.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'tournament_teams_team_fk',
      columns: [t.organizationId, t.teamId],
      foreignColumns: [teams.organizationId, teams.id],
    }).onDelete('cascade'),
  ],
);

/**
 * The ledger: costs (kind = expense) and revenue (kind = revenue) in one table.
 * Scope hierarchy: organization-wide (team null) → team → player (team + roster member). A
 * composite FK on (organization_id, team_id, roster_member_id) makes the database reject a
 * player-level entry whose player is not on that team.
 * The exchange rate to the reporting currency is SNAPSHOTTED on every row with its date and
 * source; `base_amount` is computed once from it and never silently recomputed.
 */
export const financeEntries = appSchema.table(
  'finance_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['expense', 'revenue'] }).notNull(),
    teamId: uuid('team_id'),
    rosterMemberId: uuid('roster_member_id'),
    tournamentId: uuid('tournament_id'),
    seasonId: uuid('season_id'),
    category: text('category').notNull(),
    description: text('description'),
    entryDate: day('entry_date').notNull(),
    amount: amount('amount').notNull(),
    currency: text('currency').notNull(),
    fxRate: numeric('fx_rate', { precision: 24, scale: 12 }).notNull(),
    fxRateDate: day('fx_rate_date'),
    fxSource: text('fx_source', { enum: ['same_currency', 'provider', 'manual'] }).notNull(),
    baseCurrency: text('base_currency').notNull(),
    baseAmount: amount('base_amount').notNull(),
    recurrence: text('recurrence').notNull().default('one_time'),
    ownership: text('ownership'),
    realized: boolean('realized').notNull().default(true),
    certainty: text('certainty'),
    counterparty: text('counterparty'),
    /** Inert (brief §6.7): stored for the accountant, never calculated or summed. */
    taxAmount: amount('tax_amount'),
    taxJurisdiction: text('tax_jurisdiction'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('finance_entries_org_id_unique').on(t.organizationId, t.id),
    index('finance_entries_org_date_idx').on(t.organizationId, t.entryDate),
    index('finance_entries_team_idx').on(t.organizationId, t.teamId),
    index('finance_entries_tournament_idx').on(t.organizationId, t.tournamentId),
    index('finance_entries_season_idx').on(t.organizationId, t.seasonId),
    check(
      'finance_entries_player_needs_team',
      sql`${t.rosterMemberId} is null or ${t.teamId} is not null`,
    ),
    check(
      'finance_entries_kind_fields',
      sql`(${t.kind} = 'expense' and ${t.realized} and ${t.certainty} is null)
       or (${t.kind} = 'revenue' and ${t.certainty} is not null and ${t.ownership} is null)`,
    ),
    check('finance_entries_amount_positive', sql`${t.amount} > 0`),
    foreignKey({
      name: 'finance_entries_team_fk',
      columns: [t.organizationId, t.teamId],
      foreignColumns: [teams.organizationId, teams.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'finance_entries_member_fk',
      columns: [t.organizationId, t.teamId, t.rosterMemberId],
      foreignColumns: [rosterMembers.organizationId, rosterMembers.teamId, rosterMembers.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'finance_entries_tournament_fk',
      columns: [t.organizationId, t.tournamentId],
      foreignColumns: [tournaments.organizationId, tournaments.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'finance_entries_season_fk',
      columns: [t.organizationId, t.seasonId],
      foreignColumns: [seasons.organizationId, seasons.id],
    }).onDelete('restrict'),
  ],
);

/** Planned spend per team / tournament / season (any combination), in the reporting currency. */
export const budgets = appSchema.table(
  'budgets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    teamId: uuid('team_id'),
    tournamentId: uuid('tournament_id'),
    seasonId: uuid('season_id'),
    periodStart: day('period_start'),
    periodEnd: day('period_end'),
    currency: text('currency').notNull(),
    total: amount('total').notNull(),
    notes: text('notes'),
    /** Alert de-duplication: true once the "over budget" notification has been sent. */
    totalOverAlerted: boolean('total_over_alerted').notNull().default(false),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('budgets_org_id_unique').on(t.organizationId, t.id),
    foreignKey({
      name: 'budgets_team_fk',
      columns: [t.organizationId, t.teamId],
      foreignColumns: [teams.organizationId, teams.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'budgets_tournament_fk',
      columns: [t.organizationId, t.tournamentId],
      foreignColumns: [tournaments.organizationId, tournaments.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'budgets_season_fk',
      columns: [t.organizationId, t.seasonId],
      foreignColumns: [seasons.organizationId, seasons.id],
    }).onDelete('restrict'),
  ],
);

export const budgetLines = appSchema.table(
  'budget_lines',
  {
    budgetId: uuid('budget_id')
      .notNull()
      .references(() => budgets.id, { onDelete: 'cascade' }),
    category: text('category').notNull(),
    amount: amount('amount').notNull(),
    overAlerted: boolean('over_alerted').notNull().default(false),
  },
  (t) => [primaryKey({ name: 'budget_lines_pk', columns: [t.budgetId, t.category] })],
);

/** User-edited scenario inputs, one set per report scope. */
export const financeScenarios = appSchema.table(
  'finance_scenarios',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    scopeKind: text('scope_kind').notNull(),
    scopeId: uuid('scope_id'),
    scenarios: jsonb('scenarios').$type<Record<string, unknown>>().notNull(),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('finance_scenarios_scope_unique')
      .on(t.organizationId, t.scopeKind, t.scopeId)
      .nullsNotDistinct(),
  ],
);
