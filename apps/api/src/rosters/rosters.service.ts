/**
 * Team rosters: starters, substitutes, coaches, managers, staff — with pay terms.
 *
 * Access: roster records follow `rosters.*` scoped to the team. Pay terms are finance data:
 * they are only returned to callers whose `finance.view` covers the team, and only callers whose
 * `finance.edit` covers the team can set or change them.
 * Moving someone to another team is done by marking them as left and adding them to the other
 * team, so finance history stays attached to the team it was incurred for.
 */
import { Inject, Injectable } from '@nestjs/common';
import type {
  CompensationDto,
  CompensationInput,
  RosterMemberCreateInput,
  RosterMemberDto,
  RosterMemberUpdateInput,
} from '@esports/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { Access, TeamRef } from '../authz/access.js';
import type { TenantContext } from '../authz/context.js';
import { AuditService } from '../audit/audit.service.js';
import { Errors } from '../common/errors.js';
import { DB, type Database, type DbOrTx } from '../db/client.js';
import { rosterCompensation, rosterMembers } from '../db/schema-finance.js';
import { loadTeamRef } from '../finance/scope.js';

type MemberRow = typeof rosterMembers.$inferSelect;
type CompRow = typeof rosterCompensation.$inferSelect;

const num = (v: string | null) => (v === null ? null : stripZeros(v));
/** NUMERIC(18,4) comes back as "2000.0000"; present it as entered ("2000"). */
function stripZeros(v: string): string {
  return v.includes('.') ? v.replace(/\.?0+$/, '') : v;
}

function toComp(c: CompRow): CompensationDto {
  return {
    currency: c.currency,
    amount: stripZeros(c.amount),
    offSeasonAmount: num(c.offSeasonAmount),
    frequency: c.frequency as CompensationDto['frequency'],
    contractStart: c.contractStart,
    contractEnd: c.contractEnd,
    signingBonus: num(c.signingBonus),
    notes: c.notes,
  };
}

