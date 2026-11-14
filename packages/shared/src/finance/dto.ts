/** Response shapes for Phase 2. Amounts are decimal strings. */
import type {
  Certainty,
  OwnershipType,
  PayFrequency,
  Recurrence,
  RosterRole,
  TournamentStatus,
} from './catalog.js';
import type { BudgetVarianceLine, ScopeKind } from './report.js';

export interface FinanceSettingsDto {
  baseCurrency: string;
  enabledCurrencies: string[];
  /** The reporting currency is locked once any transaction exists. */
  baseCurrencyLocked: boolean;
  fxProvider: 'frankfurter' | 'none';
  /** Attribution text/link to show with provider rates, when the provider asks for one. */
  fxAttribution: { text: string; url: string } | null;
}

export interface SeasonDto {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
}

export interface CompensationDto {
  currency: string;
  amount: string;
  offSeasonAmount: string | null;
  frequency: PayFrequency;
  contractStart: string | null;
  contractEnd: string | null;
  signingBonus: string | null;
  notes: string | null;
}

export interface RosterMemberDto {
  id: string;
  teamId: string;
  fullName: string;
  handle: string | null;
  role: RosterRole;
  position: string | null;
  nationality: string | null;
  dateOfBirth: string | null;
  email: string | null;
  phone: string | null;
  joinedOn: string | null;
  leftOn: string | null;
  active: boolean;
  notes: string | null;
  /** Null when there are no terms. Omitted entirely (undefined) when the caller lacks finance.view. */
  compensation?: CompensationDto | null;
  createdAt: string;
  updatedAt: string;
}

export interface TournamentDto {
  id: string;
  name: string;
  organizer: string | null;
  gameId: string | null;
  gameName: string | null;
  region: string | null;
  startDate: string | null;
  endDate: string | null;
  status: TournamentStatus;
  eligibility: string | null;
  qualification: string | null;
  entryFeeAmount: string | null;
  entryFeeCurrency: string | null;
  prizePoolAmount: string | null;
  prizePoolCurrency: string | null;
  placementRewards: { placement: string; amount: string; currency: string }[];
  travelRequirements: string | null;
  historicalResults: string | null;
  sponsorCoverage: string | null;
  sourceUrl: string | null;
  lastVerifiedOn: string | null;
  notes: string | null;
  teams: { id: string; name: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface LedgerEntryDto {
  id: string;
  kind: 'expense' | 'revenue';
  teamId: string | null;
  teamName: string | null;
  rosterMemberId: string | null;
  rosterMemberName: string | null;
  tournamentId: string | null;
  tournamentName: string | null;
  seasonId: string | null;
  seasonName: string | null;
  category: string;
  description: string | null;
  date: string;
  amount: string;
  currency: string;
  /** Snapshotted rate to the reporting currency and its provenance. */
  rate: string;
  rateDate: string | null;
  rateSource: 'same_currency' | 'provider' | 'manual';
  baseAmount: string;
  baseCurrency: string;
  recurrence: Recurrence;
  ownership: OwnershipType | null;
  /** Revenue only. */
  realized: boolean;
  certainty: Certainty | null;
  counterparty: string | null;
  /** Recorded only; never calculated or summed. */
  taxAmount: string | null;
  taxJurisdiction: string | null;
  createdBy: { id: string; displayName: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface BudgetDto {
  id: string;
  name: string;
  teamId: string | null;
  teamName: string | null;
  tournamentId: string | null;
  tournamentName: string | null;
  seasonId: string | null;
  seasonName: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  currency: string;
  notes: string | null;
  variance: { total: BudgetVarianceLine; lines: BudgetVarianceLine[] };
  /** True when the total or any category line is over plan. */
  over: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RateQuoteDto {
  currency: string;
  baseCurrency: string;
  date: string;
  /** Null when no rate is known for that date: the user must type one in. */
  rate: string | null;
  rateDate: string | null;
  source: 'same_currency' | 'provider' | 'manual' | null;
}

export interface ReportScopeOption {
  kind: ScopeKind;
  id: string | null;
  name: string;
  /** Teams only: lets forms mirror the backend's scope check (UI hint). */
  departmentId?: string | null;
}
