/**
 * Validation + normalization of role assignments, shared by member management and invitations.
 */
import type { RoleAssignmentInput } from '@esports/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { Errors } from '../common/errors';
import type { DbOrTx } from '../db/client';
import { departments, roles, teams } from '../db/schema';

export interface NormalizedAssignment {
  roleId: string;
  scopeType: 'organization' | 'department' | 'team';
  departmentId: string | null;
  teamId: string | null;
}

/**
 * Rejects: roles from another org, the Owner system role (ownership has its own endpoints so it
 * can never be dropped by accident), and scopes pointing at departments/teams outside the org.
 * With `skipInvalid`, invalid entries are dropped instead (used when accepting an invitation
 * whose team was deleted after it was sent); the dropped entries are returned for auditing.
 */
export async function normalizeAssignments(
  tx: DbOrTx,
  organizationId: string,
  inputs: RoleAssignmentInput[],
  opts: { skipInvalid?: boolean } = {},
): Promise<{ valid: NormalizedAssignment[]; dropped: RoleAssignmentInput[] }> {
  const roleIds = [...new Set(inputs.map((a) => a.roleId))];
  const deptIds = [...new Set(inputs.filter((a) => a.scopeType === 'department').map((a) => a.scopeId!))];
  const teamIds = [...new Set(inputs.filter((a) => a.scopeType === 'team').map((a) => a.scopeId!))];

  const roleRows = roleIds.length
    ? await tx
        .select({ id: roles.id, isSystem: roles.isSystem })
        .from(roles)
        .where(and(eq(roles.organizationId, organizationId), inArray(roles.id, roleIds)))
    : [];
  const deptRows = deptIds.length
    ? await tx
        .select({ id: departments.id })
        .from(departments)
        .where(and(eq(departments.organizationId, organizationId), inArray(departments.id, deptIds)))
    : [];
  const teamRows = teamIds.length
    ? await tx
        .select({ id: teams.id })
        .from(teams)
        .where(and(eq(teams.organizationId, organizationId), inArray(teams.id, teamIds)))
    : [];

  const assignableRoles = new Set(roleRows.filter((r) => !r.isSystem).map((r) => r.id));
  const okDepts = new Set(deptRows.map((d) => d.id));
  const okTeams = new Set(teamRows.map((t) => t.id));

  const valid: NormalizedAssignment[] = [];
  const dropped: RoleAssignmentInput[] = [];
  const seen = new Set<string>();

  for (const a of inputs) {
    const scopeOk =
      a.scopeType === 'organization' ||
      (a.scopeType === 'department' && okDepts.has(a.scopeId!)) ||
      (a.scopeType === 'team' && okTeams.has(a.scopeId!));
    if (!assignableRoles.has(a.roleId) || !scopeOk) {
      if (opts.skipInvalid) {
        dropped.push(a);
        continue;
      }
      throw Errors.badRequest('invalid_scope', 'Unknown role or scope for this organization');
    }
    const n: NormalizedAssignment = {
      roleId: a.roleId,
      scopeType: a.scopeType,
      departmentId: a.scopeType === 'department' ? a.scopeId! : null,
      teamId: a.scopeType === 'team' ? a.scopeId! : null,
    };
    const key = `${n.roleId}|${n.scopeType}|${n.departmentId}|${n.teamId}`;
    if (!seen.has(key)) {
      seen.add(key);
      valid.push(n);
    }
  }
  return { valid, dropped };
}
