/**
 * Phase 3 schema: stored files, the generic version history, document setup, contract types and
 * clause templates, contracts, approval requests and Custom Clause Assistant proposals.
 * Same rules as before: `app` schema, RLS on, composite (organization_id, id) foreign keys.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { ContractSnapshot } from '@esports/shared';
import { appSchema, games, organizations, teams, users } from './schema';
import { rosterMembers } from './schema-finance';

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => tstz('created_at').notNull().defaultNow();
const updatedAt = () => tstz('updated_at').notNull().defaultNow();
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/**
 * Uploaded assets (logo, background, approval stamp) and generated documents (approved
 * contracts), stored in Postgres. Rows are never updated: a new upload is a new row, and
 * generated documents are kept with their SHA-256 for integrity checks. See DECISIONS.md for why
 * this is Postgres rather than Supabase Storage for now.
 */
export const storedFiles = appSchema.table(
  'stored_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    data: bytea('data').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [unique('stored_files_org_id_unique').on(t.organizationId, t.id)],
);

/**
 * Generic, append-only version history (spec §3.3). One row per saved version of any entity;
 * contracts are the first user. `snapshot` is the complete state at that version and `sha256`
 * its fingerprint (canonical JSON), so a version can't change after the fact without detection.
 * UPDATE and DELETE are blocked by a trigger (migration 0005).
 */
export const entityVersions = appSchema.table(
  'entity_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    version: integer('version').notNull(),
    snapshot: jsonb('snapshot').notNull(),
    sha256: text('sha256').notNull(),
    note: text('note'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('entity_versions_org_id_unique').on(t.organizationId, t.id),
    unique('entity_versions_entity_version_unique').on(t.entityType, t.entityId, t.version),
    index('entity_versions_entity_idx').on(t.organizationId, t.entityType, t.entityId),
  ],
);

/** Organization legal details and the contract document layout (spec §7.1). One row per org. */
export const documentSettings = appSchema.table(
  'document_settings',
  {
    organizationId: uuid('organization_id')
      .primaryKey()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    legalNameEn: text('legal_name_en'),
    legalNameAr: text('legal_name_ar'),
    commercialRegistration: text('commercial_registration'),
    taxNumber: text('tax_number'),
    addressEn: text('address_en'),
    addressAr: text('address_ar'),
    email: text('email'),
    phone: text('phone'),
    website: text('website'),
    headerTextEn: text('header_text_en'),
    headerTextAr: text('header_text_ar'),
    footerTextEn: text('footer_text_en'),
    footerTextAr: text('footer_text_ar'),
    logoFileId: uuid('logo_file_id'),
    logoPosition: text('logo_position').notNull().default('start'),
    backgroundKind: text('background_kind').notNull().default('none'),
    backgroundFileId: uuid('background_file_id'),
    marginTopMm: integer('margin_top_mm').notNull().default(20),
    marginBottomMm: integer('margin_bottom_mm').notNull().default(20),
    marginStartMm: integer('margin_start_mm').notNull().default(18),
    marginEndMm: integer('margin_end_mm').notNull().default(18),
    pageBorder: boolean('page_border').notNull().default(false),
    fontSizePt: real('font_size_pt').notNull().default(10.5),
    lineHeight: real('line_height').notNull().default(1.55),
    defaultLanguage: text('default_language').notNull().default('bilingual'),
    stampFileId: uuid('stamp_file_id'),
    stampPosition: text('stamp_position').notNull().default('end'),
    stampWidthMm: integer('stamp_width_mm').notNull().default(35),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'document_settings_logo_fk',
      columns: [t.organizationId, t.logoFileId],
      foreignColumns: [storedFiles.organizationId, storedFiles.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'document_settings_background_fk',
      columns: [t.organizationId, t.backgroundFileId],
      foreignColumns: [storedFiles.organizationId, storedFiles.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'document_settings_stamp_fk',
      columns: [t.organizationId, t.stampFileId],
      foreignColumns: [storedFiles.organizationId, storedFiles.id],
    }).onDelete('restrict'),
  ],
);

/** Contract types: the four system defaults plus Owner-created custom types (spec §7.2). */
export const contractTypes = appSchema.table(
  'contract_types',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** player / coach / manager / staff for the system types; null for custom types. */
    key: text('key'),
    isSystem: boolean('is_system').notNull().default(false),
    nameEn: text('name_en').notNull(),
    nameAr: text('name_ar').notNull(),
    descriptionEn: text('description_en'),
    descriptionAr: text('description_ar'),
    archivedAt: tstz('archived_at'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('contract_types_org_id_unique').on(t.organizationId, t.id),
    uniqueIndex('contract_types_org_key_unique')
      .on(t.organizationId, t.key)
      .where(sql`${t.key} is not null`),
  ],
);

/** The ordered clause list of a contract type's template (Owner-only to edit, spec §7.3). */
export const templateClauses = appSchema.table(
  'template_clauses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    contractTypeId: uuid('contract_type_id').notNull(),
    position: integer('position').notNull(),
    required: boolean('required').notNull(),
    titleEn: text('title_en').notNull(),
    titleAr: text('title_ar').notNull(),
    bodyEn: text('body_en').notNull(),
    bodyAr: text('body_ar').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('template_clauses_type_idx').on(t.contractTypeId, t.position),
    foreignKey({
      name: 'template_clauses_type_fk',
      columns: [t.organizationId, t.contractTypeId],
      foreignColumns: [contractTypes.organizationId, contractTypes.id],
    }).onDelete('cascade'),
  ],
);

