/**
 * The resolved permissions of one user inside one organization, plus helpers to apply
 * team/department scope. Every protected endpoint works from one of these.
 *
 * Semantics (DECISIONS.md "Authorization model"):
 * - A permission is held if ANY of the user's role assignments grants it.
 * - Scopable permission: the union of the scopes of the assignments that grant it.
 *   organization-wide beats everything; otherwise a set of department ids + team ids.
 *   A department scope covers every team whose department_id is that department.
 * - Non-scopable permission: organization-level, held as-is regardless of assignment scope.
 */
import { PERMISSIONS, type PermissionKey, type ScopeGrant } from '@esports/shared';

export type Scope =
  { all: true } | { all: false; departmentIds: Set<string>; teamIds: Set<string> };

export interface TeamRef {
  id: string;
  departmentId: string | null;
}

export class Access {
  constructor(
    readonly organizationId: string,
    readonly userId: string,
    private readonly grants: Map<PermissionKey, Scope>,
    readonly isOwner: boolean,
  ) {}

  has(perm: PermissionKey): boolean {
    return this.grants.has(perm);
  }

  scope(perm: PermissionKey): Scope | null {
    return this.grants.get(perm) ?? null;
  }

  hasAll(perm: PermissionKey): boolean {
    return this.grants.get(perm)?.all === true;
  }

  /** Does `perm` cover this specific team? */
  coversTeam(perm: PermissionKey, team: TeamRef): boolean {
    const s = this.grants.get(perm);
    if (!s) return false;
    if (s.all === true) return true;
    return (
      s.teamIds.has(team.id) ||
      (team.departmentId !== null && s.departmentIds.has(team.departmentId))
    );
  }

  /**
   * Does `perm` cover placing something in this department? (e.g. creating a team in it).
   * `null` (no department) is only covered by an organization-wide grant.
   */
  coversDepartment(perm: PermissionKey, departmentId: string | null): boolean {
    const s = this.grants.get(perm);
    if (!s) return false;
    if (s.all === true) return true;
    return departmentId !== null && s.departmentIds.has(departmentId);
  }

  /** Serializable form, sent to the web app (for UI hints only — never trusted back). */
  toJSON(): { key: PermissionKey; scope: ScopeGrant }[] {
    return [...this.grants.entries()].map(([key, s]) => ({
      key,
      scope:
        s.all === true
          ? { all: true }
          : { all: false, departmentIds: [...s.departmentIds], teamIds: [...s.teamIds] },
    }));
  }

  static fromJSON(
    organizationId: string,
    userId: string,
    isOwner: boolean,
    entries: { key: PermissionKey; scope: ScopeGrant }[],
  ): Access {
    const grants = new Map<PermissionKey, Scope>();
    for (const { key, scope } of entries) {
      if (!(key in PERMISSIONS)) continue;
      grants.set(
        key,
        scope.all === true
          ? { all: true }
          : {
              all: false,
              departmentIds: new Set(scope.departmentIds),
              teamIds: new Set(scope.teamIds),
            },
      );
    }
    return new Access(organizationId, userId, grants, isOwner);
  }
}

/** One row of "this user holds this role over this scope". */
export interface AssignmentRow {
  grantsAll: boolean;
  permissionKeys: string[];
  scopeType: 'organization' | 'department' | 'team';
  departmentId: string | null;
  teamId: string | null;
}

/** Pure function: fold assignments into grants. Unit-tested directly. */
export function buildGrants(rows: AssignmentRow[]): {
  grants: Map<PermissionKey, Scope>;
  isOwner: boolean;
} {
  const grants = new Map<PermissionKey, Scope>();
  let isOwner = false;

  const grantAll = (key: PermissionKey) => grants.set(key, { all: true });

  for (const row of rows) {
    const keys: PermissionKey[] = row.grantsAll
      ? (Object.keys(PERMISSIONS) as PermissionKey[])
      : row.permissionKeys.filter((k): k is PermissionKey => k in PERMISSIONS);
    if (row.grantsAll) isOwner = true;

    for (const key of keys) {
      const def = PERMISSIONS[key];
      // Owner-only keys can only come from a grantsAll role; ignore stray rows defensively.
      if (def.ownerOnly && !row.grantsAll) continue;
      if (!def.scopable || row.scopeType === 'organization') {
        grantAll(key);
        continue;
      }
      const existing = grants.get(key);
      if (existing?.all === true) continue;
      const scope: Scope =
        existing && existing.all === false
          ? existing
          : { all: false, departmentIds: new Set<string>(), teamIds: new Set<string>() };
      if (row.scopeType === 'department' && row.departmentId)
        scope.departmentIds.add(row.departmentId);
      if (row.scopeType === 'team' && row.teamId) scope.teamIds.add(row.teamId);
      grants.set(key, scope);
    }
  }
  return { grants, isOwner };
}