@Injectable()
export class RostersService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  private toDto(m: MemberRow, comp: CompRow | null, showPay: boolean): RosterMemberDto {
    const dto: RosterMemberDto = {
      id: m.id,
      teamId: m.teamId,
      fullName: m.fullName,
      handle: m.handle,
      role: m.role as RosterMemberDto['role'],
      position: m.position,
      nationality: m.nationality,
      dateOfBirth: m.dateOfBirth,
      email: m.email,
      phone: m.phone,
      joinedOn: m.joinedOn,
      leftOn: m.leftOn,
      active: m.active,
      notes: m.notes,
      createdAt: m.createdAt.toISOString(),
      updatedAt: m.updatedAt.toISOString(),
    };
    if (showPay) dto.compensation = comp ? toComp(comp) : null;
    return dto;
  }

  /** Visible = rosters.view on the team, or finance.view on it (finance forms pick players). */
  private canSee(access: Access, team: TeamRef): boolean {
    return access.coversTeam('rosters.view', team) || access.coversTeam('finance.view', team);
  }

  async list(ctx: TenantContext, teamId: string): Promise<RosterMemberDto[]> {
    const team = await this.visibleTeam(ctx, teamId);
    const rows = await this.db
      .select({ m: rosterMembers, c: rosterCompensation })
      .from(rosterMembers)
      .leftJoin(rosterCompensation, eq(rosterCompensation.rosterMemberId, rosterMembers.id))
      .where(
        and(eq(rosterMembers.organizationId, ctx.organizationId), eq(rosterMembers.teamId, teamId)),
      )
      .orderBy(asc(rosterMembers.role), asc(rosterMembers.fullName));
    const showPay = ctx.access.coversTeam('finance.view', team);
    return rows.map(({ m, c }) => this.toDto(m, c, showPay));
  }

  private async visibleTeam(ctx: TenantContext, teamId: string) {
    let team: (TeamRef & { name: string }) | null;
    try {
      team = await loadTeamRef(this.db, ctx.organizationId, teamId);
    } catch {
      throw Errors.notFound('Team');
    }
    if (!team || !this.canSee(ctx.access, team)) throw Errors.notFound('Team');
    return team;
  }

  private async load(ctx: TenantContext, id: string) {
    const [row] = await this.db
      .select({ m: rosterMembers, c: rosterCompensation })
      .from(rosterMembers)
      .leftJoin(rosterCompensation, eq(rosterCompensation.rosterMemberId, rosterMembers.id))
      .where(and(eq(rosterMembers.id, id), eq(rosterMembers.organizationId, ctx.organizationId)));
    if (!row) throw Errors.notFound('Roster member');
    const team = (await loadTeamRef(this.db, ctx.organizationId, row.m.teamId))!;
    if (!this.canSee(ctx.access, team)) throw Errors.notFound('Roster member');
    return { ...row, team };
  }

  async get(ctx: TenantContext, id: string): Promise<RosterMemberDto> {
    const { m, c, team } = await this.load(ctx, id);
    return this.toDto(m, c, ctx.access.coversTeam('finance.view', team));
  }

  private async writeCompensation(
    tx: DbOrTx,
    ctx: TenantContext,
    memberId: string,
    input: CompensationInput | null,
    before: CompRow | null,
  ) {
    if (input === null) {
      await tx.delete(rosterCompensation).where(eq(rosterCompensation.rosterMemberId, memberId));
    } else {
      const values = {
        organizationId: ctx.organizationId,
        currency: input.currency,
        amount: input.amount,
        offSeasonAmount: input.offSeasonAmount ?? null,
        frequency: input.frequency,
        contractStart: input.contractStart ?? null,
        contractEnd: input.contractEnd ?? null,
        signingBonus: input.signingBonus ?? null,
        notes: input.notes ?? null,
        updatedByUserId: ctx.user.id,
        updatedAt: new Date(),
      };
      await tx
        .insert(rosterCompensation)
        .values({ rosterMemberId: memberId, ...values })
        .onConflictDoUpdate({ target: rosterCompensation.rosterMemberId, set: values });
    }
    await this.audit.fromCtx(
      ctx,
      'roster.compensation_changed',
      { type: 'roster_member', id: memberId },
      {
        before: before ? toComp(before) : null,
        after: input,
      },
      tx,
    );
  }

  async create(ctx: TenantContext, input: RosterMemberCreateInput): Promise<RosterMemberDto> {
    const team = await loadTeamRef(this.db, ctx.organizationId, input.teamId);
    if (!team || !ctx.access.coversTeam('rosters.create', team)) throw Errors.forbidden();
    if (input.compensation && !ctx.access.coversTeam('finance.edit', team))
      throw Errors.forbidden('Setting pay needs finance edit access for this team');

    const id = await this.db.transaction(async (tx) => {
      const [m] = await tx
        .insert(rosterMembers)
        .values({
          organizationId: ctx.organizationId,
          teamId: input.teamId,
          fullName: input.fullName,
          handle: input.handle ?? null,
          role: input.role,
          position: input.position ?? null,
          nationality: input.nationality ?? null,
          dateOfBirth: input.dateOfBirth ?? null,
          email: input.email ?? null,
          phone: input.phone ?? null,
          joinedOn: input.joinedOn ?? null,
          leftOn: input.leftOn ?? null,
          active: input.active ?? true,
          notes: input.notes ?? null,
          createdByUserId: ctx.user.id,
        })
        .returning({ id: rosterMembers.id });
      await this.audit.fromCtx(
        ctx,
        'roster.member_added',
        { type: 'roster_member', id: m!.id },
        {
          teamId: input.teamId,
          fullName: input.fullName,
          role: input.role,
        },
        tx,
      );
      if (input.compensation)
        await this.writeCompensation(tx, ctx, m!.id, input.compensation, null);
      return m!.id;
    });
    return this.get(ctx, id);
  }

  async update(
    ctx: TenantContext,
    id: string,
    input: RosterMemberUpdateInput,
  ): Promise<RosterMemberDto> {
    const { m, c, team } = await this.load(ctx, id);
    if (!ctx.access.coversTeam('rosters.edit', team)) throw Errors.forbidden();
    if (input.compensation !== undefined && !ctx.access.coversTeam('finance.edit', team)) {
      throw Errors.forbidden('Changing pay needs finance edit access for this team');
    }
    const { compensation, teamId, ...fields } = input;
    if (teamId && teamId !== m.teamId) {
      throw Errors.badRequest(
        'validation_failed',
        'To move someone, mark them as left and add them to the other team',
      );
    }
    await this.db.transaction(async (tx) => {
      if (Object.keys(fields).length) {
        await tx
          .update(rosterMembers)
          .set({ ...fields, updatedAt: new Date() })
          .where(eq(rosterMembers.id, id));
        await this.audit.fromCtx(
          ctx,
          'roster.member_updated',
          { type: 'roster_member', id },
          { changes: fields },
          tx,
        );
      }
      if (compensation !== undefined) await this.writeCompensation(tx, ctx, id, compensation, c);
    });
    return this.get(ctx, id);
  }

  async remove(ctx: TenantContext, id: string): Promise<void> {
    const { m, team } = await this.load(ctx, id);
    if (!ctx.access.coversTeam('rosters.delete', team)) throw Errors.forbidden();
    // Finance entries referencing this person block deletion (FK restrict → 409 in_use).
    await this.db.transaction(async (tx) => {
      await tx.delete(rosterMembers).where(eq(rosterMembers.id, id));
      await this.audit.fromCtx(
        ctx,
        'roster.member_removed',
        { type: 'roster_member', id },
        {
          teamId: m.teamId,
          fullName: m.fullName,
        },
        tx,
      );
    });
  }

  /** Active roster pay terms for teams (used by payroll projection). */
  async compensationForTeams(organizationId: string, teamIds: string[] | 'all') {
    const rows = await this.db
      .select({ m: rosterMembers, c: rosterCompensation })
      .from(rosterCompensation)
      .innerJoin(rosterMembers, eq(rosterMembers.id, rosterCompensation.rosterMemberId))
      .where(and(eq(rosterMembers.organizationId, organizationId), eq(rosterMembers.active, true)));
    return rows.filter(({ m }) => teamIds === 'all' || teamIds.includes(m.teamId));
  }

  exportVisibility(ctx: TenantContext, team: TeamRef) {
    return { showPay: ctx.access.coversTeam('finance.view', team) };
  }

  async teamForExport(ctx: TenantContext, teamId: string) {
    const team = await loadTeamRef(this.db, ctx.organizationId, teamId).catch(() => null);
    if (!team || !ctx.access.coversTeam('rosters.export', team)) throw Errors.notFound('Team');
    return team;
  }
}