/** Per-organization, per-year counter for human-readable contract numbers (CT-2026-0001). */
export const contractCounters = appSchema.table(
  'contract_counters',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    year: integer('year').notNull(),
    last: integer('last').notNull(),
  },
  (t) => [primaryKey({ name: 'contract_counters_pk', columns: [t.organizationId, t.year] })],
);

export const contracts = appSchema.table(
  'contracts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    number: text('number').notNull(),
    contractTypeId: uuid('contract_type_id').notNull(),
    teamId: uuid('team_id'),
    rosterMemberId: uuid('roster_member_id'),
    gameId: uuid('game_id'),
    status: text('status').notNull().default('draft'),
    /** Denormalized from the latest version for lists and search. */
    title: text('title').notNull(),
    recipientName: text('recipient_name'),
    currentVersion: integer('current_version').notNull().default(0),
    approvedAt: tstz('approved_at'),
    approvedByUserId: uuid('approved_by_user_id').references(() => users.id),
    approvedRequestId: uuid('approved_request_id'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('contracts_org_id_unique').on(t.organizationId, t.id),
    unique('contracts_org_number_unique').on(t.organizationId, t.number),
    index('contracts_org_status_idx').on(t.organizationId, t.status),
    check(
      'contracts_roster_needs_team',
      sql`${t.rosterMemberId} is null or ${t.teamId} is not null`,
    ),
    foreignKey({
      name: 'contracts_type_fk',
      columns: [t.organizationId, t.contractTypeId],
      foreignColumns: [contractTypes.organizationId, contractTypes.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'contracts_team_fk',
      columns: [t.organizationId, t.teamId],
      foreignColumns: [teams.organizationId, teams.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'contracts_roster_member_fk',
      columns: [t.organizationId, t.teamId, t.rosterMemberId],
      foreignColumns: [rosterMembers.organizationId, rosterMembers.teamId, rosterMembers.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'contracts_game_fk',
      columns: [t.organizationId, t.gameId],
      foreignColumns: [games.organizationId, games.id],
    }).onDelete('restrict'),
  ],
);

/**
 * One row per submission. Each points at the exact version submitted, so the version history
 * shows every attempt with its decision, reviewer, time and comment (spec §7.6).
 */
export const approvalRequests = appSchema.table(
  'approval_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    contractId: uuid('contract_id').notNull(),
    versionId: uuid('version_id').notNull(),
    version: integer('version').notNull(),
    status: text('status').notNull().default('pending'),
    note: text('note'),
    requestedByUserId: uuid('requested_by_user_id')
      .notNull()
      .references(() => users.id),
    requestedAt: tstz('requested_at').notNull().defaultNow(),
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id),
    decidedAt: tstz('decided_at'),
    comment: text('comment'),
    selfApproved: boolean('self_approved').notNull().default(false),
    documentFileId: uuid('document_file_id'),
    documentSha256: text('document_sha256'),
  },
  (t) => [
    unique('approval_requests_org_id_unique').on(t.organizationId, t.id),
    // At most one open request per contract.
    uniqueIndex('approval_requests_one_pending')
      .on(t.contractId)
      .where(sql`${t.status} = 'pending'`),
    index('approval_requests_org_status_idx').on(t.organizationId, t.status),
    check(
      'approval_requests_reject_reason',
      sql`${t.status} <> 'rejected' or (${t.comment} is not null and length(trim(${t.comment})) > 0)`,
    ),
    check(
      'approval_requests_approved_document',
      sql`${t.status} <> 'approved' or ${t.documentFileId} is not null`,
    ),
    foreignKey({
      name: 'approval_requests_contract_fk',
      columns: [t.organizationId, t.contractId],
      foreignColumns: [contracts.organizationId, contracts.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'approval_requests_version_fk',
      columns: [t.organizationId, t.versionId],
      foreignColumns: [entityVersions.organizationId, entityVersions.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'approval_requests_document_fk',
      columns: [t.organizationId, t.documentFileId],
      foreignColumns: [storedFiles.organizationId, storedFiles.id],
    }).onDelete('restrict'),
  ],
);

/**
 * Custom Clause Assistant proposals (spec §7.4). A proposal never touches the contract by
 * itself; accepting it is a separate, explicit user action that saves a new version.
 */
export const clauseProposals = appSchema.table(
  'clause_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    contractId: uuid('contract_id').notNull(),
    requestedByUserId: uuid('requested_by_user_id')
      .notNull()
      .references(() => users.id),
    purpose: text('purpose').notNull(),
    feedback: text('feedback'),
    revisionOf: uuid('revision_of'),
    status: text('status').notNull().default('proposed'),
    output: jsonb('output')
      .$type<{
        titleEn: string;
        titleAr: string;
        bodyEn: string;
        bodyAr: string;
        questions: string[];
        notes: string | null;
      }>()
      .notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    createdAt: createdAt(),
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id),
    decidedAt: tstz('decided_at'),
  },
  (t) => [
    unique('clause_proposals_org_id_unique').on(t.organizationId, t.id),
    index('clause_proposals_contract_idx').on(t.contractId, t.createdAt),
    foreignKey({
      name: 'clause_proposals_contract_fk',
      columns: [t.organizationId, t.contractId],
      foreignColumns: [contracts.organizationId, contracts.id],
    }).onDelete('cascade'),
  ],
);

export type ContractSnapshotJson = ContractSnapshot;
