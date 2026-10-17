/**
 * Budgets: planned spend for a team, tournament, season and/or date range, in the reporting
 * currency, optionally broken down by cost category.
 *
 * Which costs count against a budget: every cost (any level, including player-level costs) that
 * matches ALL of the budget's filters. A filter left empty does not restrict — so a budget with
 * no team covers the whole organization.
 *
 * Visibility follows the budget's team: finance.view on that team (or organization-wide for a
 * budget without a team). Creating/changing needs budgets.manage on the same scope.
 *
 * Alerts (brief §6.3): when the total or a category line goes over plan, the people whose
 * finance.view covers the budget get ONE notification through the shared NotificationService,
 * and the event is written to the shared audit log. The alert re-arms once spending is back
 * within plan (or the planned amount changes), so it fires again on the next crossing — never on
 * every new cost while it stays over.
 */
import { Inject, Injectable } from '@nestjs/common';
import { type BudgetDto, type BudgetInput, computeBudgetVariance, d, money } from '@esports/shared';
import { and, asc, eq, gte, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type { TeamRef } from '../authz/access';
import type { TenantContext } from '../authz/context';
import { scopeCondition } from '../authz/scope-filter';
import { AuditService } from '../audit/audit.service';
import { Errors } from '../common/errors';
import { DB, type Database, type DbOrTx } from '../db/client';
import { organizations, teams } from '../db/schema';
import { budgetLines, budgets, financeEntries, seasons, tournaments } from '../db/schema-finance';
import { NotificationService } from '../notifications/notification.service';
import { coversRecord, loadTeamRef } from './scope';

type BudgetRow = typeof budgets.$inferSelect;
type LineRow = typeof budgetLines.$inferSelect;

const BUDGETS_LINK = '/dashboard/finance/budgets';

@Injectable()
export class BudgetsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  private select(db: DbOrTx = this.db) {
    return db
      .select({
        b: budgets,
        teamName: teams.name,
        teamDepartmentId: teams.departmentId,
        tournamentName: tournaments.name,
        seasonName: seasons.name,
      })
      .from(budgets)
      .leftJoin(teams, eq(teams.id, budgets.teamId))
      .leftJoin(tournaments, eq(tournaments.id, budgets.tournamentId))
      .leftJoin(seasons, eq(seasons.id, budgets.seasonId));
  }

  /** Actual spend per category for a budget's filters (exact NUMERIC sums, reporting currency). */
  async actuals(db: DbOrTx, b: BudgetRow): Promise<{ category: string; baseAmount: string }[]> {
    const conds: (SQL | undefined)[] = [
      eq(financeEntries.organizationId, b.organizationId),
      eq(financeEntries.kind, 'expense'),
      b.teamId ? eq(financeEntries.teamId, b.teamId) : undefined,
      b.tournamentId ? eq(financeEntries.tournamentId, b.tournamentId) : undefined,
      b.seasonId ? eq(financeEntries.seasonId, b.seasonId) : undefined,
      b.periodStart ? gte(financeEntries.entryDate, b.periodStart) : undefined,
      b.periodEnd ? lte(financeEntries.entryDate, b.periodEnd) : undefined,
    ];
    const rows = await db
      .select({
        category: financeEntries.category,
        total: sql<string>`sum(${financeEntries.baseAmount})`,
      })
      .from(financeEntries)
      .where(and(...conds))
      .groupBy(financeEntries.category);
    return rows.map((r) => ({ category: r.category, baseAmount: r.total }));
  }

  private async linesFor(db: DbOrTx, ids: string[]): Promise<Map<string, LineRow[]>> {
    const map = new Map<string, LineRow[]>();
    if (!ids.length) return map;
    const rows = await db
      .select()
      .from(budgetLines)
      .where(inArray(budgetLines.budgetId, ids))
      .orderBy(asc(budgetLines.category));
    for (const l of rows) map.set(l.budgetId, [...(map.get(l.budgetId) ?? []), l]);
    return map;
  }

  private async toDto(
    db: DbOrTx,
    r: Awaited<ReturnType<BudgetsService['select']>>[number],
    lines: LineRow[],
  ): Promise<BudgetDto> {
    const b = r.b;
    const variance = computeBudgetVariance(
      { total: b.total, lines: lines.map((l) => ({ category: l.category, amount: l.amount })) },
      await this.actuals(db, b),
      b.currency,
    );
    return {
      id: b.id,
      name: b.name,
      teamId: b.teamId,
      teamName: r.teamName,
      tournamentId: b.tournamentId,
      tournamentName: r.tournamentName,
      seasonId: b.seasonId,
      seasonName: r.seasonName,
      periodStart: b.periodStart,
      periodEnd: b.periodEnd,
      currency: b.currency,
      notes: b.notes,
      variance,
      over: variance.total.over || variance.lines.some((l) => l.over),
      createdAt: b.createdAt.toISOString(),
      updatedAt: b.updatedAt.toISOString(),
    };
  }

  async list(ctx: TenantContext): Promise<BudgetDto[]> {
    const rows = await this.select()
      .where(
        and(
          eq(budgets.organizationId, ctx.organizationId),
          scopeCondition(ctx.access.scope('finance.view'), {
            teamId: budgets.teamId,
            departmentId: teams.departmentId,
          }),
        ),
      )
      .orderBy(asc(budgets.name));
    const lines = await this.linesFor(
      this.db,
      rows.map((r) => r.b.id),
    );
    return Promise.all(rows.map((r) => this.toDto(this.db, r, lines.get(r.b.id) ?? [])));
  }

  private async load(ctx: TenantContext, id: string) {
    const [r] = await this.select().where(
      and(eq(budgets.id, id), eq(budgets.organizationId, ctx.organizationId)),
    );
    const team: TeamRef | null = r?.b.teamId
      ? { id: r.b.teamId, departmentId: r.teamDepartmentId }
      : null;
    if (!r || !coversRecord(ctx.access, 'finance.view', team)) throw Errors.notFound('Budget');
    return { r, team };
  }

  async get(ctx: TenantContext, id: string): Promise<BudgetDto> {
    const { r } = await this.load(ctx, id);
    const lines = await this.linesFor(this.db, [id]);
    return this.toDto(this.db, r, lines.get(id) ?? []);
  }

  private async validateRefs(tx: DbOrTx, organizationId: string, input: BudgetInput) {
    const team = await loadTeamRef(tx, organizationId, input.teamId ?? null);
    if (input.tournamentId) {
      const [t] = await tx
        .select({ id: tournaments.id })
        .from(tournaments)
        .where(
          and(
            eq(tournaments.id, input.tournamentId),
            eq(tournaments.organizationId, organizationId),
          ),
        );
      if (!t) throw Errors.badRequest('validation_failed', 'Unknown tournament');
    }
    if (input.seasonId) {
      const [s] = await tx
        .select({ id: seasons.id })
        .from(seasons)
        .where(and(eq(seasons.id, input.seasonId), eq(seasons.organizationId, organizationId)));
      if (!s) throw Errors.badRequest('validation_failed', 'Unknown season');
    }
    return team;
  }

  private values(input: BudgetInput) {
    return {
      name: input.name,
      teamId: input.teamId ?? null,
      tournamentId: input.tournamentId ?? null,
      seasonId: input.seasonId ?? null,
      periodStart: input.periodStart ?? null,
      periodEnd: input.periodEnd ?? null,
      total: input.total,
      notes: input.notes ?? null,
    };
  }

  async create(ctx: TenantContext, input: BudgetInput): Promise<BudgetDto> {
    const id = await this.db.transaction(async (tx) => {
      const team = await this.validateRefs(tx, ctx.organizationId, input);
      if (!coversRecord(ctx.access, 'budgets.manage', team)) throw Errors.forbidden();
      const [org] = await tx
        .select({ base: organizations.baseCurrency })
        .from(organizations)
        .where(eq(organizations.id, ctx.organizationId));
      const [b] = await tx
        .insert(budgets)
        .values({
          organizationId: ctx.organizationId,
          ...this.values(input),
          currency: org!.base,
          createdByUserId: ctx.user.id,
        })
        .returning({ id: budgets.id });
      if (input.lines?.length) {
        await tx
          .insert(budgetLines)
          .values(
            input.lines.map((l) => ({ budgetId: b!.id, category: l.category, amount: l.amount })),
          );
      }
      await this.audit.fromCtx(
        ctx,
        'budget.created',
        { type: 'budget', id: b!.id },
        { ...this.values(input), currency: org!.base, lines: input.lines ?? [] },
        tx,
      );
      return b!.id;
    });
    await this.evaluateOne(id, ctx);
    return this.get(ctx, id);
  }

  async update(ctx: TenantContext, id: string, input: BudgetInput): Promise<BudgetDto> {
    const { r, team: beforeTeam } = await this.load(ctx, id);
    if (!coversRecord(ctx.access, 'budgets.manage', beforeTeam)) throw Errors.forbidden();
    await this.db.transaction(async (tx) => {
      const team = await this.validateRefs(tx, ctx.organizationId, input);
      if (!coversRecord(ctx.access, 'budgets.manage', team)) throw Errors.forbidden();
      const beforeLines = (await this.linesFor(tx, [id])).get(id) ?? [];
      const totalChanged = !d(r.b.total).eq(input.total);
      await tx
        .update(budgets)
        .set({
          ...this.values(input),
          totalOverAlerted: totalChanged ? false : r.b.totalOverAlerted,
          updatedAt: new Date(),
        })
        .where(eq(budgets.id, id));
      // Replace lines; keep each line's alert state only when its planned amount is unchanged.
      await tx.delete(budgetLines).where(eq(budgetLines.budgetId, id));
      if (input.lines?.length) {
        await tx.insert(budgetLines).values(
          input.lines.map((l) => {
            const prev = beforeLines.find((p) => p.category === l.category);
            return {
              budgetId: id,
              category: l.category,
              amount: l.amount,
              overAlerted: prev && d(prev.amount).eq(l.amount) ? prev.overAlerted : false,
            };
          }),
        );
      }
      await this.audit.fromCtx(
        ctx,
        'budget.updated',
        { type: 'budget', id },
        {
          before: {
            name: r.b.name,
            total: r.b.total,
            teamId: r.b.teamId,
            tournamentId: r.b.tournamentId,
            seasonId: r.b.seasonId,
            periodStart: r.b.periodStart,
            periodEnd: r.b.periodEnd,
            lines: beforeLines.map((l) => ({ category: l.category, amount: l.amount })),
          },
          after: { ...this.values(input), lines: input.lines ?? [] },
        },
        tx,
      );
    });
    await this.evaluateOne(id, ctx);
    return this.get(ctx, id);
  }

  async remove(ctx: TenantContext, id: string): Promise<void> {
    const { r, team } = await this.load(ctx, id);
    if (!coversRecord(ctx.access, 'budgets.manage', team)) throw Errors.forbidden();
    await this.db.transaction(async (tx) => {
      await tx.delete(budgets).where(eq(budgets.id, id));
      await this.audit.fromCtx(
        ctx,
        'budget.deleted',
        { type: 'budget', id },
        { name: r.b.name, total: r.b.total, teamId: r.b.teamId },
        tx,
      );
    });
  }

  // --- Alerts ---------------------------------------------------------------------------------

  /**
   * Re-checks budgets after costs change. `teamIds` narrows the check to budgets that could be
   * affected (those teams' budgets plus budgets without a team); omit to check every budget.
   */
  async evaluate(
    ctx: TenantContext | null,
    teamIds?: (string | null)[],
    organizationId = ctx?.organizationId,
  ): Promise<void> {
    if (!organizationId) return;
    const ids = teamIds ? [...new Set(teamIds.filter((t): t is string => !!t))] : null;
    const rows = await this.db
      .select({ id: budgets.id })
      .from(budgets)
      .where(
        and(
          eq(budgets.organizationId, organizationId),
          ids
            ? ids.length
              ? or(isNull(budgets.teamId), inArray(budgets.teamId, ids))
              : isNull(budgets.teamId)
            : undefined,
        ),
      );
    for (const { id } of rows) await this.evaluateOne(id, ctx);
  }

  private async evaluateOne(id: string, ctx: TenantContext | null): Promise<void> {
    const [r] = await this.select().where(eq(budgets.id, id));
    if (!r) return;
    const b = r.b;
    const lines = (await this.linesFor(this.db, [id])).get(id) ?? [];
    const variance = computeBudgetVariance(
      { total: b.total, lines: lines.map((l) => ({ category: l.category, amount: l.amount })) },
      await this.actuals(this.db, b),
      b.currency,
    );
    const team: TeamRef | 'organization' = b.teamId
      ? { id: b.teamId, departmentId: r.teamDepartmentId }
      : 'organization';

    // Total. The conditional UPDATE makes the alert fire once even under concurrent writes.
    if (variance.total.over) {
      const flipped = await this.db
        .update(budgets)
        .set({ totalOverAlerted: true })
        .where(and(eq(budgets.id, id), eq(budgets.totalOverAlerted, false)))
        .returning({ id: budgets.id });
      if (flipped.length) await this.alert(b, team, null, variance.total, ctx);
    } else if (b.totalOverAlerted) {
      await this.db.update(budgets).set({ totalOverAlerted: false }).where(eq(budgets.id, id));
    }

    for (const line of variance.lines) {
      const where = and(eq(budgetLines.budgetId, id), eq(budgetLines.category, line.category!));
      if (line.over) {
        const flipped = await this.db
          .update(budgetLines)
          .set({ overAlerted: true })
          .where(and(where, eq(budgetLines.overAlerted, false)))
          .returning({ c: budgetLines.category });
        if (flipped.length) await this.alert(b, team, line.category, line, ctx);
      } else if (lines.find((l) => l.category === line.category)?.overAlerted) {
        await this.db.update(budgetLines).set({ overAlerted: false }).where(where);
      }
    }
  }

  private async alert(
    b: BudgetRow,
    team: TeamRef | 'organization',
    category: string | null,
    line: { planned: string; actual: string; variance: string; usedPercent: string },
    ctx: TenantContext | null,
  ) {
    const data = {
      budgetId: b.id,
      budgetName: b.name,
      category,
      currency: b.currency,
      planned: line.planned,
      actual: line.actual,
      overBy: money(d(line.actual).minus(line.planned), b.currency),
      usedPercent: line.usedPercent,
    };
    const recipients = await this.notifications.notifyPermissionHolders({
      organizationId: b.organizationId,
      type: 'budget.exceeded',
      permission: 'finance.view',
      team,
      data,
      link: BUDGETS_LINK,
    });
    await this.audit.log({
      organizationId: b.organizationId,
      actorUserId: null,
      actorType: 'system',
      action: 'budget.exceeded',
      targetType: 'budget',
      targetId: b.id,
      metadata: { ...data, notified: recipients, triggeredByUserId: ctx?.user.id ?? null },
    });
  }
}
