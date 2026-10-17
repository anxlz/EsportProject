/** Response shapes returned by the API. The web app imports these for type safety. */
import type { PermissionKey, ScopeType } from './permissions';
import type { Locale } from './schemas';

/** Stable machine-readable error codes. The web app translates these; never show raw messages. */
export const ERROR_CODES = [
  'validation_failed',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'invalid_credentials',
  'account_suspended',
  'no_active_organization',
  'origin_not_allowed',
  'signup_disabled',
  'slug_taken',
  'email_taken',
  'invalid_or_expired_token',
  'login_required',
  'email_mismatch',
  'already_member',
  'last_owner',
  'cannot_target_self',
  'owner_only_permission',
  'system_role_locked',
  'role_in_use',
  'invalid_scope',
  'department_not_empty',
  'game_in_use',
  'discord_not_configured',
  'discord_not_linked',
  'discord_already_linked',
  'oauth_state_invalid',
  'fx_rate_required',
  'base_currency_locked',
  'currency_not_enabled',
  'roster_member_mismatch',
  'season_overlap',
  'in_use',
  'export_failed',
  'internal_error',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown };
}

export type ScopeGrant = { all: true } | { all: false; departmentIds: string[]; teamIds: string[] };

export interface MeResponse {
  user: {
    id: string;
    email: string;
    displayName: string;
    locale: Locale | null;
    hasPassword: boolean;
    discordLinked: boolean;
    discordUsername: string | null;
  };
  isPlatformAdmin: boolean;
  activeOrganization: {
    id: string;
    name: string;
    slug: string;
    defaultLocale: Locale;
  } | null;
  memberships: { organizationId: string; name: string; status: 'active' | 'suspended' }[];
  isOwner: boolean;
  permissions: { key: PermissionKey; scope: ScopeGrant }[];
}

export interface RoleDto {
  id: string;
  nameEn: string | null;
  nameAr: string | null;
  descriptionEn: string | null;
  descriptionAr: string | null;
  isSystem: boolean;
  grantsAll: boolean;
  templateKey: string | null;
  permissions: PermissionKey[];
  assignmentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AssignmentDto {
  id: string;
  roleId: string;
  roleNameEn: string | null;
  roleNameAr: string | null;
  scopeType: ScopeType;
  scopeId: string | null;
  scopeName: string | null;
}

export interface MemberDto {
  userId: string;
  email: string;
  displayName: string;
  status: 'active' | 'suspended';
  suspendedAt: string | null;
  suspendedReason: string | null;
  joinedAt: string;
  isOwner: boolean;
  assignments: AssignmentDto[];
}

export interface InvitationDto {
  id: string;
  email: string;
  makeOwner: boolean;
  assignments: { roleId: string; scopeType: ScopeType; scopeId: string | null }[];
  invitedBy: { id: string; displayName: string } | null;
  createdAt: string;
  expiresAt: string;
}

export interface PublicInvitationDto {
  organizationName: string;
  email: string;
  inviterName: string | null;
  expiresAt: string;
  accountExists: boolean;
}

export interface DepartmentDto {
  id: string;
  name: string;
  description: string | null;
  teamCount: number;
  createdAt: string;
}

export interface TeamDto {
  id: string;
  name: string;
  departmentId: string | null;
  departmentName: string | null;
  gameId: string | null;
  gameName: string | null;
  region: string | null;
  status: 'active' | 'inactive';
  createdAt: string;
  updatedAt: string;
}

export interface GameDto {
  id: string;
  name: string;
  shortName: string | null;
  isActive: boolean;
  teamCount: number;
}

export interface AuditLogDto {
  id: string;
  action: string;
  actor: { id: string; displayName: string } | null;
  actorType: 'user' | 'platform_admin' | 'system' | 'anonymous';
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
}

/** Notification types. Text is rendered client-side from these keys so it follows the UI language. */
export const NOTIFICATION_TYPES = [
  'member.joined',
  'member.roles_changed',
  'member.ownership_granted',
  'member.ownership_revoked',
  'member.reactivated',
  'budget.exceeded',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export interface NotificationDto {
  id: string;
  type: NotificationType;
  data: Record<string, unknown>;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface AuthConfigDto {
  discordEnabled: boolean;
  signupEnabled: boolean;
}

export interface PlatformOrganizationDto {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  memberCount: number;
  activeMemberCount: number;
  ownerEmails: string[];
}
