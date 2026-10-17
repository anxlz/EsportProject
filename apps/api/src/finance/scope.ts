/**
 * Scope rules for finance records, built on the Phase 1 Access/scopeCondition primitives.
 *
 * - A record with a team is covered when the permission's scope covers that team.
 * - A record WITHOUT a team (organization-wide) is covered only by an organization-wide grant.
 * - Reports for the whole organization, a tournament or a season need an organization-wide
 *   finance.view, so a team-scoped user never sees a silently partial total.
 */
import type { PermissionKey } from '@esports/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { Access, TeamRef } from '../authz/access';
import { Errors } from '../common/errors';
import type { DbOrTx } from '../db/client';
import { teams } from '../db/schema';

export function coversRecord(access: Access, perm: PermissionKey, team: TeamRef | null): boolean {
  return team ? access.coversTeam(perm, team) : access.hasAll(perm);
}

export async function loadTeamRef(
  db: DbOrTx,
  organizationId: string,
  teamId: string | null | undefined,
): Promise<(TeamRef & { name: string }) | null> {
  if (!teamId) return null;
  const [t] = await db
    .select({ id: teams.id, departmentId: teams.departmentId, name: teams.name })
    .from(teams)
    .where(and(eq(teams.id, teamId), eq(teams.organizationId, organizationId)));
  if (!t) throw Errors.badRequest('invalid_scope', 'Unknown team');
  return t;
}

export async function loadTeamRefs(
  db: DbOrTx,
  organizationId: string,
  ids: string[],
): Promise<Map<string, TeamRef & { name: string }>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select({ id: teams.id, departmentId: teams.departmentId, name: teams.name })
    .from(teams)
    .where(and(eq(teams.organizationId, organizationId), inArray(teams.id, [...new Set(ids)])));
  return new Map(rows.map((r) => [r.id, r]));
}
