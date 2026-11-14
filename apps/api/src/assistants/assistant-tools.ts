/**
 * Platform tools the assistants may call (spec §8.1 "Data access"). Every tool:
 * - is READ-ONLY: it calls the same service read methods as the dashboard's own endpoints, with
 *   the invoking user's own context, so the same permission checks and team/department scope
 *   filters apply ("never a backend bypass because it's the AI");
 * - is offered to the model only if the user holds one of its permissions, and re-checked when
 *   it runs (a denied or unknown record returns "not available", without saying which);
 * - returns only what the answer needs (data minimisation): no ID numbers, contact details,
 *   addresses or dates of birth (an age instead), no internal notes;
 * - registers what it returned as a source, so the answer can cite it and nothing else.
 * There is deliberately no tool that writes anything.
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  type AssistantKey,
  ageOn,
  type ContractSummaryDto,
  type PermissionKey,
  type ReportQuery,
  type RosterMemberDto,
} from '@esports/shared';
import { z } from 'zod';
import type { TenantContext } from '../authz/context.js';
import { AppError } from '../common/errors.js';
import { DB, type Database } from '../db/client.js';
import { ContractsService } from '../contracts/contracts.service.js';
import { BudgetsService } from '../finance/budgets.service.js';
import { CLOCK, type Clock } from '../finance/clock.js';
import { ReportsService } from '../finance/reports.service.js';
import { RostersService } from '../rosters/rosters.service.js';
import { TeamsService } from '../teams/teams.service.js';
import { listTournaments } from '../tournaments/tournaments.controller.js';
import type { SourceRegistry } from './guardrails.js';

export interface ToolRun {
  ctx: TenantContext;
  registry: SourceRegistry;
}

export interface ToolResult {
  /** What the model sees (includes the source id to cite). */
  data: unknown;
  sourceId: string | null;
  count?: number;
}

export interface PlatformTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Offered when the user holds ANY of these (each record is re-checked by the service). */
  requires: PermissionKey[];
  readOnly: true;
  run(t: ToolRun, input: unknown): Promise<ToolResult>;
}

/** Why a tool call produced nothing usable. */
export class ToolDenied extends Error {
  constructor(readonly outcome: 'denied' | 'not_found' | 'error') {
    super(outcome);
  }
}

const uuid = z.uuid();
const isoDate = z.iso.date();
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const str = (description: string, extra: Record<string, unknown> = {}) => ({
  type: 'string',
  description,
  ...extra,
});

const ageOf = (dob: string | null, today: string) => (dob ? ageOn(dob, today) : null);

/** Which tools each assistant may use (Formal Message and Email work from user input only). */
const TOOLS_BY_ASSISTANT: Record<AssistantKey, string[]> = {
  general: [
    'list_teams',
    'list_roster',
    'get_roster_member',
    'get_finance_summary',
    'list_budgets',
    'list_contracts',
    'get_contract_terms',
    'list_tournaments',
  ],
  formal_message: [],
  email: [],
  offer_optimizer: [
    'list_teams',
    'list_roster',
    'get_finance_summary',
    'list_budgets',
    'list_contracts',
    'get_contract_terms',
  ],
  player_analyst: [
    'list_teams',
    'list_roster',
    'get_roster_member',
    'get_finance_summary',
    'list_contracts',
    'get_contract_terms',
    'list_tournaments',
  ],
};

