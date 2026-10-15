/**
 * Database schema.
 *
 * All tables live in the `app` Postgres schema rather than `public`. On Supabase, `public` is
 * exposed through the auto-generated REST API to anyone holding the (public) anon key, so tenant
 * data must never live there. RLS is additionally enabled on every table with no policies (see
 * migration 0001), denying the anon/authenticated roles outright. The API connects as the table
 * owner and enforces tenancy + permissions in application code.
 *
 * Tenant integrity: tenant-owned rows reference each other through COMPOSITE foreign keys
 * (organization_id, id), so the database itself rejects e.g. a team pointing at another
 * organization's department.
 */
import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const appSchema = pgSchema('app');

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => tstz('created_at').notNull().defaultNow();
const updatedAt = () => tstz('updated_at').notNull().defaultNow();
const LOCALES = ['ar', 'en'] as const;

// ---------------------------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------------------------

export const organizations = appSchema.table('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique('organizations_slug_unique'),
  defaultLocale: text('default_locale', { enum: LOCALES }).notNull().default('en'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const users = appSchema.table(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Always stored lower-cased; uniqueness enforced case-insensitively as well. */
    email: text('email').notNull(),
    /** Null for accounts that have only ever signed in with Discord. */
    passwordHash: text('password_hash'),
    displayName: text('display_name').notNull(),
    locale: text('locale', { enum: LOCALES }),
    lastActiveOrganizationId: uuid('last_active_organization_id').references(
      () => organizations.id,
      { onDelete: 'set null' },
    ),
    passwordChangedAt: tstz('password_changed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_email_lower_unique').on(sql`lower(${t.email})`)],
);

export const userIdentities = appSchema.table(
  'user_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider', { enum: ['discord'] }).notNull(),
    providerUserId: text('provider_user_id').notNull(),
    providerUsername: text('provider_username'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('user_identities_provider_subject_unique').on(t.provider, t.providerUserId),
    unique('user_identities_user_provider_unique').on(t.userId, t.provider),
  ],
);

/**
 * Platform operators. Deliberately a separate table, never a tenant role: it cannot be granted
 * through any tenant role-management endpoint, only via the CLI (src/cli/platform-admin.ts).
 */
export const platformAdmins = appSchema.table('platform_admins', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  grantedAt: createdAt(),
  note: text('note'),
});

// ---------------------------------------------------------------------------------------------
// Tenancy & membership
// ---------------------------------------------------------------------------------------------

export const organizationMembers = appSchema.table(
  'organization_members',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['active', 'suspended'] })
      .notNull()
      .default('active'),
    suspendedAt: tstz('suspended_at'),
    suspendedByUserId: uuid('suspended_by_user_id').references(() => users.id),
    suspendedReason: text('suspended_reason'),
    invitedByUserId: uuid('invited_by_user_id').references(() => users.id),
    joinedAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: 'organization_members_pk', columns: [t.organizationId, t.userId] }),
    index('organization_members_user_idx').on(t.userId),
  ],
);

// ---------------------------------------------------------------------------------------------
// Organization structure
// ---------------------------------------------------------------------------------------------

export const departments = appSchema.table(
  'departments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('departments_org_id_unique').on(t.organizationId, t.id),
    uniqueIndex('departments_org_name_unique').on(t.organizationId, sql`lower(${t.name})`),
  ],
);

/** Games are a configurable, per-organization entity (seeded with defaults, fully editable). */
export const games = appSchema.table(
  'games',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    shortName: text('short_name'),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('games_org_id_unique').on(t.organizationId, t.id),
    uniqueIndex('games_org_name_unique').on(t.organizationId, sql`lower(${t.name})`),
  ],
);

export const teams = appSchema.table(
  'teams',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    departmentId: uuid('department_id'),
    gameId: uuid('game_id'),
    name: text('name').notNull(),
    region: text('region'),
    status: text('status', { enum: ['active', 'inactive'] })
      .notNull()
      .default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('teams_org_id_unique').on(t.organizationId, t.id),
    uniqueIndex('teams_org_name_unique').on(t.organizationId, sql`lower(${t.name})`),
    index('teams_department_idx').on(t.departmentId),
    foreignKey({
      name: 'teams_department_fk',
      columns: [t.organizationId, t.departmentId],
      foreignColumns: [departments.organizationId, departments.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'teams_game_fk',
      columns: [t.organizationId, t.gameId],
      foreignColumns: [games.organizationId, games.id],
    }).onDelete('restrict'),
  ],
);

// ---------------------------------------------------------------------------------------------
// Roles & permissions (roles are data, not code)
// ---------------------------------------------------------------------------------------------

export const roles = appSchema.table(
  'roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    nameEn: text('name_en'),
    nameAr: text('name_ar'),
    descriptionEn: text('description_en'),
    descriptionAr: text('description_ar'),
    /** System roles (the Owner role) cannot be edited or deleted. */
    isSystem: boolean('is_system').notNull().default(false),
    /** Grants every permission, including owner-only ones. Only ever true on the Owner role. */
    grantsAll: boolean('grants_all').notNull().default(false),
    /** Which default template a role was seeded from; informational only. */
    templateKey: text('template_key'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('roles_org_id_unique').on(t.organizationId, t.id),
    uniqueIndex('roles_one_system_role_per_org')
      .on(t.organizationId)
      .where(sql`${t.isSystem}`),
    check('roles_name_present', sql`${t.nameEn} is not null or ${t.nameAr} is not null`),
    check('roles_grants_all_is_system', sql`not ${t.grantsAll} or ${t.isSystem}`),
  ],
);

