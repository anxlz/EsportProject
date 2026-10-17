/**
 * Resolves a user's Access inside an organization, with a Redis cache.
 *
 * Cache invalidation is by organization "version": any change to roles, role permissions,
 * assignments or membership status in an org bumps `authz:ver:{orgId}`, so every cached entry for
 * that org becomes unreachable immediately. All such mutations go through services that call
 * `invalidate()`; tests assert that permission changes take effect on the very next request.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { PermissionKey, ScopeGrant } from '@esports/shared';
import { and, eq, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { REDIS } from '../core/core.module';
import { DB, type Database, type DbOrTx } from '../db/client';
import { organizationMembers } from '../db/schema';
import { Access, type AssignmentRow, buildGrants, type TeamRef } from './access';

export type MembershipStatus = 'active' | 'suspended' | 'none';

interface CachedAccess {
  status: MembershipStatus;
  isOwner: boolean;
  grants: { key: PermissionKey; scope: ScopeGrant }[];
}

const CACHE_TTL_SECONDS = 600;

@Injectable()
export class AccessService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async resolve(
    organizationId: string,
    userId: string,
  ): Promise<{ status: MembershipStatus; access: Access | null }> {
    const version = (await this.redis.get(`authz:ver:${organizationId}`)) ?? '0';
    const cacheKey = `authz:${organizationId}:${userId}:v${version}`;
    const cached = await this.redis.get(cacheKey);
    let value: CachedAccess;
    if (cached) {
      value = JSON.parse(cached) as CachedAccess;
    } else {
      value = await this.load(organizationId, userId);
      await this.redis.set(cacheKey, JSON.stringify(value), 'EX', CACHE_TTL_SECONDS);
    }
    if (value.status !== 'active') return { status: value.status, access: null };
    return {
      status: 'active',
      access: Access.fromJSON(organizationId, userId, value.isOwner, value.grants),
    };
  }

  /** Must be called after ANY change to roles/permissions/assignments/membership in the org. */
  async invalidate(organizationId: string): Promise<void> {
    await this.redis.incr(`authz:ver:${organizationId}`);
  }

  private async load(organizationId: string, userId: string): Promise<CachedAccess> {
    const [member] = await this.db
      .select({ status: organizationMembers.status })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, organizationId),
          eq(organizationMembers.userId, userId),
        ),
      );
    if (!member) return { status: 'none', isOwner: false, grants: [] };
    if (member.status !== 'active') return { status: member.status, isOwner: false, grants: [] };

    const rows = await this.assignmentRows(this.db, organizationId, userId);
    const { grants, isOwner } = buildGrants(rows);
    const access = new Access(organizationId, userId, grants, isOwner);
    return { status: 'active', isOwner, grants: access.toJSON() };
  }

  private async assignmentRows(
    db: DbOrTx,
    organizationId: string,
    userId?: string,
  ): Promise<(AssignmentRow & { userId: string })[]> {
    const userFilter = userId ? sql`and a.user_id = ${userId}` : sql``;
    const result = await db.execute<{
      user_id: string;
      grants_all: boolean;
      scope_type: AssignmentRow['scopeType'];
      department_id: string | null;
      team_id: string | null;
      keys: string[];
    }>(sql`
      select a.user_id, r.grants_all, a.scope_type, a.department_id, a.team_id,
             coalesce(array_agg(rp.permission_key) filter (where rp.permission_key is not null), '{}') as keys
      from app.user_role_assignments a
      join app.organization_members m
        on m.organization_id = a.organization_id and m.user_id = a.user_id and m.status = 'active'
      join app.roles r on r.id = a.role_id
      left join app.role_permissions rp on rp.role_id = r.id
      where a.organization_id = ${organizationId} ${userFilter}
      group by a.id, a.user_id, r.grants_all
    `);
    return [...result].map((r) => ({
      userId: r.user_id,
      grantsAll: r.grants_all,
      permissionKeys: r.keys,
      scopeType: r.scope_type,
      departmentId: r.department_id,
      teamId: r.team_id,
    }));
  }

  /**
   * Active members who hold `perm` — optionally covering a specific team. Used by the
   * notification service to find who should hear about something (e.g. approvers, budget owners).
   */
  async usersWithPermission(
    organizationId: string,
    perm: PermissionKey,
    /**
     * A team: holders whose scope covers it. 'organization': only organization-wide holders
     * (e.g. for organization-level budgets a team-scoped manager cannot see).
     * Omitted: anyone holding the permission at any scope.
     */
    team?: TeamRef | 'organization',
  ): Promise<string[]> {
    const rows = await this.assignmentRows(this.db, organizationId);
    const byUser = new Map<string, AssignmentRow[]>();
    for (const r of rows) {
      const list = byUser.get(r.userId) ?? [];
      list.push(r);
      byUser.set(r.userId, list);
    }
    const result: string[] = [];
    for (const [uid, list] of byUser) {
      const { grants, isOwner } = buildGrants(list);
      const access = new Access(organizationId, uid, grants, isOwner);
      const ok =
        team === 'organization'
          ? access.hasAll(perm)
          : team
            ? access.coversTeam(perm, team)
            : access.has(perm);
      if (ok) result.push(uid);
    }
    return result;
  }
}
