/**
 * Turns a permission Scope into a SQL WHERE fragment. Reused by every scopable resource:
 * teams now; rosters, expenses, contracts, etc. in later phases (join to `teams` and pass
 * `teams.id` / `teams.departmentId`).
 *
 * Returns `undefined` for organization-wide scope (no extra filter), and `false` when the scope
 * is empty so nothing leaks.
 */
import { inArray, or, type SQL, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Scope } from './access.js';

export function scopeCondition(
  scope: Scope | null,
  cols: { teamId: AnyPgColumn; departmentId: AnyPgColumn },
): SQL | undefined {
  if (!scope) return sql`false`;
  if (scope.all === true) return undefined;
  const parts: SQL[] = [];
  if (scope.teamIds.size) parts.push(inArray(cols.teamId, [...scope.teamIds]));
  if (scope.departmentIds.size) parts.push(inArray(cols.departmentId, [...scope.departmentIds]));
  return parts.length ? or(...parts) : sql`false`;
}