export const rolePermissions = appSchema.table(
  'role_permissions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionKey: text('permission_key').notNull(),
  },
  (t) => [primaryKey({ name: 'role_permissions_pk', columns: [t.roleId, t.permissionKey] })],
);

/**
 * Who holds which role, and over what scope. scope_type 'organization' = organization-wide;
 * 'department' = the department's teams; 'team' = that team only. Two typed FK columns are used
 * instead of a polymorphic scope_id so the database enforces referential + tenant integrity and
 * cascades when a team is deleted.
 */
export const userRoleAssignments = appSchema.table(
  'user_role_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    userId: uuid('user_id').notNull(),
    roleId: uuid('role_id').notNull(),
    scopeType: text('scope_type', { enum: ['organization', 'department', 'team'] }).notNull(),
    departmentId: uuid('department_id'),
    teamId: uuid('team_id'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('user_role_assignments_org_user_idx').on(t.organizationId, t.userId),
    unique('user_role_assignments_unique')
      .on(t.organizationId, t.userId, t.roleId, t.scopeType, t.departmentId, t.teamId)
      .nullsNotDistinct(),
    check(
      'user_role_assignments_scope_consistent',
      sql`(${t.scopeType} = 'organization' and ${t.departmentId} is null and ${t.teamId} is null)
       or (${t.scopeType} = 'department' and ${t.departmentId} is not null and ${t.teamId} is null)
       or (${t.scopeType} = 'team' and ${t.teamId} is not null and ${t.departmentId} is null)`,
    ),
    foreignKey({
      name: 'user_role_assignments_member_fk',
      columns: [t.organizationId, t.userId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.userId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'user_role_assignments_role_fk',
      columns: [t.organizationId, t.roleId],
      foreignColumns: [roles.organizationId, roles.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'user_role_assignments_department_fk',
      columns: [t.organizationId, t.departmentId],
      foreignColumns: [departments.organizationId, departments.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'user_role_assignments_team_fk',
      columns: [t.organizationId, t.teamId],
      foreignColumns: [teams.organizationId, teams.id],
    }).onDelete('cascade'),
  ],
);

// ---------------------------------------------------------------------------------------------
// Invitations & credential recovery (tokens are stored only as SHA-256 hashes)
// ---------------------------------------------------------------------------------------------

export interface StoredInvitationAssignment {
  roleId: string;
  scopeType: 'organization' | 'department' | 'team';
  scopeId: string | null;
}

export const invitations = appSchema.table(
  'invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull().unique('invitations_token_hash_unique'),
    assignments: jsonb('assignments').$type<StoredInvitationAssignment[]>().notNull(),
    makeOwner: boolean('make_owner').notNull().default(false),
    invitedByUserId: uuid('invited_by_user_id').references(() => users.id),
    createdAt: createdAt(),
    expiresAt: tstz('expires_at').notNull(),
    acceptedAt: tstz('accepted_at'),
    acceptedByUserId: uuid('accepted_by_user_id').references(() => users.id),
    revokedAt: tstz('revoked_at'),
  },
  (t) => [index('invitations_org_email_idx').on(t.organizationId, t.email)],
);

export const passwordResetTokens = appSchema.table('password_reset_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique('password_reset_tokens_hash_unique'),
  createdAt: createdAt(),
  expiresAt: tstz('expires_at').notNull(),
  usedAt: tstz('used_at'),
  requestedIp: text('requested_ip'),
});

// ---------------------------------------------------------------------------------------------
// Shared services: audit log (append-only, enforced by trigger) and notifications
// ---------------------------------------------------------------------------------------------

export const auditLogs = appSchema.table(
  'audit_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** Null for platform-level or pre-authentication security events. */
    organizationId: uuid('organization_id').references(() => organizations.id),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    actorType: text('actor_type', {
      enum: ['user', 'platform_admin', 'system', 'anonymous'],
    }).notNull(),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_logs_org_created_idx').on(t.organizationId, t.createdAt),
    index('audit_logs_action_idx').on(t.action),
  ],
);

export const notifications = appSchema.table(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    recipientUserId: uuid('recipient_user_id').notNull(),
    type: text('type').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    link: text('link'),
    readAt: tstz('read_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('notifications_recipient_idx').on(t.organizationId, t.recipientUserId, t.createdAt),
    foreignKey({
      name: 'notifications_member_fk',
      columns: [t.organizationId, t.recipientUserId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.userId],
    }).onDelete('cascade'),
  ],
);

/**
 * Development/test-only mail sink (MAIL_TRANSPORT=outbox). Refused at startup in production,
 * because it stores message bodies — including password-reset links — in plain text.
 */
export const devOutbox = appSchema.table('dev_outbox', {
  id: uuid('id').primaryKey().defaultRandom(),
  to: text('to').notNull(),
  subject: text('subject').notNull(),
  text: text('text').notNull(),
  template: text('template').notNull(),
  createdAt: createdAt(),
});