@Injectable()
export class AssistantTools {
  readonly all: PlatformTool[];

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly teams: TeamsService,
    private readonly rosters: RostersService,
    private readonly reports: ReportsService,
    private readonly budgets: BudgetsService,
    private readonly contracts: ContractsService,
  ) {
    this.all = this.define();
    for (const t of this.all)
      if (t.readOnly !== true) throw new Error(`${t.name} is not read-only`);
  }

  /** The tools offered to this user for this assistant. */
  forUser(ctx: TenantContext, assistant: AssistantKey): PlatformTool[] {
    const allowed = new Set(TOOLS_BY_ASSISTANT[assistant]);
    return this.all.filter((t) => allowed.has(t.name) && t.requires.some((p) => ctx.access.has(p)));
  }

  /** Runs a tool as the user; maps the services' 403/404 to a uniform "not available". */
  async run(tool: PlatformTool, t: ToolRun, input: unknown): Promise<ToolResult> {
    if (!tool.requires.some((p) => t.ctx.access.has(p))) throw new ToolDenied('denied');
    try {
      return await tool.run(t, input);
    } catch (e) {
      if (e instanceof ToolDenied) throw e;
      if (e instanceof z.ZodError) throw new ToolDenied('error');
      if (e instanceof AppError) {
        const s = e.getStatus();
        throw new ToolDenied(s === 403 ? 'denied' : s === 404 ? 'not_found' : 'error');
      }
      throw e;
    }
  }

  private define(): PlatformTool[] {
    const today = () => this.clock.today();
    const roster = (m: RosterMemberDto) => ({
      id: m.id,
      teamId: m.teamId,
      name: m.fullName,
      handle: m.handle,
      role: m.role,
      position: m.position,
      nationality: m.nationality,
      age: ageOf(m.dateOfBirth, today()),
      joinedOn: m.joinedOn,
      leftOn: m.leftOn,
      active: m.active,
      // Present only when the user may see pay on this team (finance.view), as on the dashboard.
      ...(m.compensation !== undefined
        ? {
            compensation: m.compensation
              ? {
                  amount: m.compensation.amount,
                  currency: m.compensation.currency,
                  frequency: m.compensation.frequency,
                  offSeasonAmount: m.compensation.offSeasonAmount,
                  signingBonus: m.compensation.signingBonus,
                  contractStart: m.compensation.contractStart,
                  contractEnd: m.compensation.contractEnd,
                }
              : null,
          }
        : { compensation: 'not visible to you' }),
    });
    const contractRow = (c: ContractSummaryDto) => ({
      id: c.id,
      number: c.number,
      title: c.title || c.typeNameEn,
      status: c.status,
      team: c.teamName,
      recipient: c.recipientName,
      approvedAt: c.approvedAt,
      signedAt: c.signedAt,
    });

    return [
      {
        name: 'list_teams',
        description: 'Lists the teams this user can see, with their game and department.',
        inputSchema: obj({}),
        requires: ['teams.view'],
        readOnly: true,
        run: async ({ ctx, registry }) => {
          const teams = await this.teams.list(ctx);
          const data = teams.map((t) => ({
            id: t.id,
            name: t.name,
            game: t.gameName,
            department: t.departmentName,
            region: t.region,
            status: t.status,
          }));
          const sourceId = registry.addPlatform('Teams', '/dashboard/teams', data, {
            key: 'teams',
          });
          return { data: { sourceId, teams: data }, sourceId, count: data.length };
        },
      },
      {
        name: 'list_roster',
        description:
          "Lists a team's roster (players, coaches, staff): role, position, nationality, age and, when this user may see pay, compensation terms.",
        inputSchema: obj({ teamId: str('Team id (from list_teams).', { format: 'uuid' }) }, [
          'teamId',
        ]),
        requires: ['rosters.view'],
        readOnly: true,
        run: async ({ ctx, registry }, raw) => {
          const { teamId } = z.object({ teamId: uuid }).parse(raw);
          const team = await this.teams.getVisible(ctx, teamId).catch(() => null);
          const members = (await this.rosters.list(ctx, teamId)).map(roster);
          const sourceId = registry.addPlatform(
            `Roster — ${team?.name ?? 'team'}`,
            `/dashboard/teams/${teamId}`,
            members,
            { key: 'roster', subject: team?.name ?? null },
          );
          return { data: { sourceId, members }, sourceId, count: members.length };
        },
      },
      {
        name: 'get_roster_member',
        description:
          'One roster member: role, position, nationality, age, dates and pay terms (if visible).',
        inputSchema: obj(
          { rosterMemberId: str('Roster member id (from list_roster).', { format: 'uuid' }) },
          ['rosterMemberId'],
        ),
        requires: ['rosters.view'],
        readOnly: true,
        run: async ({ ctx, registry }, raw) => {
          const { rosterMemberId } = z.object({ rosterMemberId: uuid }).parse(raw);
          const m = roster(await this.rosters.get(ctx, rosterMemberId));
          const sourceId = registry.addPlatform(
            `Roster member — ${m.name}`,
            `/dashboard/teams/${m.teamId}`,
            m,
            { key: 'roster_member', subject: m.name },
          );
          return { data: { sourceId, member: m }, sourceId, count: 1 };
        },
      },
      {
        name: 'get_finance_summary',
        description:
          'Financial report for the whole organization or one team: totals, costs and revenue by category, monthly results, break-even and planning scenarios. Amounts are in the reporting currency at the rates recorded on each transaction.',
        inputSchema: obj(
          {
            scope: { type: 'string', enum: ['organization', 'team'] },
            teamId: str('Team id when scope is team.', { format: 'uuid' }),
            from: str('Start date YYYY-MM-DD (optional).', { format: 'date' }),
            to: str('End date YYYY-MM-DD (optional).', { format: 'date' }),
          },
          ['scope'],
        ),
        requires: ['finance.view'],
        readOnly: true,
        run: async ({ ctx, registry }, raw) => {
          const q = z
            .object({
              scope: z.enum(['organization', 'team']),
              teamId: uuid.optional(),
              from: isoDate.optional(),
              to: isoDate.optional(),
            })
            .parse(raw);
          if (q.scope === 'team' && !q.teamId) throw new ToolDenied('error');
          const query: ReportQuery = {
            scope: q.scope,
            scopeId: q.scope === 'team' ? q.teamId : undefined,
            from: q.from,
            to: q.to,
            rateMode: 'snapshot',
          };
          const r = await this.reports.build(ctx, query);
          const data = {
            scope: r.scope.name,
            currency: r.baseCurrency,
            period: r.period,
            asOf: r.asOf,
            totals: r.totals,
            costsByCategory: r.costsByCategory.slice(0, 12),
            revenueByCategory: r.revenueByCategory.slice(0, 12),
            byTeam: r.byTeam?.slice(0, 20) ?? null,
            lastMonths: r.monthly.slice(-12),
            breakEven: r.breakEven,
            projections: { certain: r.projections.certain, uncertain: r.projections.uncertain },
            scenarios: Object.fromEntries(
              Object.entries(r.scenarios).map(([k, s]) => [
                k,
                {
                  monthlyNet: s.monthlyNet,
                  outcome: s.outcome,
                  monthsToBreakEven: s.monthsToBreakEven,
                  endPosition: s.endPosition,
                },
              ]),
            ),
            footnotes: r.footnotes.map((f) => f.key),
          };
          const subject = `${r.scope.name}${q.from || q.to ? ` (${q.from ?? '…'} – ${q.to ?? '…'})` : ''}`;
          const sourceId = registry.addPlatform(
            `Finance report — ${subject}`,
            '/dashboard/finance',
            data,
            {
              key: 'finance_report',
              subject,
            },
          );
          return { data: { sourceId, report: data }, sourceId, count: 1 };
        },
      },
      {
        name: 'list_budgets',
        description:
          'Budgets this user can see, with planned vs actual amounts and whether they are over plan.',
        inputSchema: obj({}),
        requires: ['finance.view'],
        readOnly: true,
        run: async ({ ctx, registry }) => {
          const budgets = (await this.budgets.list(ctx)).slice(0, 30).map((b) => ({
            name: b.name,
            team: b.teamName,
            tournament: b.tournamentName,
            season: b.seasonName,
            period: { start: b.periodStart, end: b.periodEnd },
            currency: b.currency,
            total: b.variance.total,
            over: b.over,
          }));
          const sourceId = registry.addPlatform('Budgets', '/dashboard/finance/budgets', budgets, {
            key: 'budgets',
          });
          return { data: { sourceId, budgets }, sourceId, count: budgets.length };
        },
      },
      {
        name: 'list_contracts',
        description:
          'Contracts this user can see (number, status, recipient, team). Optional filters.',
        inputSchema: obj({
          status: {
            type: 'string',
            enum: [
              'draft',
              'pending_approval',
              'changes_requested',
              'approved',
              'awaiting_signatures',
              'signed',
              'cancelled',
            ],
          },
          teamId: str('Team id.', { format: 'uuid' }),
          search: str('Text to match in the number, title or recipient.'),
        }),
        requires: ['contracts.view', 'contracts.approve'],
        readOnly: true,
        run: async ({ ctx, registry }, raw) => {
          const q = z
            .object({
              status: z.string().max(40).optional(),
              teamId: uuid.optional(),
              search: z.string().trim().max(120).optional(),
            })
            .parse(raw);
          const rows = await this.contracts.list(ctx, {
            view: 'all',
            status: q.status,
            teamId: q.teamId,
            q: q.search,
            limit: 30,
          });
          const data = rows.map(contractRow);
          const sourceId = registry.addPlatform('Contracts', '/dashboard/contracts', data, {
            key: 'contracts',
          });
          return { data: { sourceId, contracts: data }, sourceId, count: data.length };
        },
      },
      {
        name: 'get_contract_terms',
        description:
          "One contract's commercial terms: role, dates, pay, revenue share, bonuses, buyout, termination conditions and status.",
        inputSchema: obj(
          { contractId: str('Contract id (from list_contracts).', { format: 'uuid' }) },
          ['contractId'],
        ),
        requires: ['contracts.view', 'contracts.approve'],
        readOnly: true,
        run: async ({ ctx, registry }, raw) => {
          const { contractId } = z.object({ contractId: uuid }).parse(raw);
          const c = await this.contracts.get(ctx, contractId);
          const d = c.snapshot.details;
          const data = {
            number: c.number,
            title: c.title || c.typeNameEn,
            type: c.typeNameEn,
            status: c.status,
            version: c.currentVersion,
            team: c.teamName,
            recipient: {
              kind: d.recipient.kind,
              name: d.recipient.fullNameEn || d.recipient.fullNameAr,
              age: ageOf(d.recipient.dateOfBirth ?? null, today()),
            },
            role: d.role,
            startDate: d.startDate,
            endDate: d.endDate,
            compensation: d.compensation,
            revenueShare: d.revenueShare,
            bonuses: d.bonuses,
            buyout: d.buyout,
            terminationConditions: d.terminationConditions,
          };
          const sourceId = registry.addPlatform(
            `Contract ${c.number}`,
            `/dashboard/contracts/${c.id}`,
            data,
            { key: 'contract', subject: c.number },
          );
          return { data: { sourceId, contract: data }, sourceId, count: 1 };
        },
      },
      {
        name: 'list_tournaments',
        description:
          "The organization's tournament research records (entered by staff): dates, status, prize pool, entry fee, placement rewards, eligibility and the source link they cite.",
        inputSchema: obj({ search: str('Text to match in the tournament name.') }),
        requires: ['tournaments.view'],
        readOnly: true,
        run: async ({ ctx, registry }, raw) => {
          const { search } = z.object({ search: z.string().trim().max(120).optional() }).parse(raw);
          const all = await listTournaments(this.db, ctx.organizationId);
          const data = all
            .filter((t) => !search || t.name.toLowerCase().includes(search.toLowerCase()))
            .slice(0, 30)
            .map((t) => ({
              name: t.name,
              organizer: t.organizer,
              game: t.gameName,
              region: t.region,
              startDate: t.startDate,
              endDate: t.endDate,
              status: t.status,
              prizePool: t.prizePoolAmount ? `${t.prizePoolAmount} ${t.prizePoolCurrency}` : null,
              entryFee: t.entryFeeAmount ? `${t.entryFeeAmount} ${t.entryFeeCurrency}` : null,
              placementRewards: t.placementRewards,
              eligibility: t.eligibility,
              teams: t.teams.map((x) => x.name),
              recordSource: t.sourceUrl,
              lastVerifiedOn: t.lastVerifiedOn,
            }));
          const sourceId = registry.addPlatform(
            'Tournament research',
            '/dashboard/tournaments',
            data,
            { key: 'tournaments' },
          );
          return { data: { sourceId, tournaments: data }, sourceId, count: data.length };
        },
      },
    ];
  }
}
