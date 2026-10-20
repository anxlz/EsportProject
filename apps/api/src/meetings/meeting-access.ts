/**
 * Who may see, create, change and answer a meeting (DECISIONS.md "Meetings").
 *
 * - A meeting belongs to a team, a department, or the whole organization. `meetings.*` scopes
 *   follow the same rule as finance records: a team meeting is covered when the scope covers
 *   the team; a department meeting when it covers the department; an organization-level meeting
 *   only by an organization-wide grant. Administrative meetings need `meetings.administrative`
 *   (Owner-only) to create or change.
 * - Everyone invited sees the meeting and can answer it, whatever their scopes.
 * - Organizers change their own meetings while they still may create meetings there;
 *   `meetings.manage` changes any meeting in scope.
 */
import type { PermissionKey } from '@esports/shared';
import type { Access, TeamRef } from '../authz/access';

export interface MeetingScope {
  kind: string;
  team: TeamRef | null;
  departmentId: string | null;
}

export function covers(access: Access, perm: PermissionKey, m: MeetingScope): boolean {
  if (m.team) return access.coversTeam(perm, m.team);
  if (m.departmentId) return access.coversDepartment(perm, m.departmentId);
  return access.hasAll(perm);
}

export function canCreateIn(access: Access, m: MeetingScope): boolean {
  if (m.kind === 'administrative') return access.has('meetings.administrative');
  return covers(access, 'meetings.create', m);
}

export function canView(access: Access, m: MeetingScope, isParticipant: boolean): boolean {
  if (isParticipant) return true;
  if (m.kind === 'administrative') return access.hasAll('meetings.view');
  return covers(access, 'meetings.view', m);
}

export function canEdit(access: Access, m: MeetingScope, isOrganizer: boolean): boolean {
  if (m.kind === 'administrative') return access.has('meetings.administrative');
  if (covers(access, 'meetings.manage', m)) return true;
  return isOrganizer && covers(access, 'meetings.create', m);
}
