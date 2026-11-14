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
import {
  DEFAULT_CONTRACT_TEXT_STYLE,
  type ContractSnapshot,
  type ContractTextStyle,
  type TerminationReasonCode,
  type TerminationStatus,
} from '@esports/shared';
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
    textStyle: jsonb('text_style')
      .$type<ContractTextStyle>()
      .notNull()
      .default(DEFAULT_CONTRACT_TEXT_STYLE),
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

export const contractTerminations = appSchema.table(
  'contract_terminations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    contractId: uuid('contract_id').notNull(),
    initiatedByUserId: uuid('initiated_by_user_id')
      .notNull()
      .references(() => users.id),
    initiatorRole: text('initiator_role').notNull(),
    reasonCode: text('reason_code').$type<TerminationReasonCode>().notNull(),
    reasonDetails: text('reason_details'),
    effectiveDate: text('effective_date').notNull(),
    noticePeriodDays: integer('notice_period_days').notNull().default(0),
    status: text('status').$type<TerminationStatus>().notNull().default('requested'),
    counterpartyResponseAt: tstz('counterparty_response_at'),
    counterpartyNote: text('counterparty_note'),
    settlementNotes: text('settlement_notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('contract_terminations_org_id_unique').on(t.organizationId, t.id),
    uniqueIndex('contract_terminations_one_active')
      .on(t.organizationId, t.contractId)
      .where(sql`${t.status} in ('requested', 'pending_counterparty', 'accepted')`),
    index('contract_terminations_due_idx').on(t.status, t.effectiveDate),
    foreignKey({
      name: 'contract_terminations_contract_fk',
      columns: [t.organizationId, t.contractId],
      foreignColumns: [contracts.organizationId, contracts.id],
    }).onDelete('restrict'),
    check('contract_terminations_notice_days', sql`${t.noticePeriodDays} between 0 and 3650`),
    check(
      'contract_terminations_effective_date',
      sql`${t.effectiveDate} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`,
    ),
    check(
      'contract_terminations_reason_details',
      sql`${t.reasonCode} not in ('breach', 'non_performance') or length(trim(coalesce(${t.reasonDetails}, ''))) > 0`,
    ),
    check(
      'contract_terminations_status_check',
      sql`${t.status} in ('requested', 'pending_counterparty', 'accepted', 'rejected', 'withdrawn', 'executed', 'expired')`,
    ),
    check(
      'contract_terminations_reason_code_check',
      sql`${t.reasonCode} in ('breach', 'mutual_agreement', 'non_performance', 'force_majeure', 'convenience', 'other')`,
    ),
  ],
);

export const contractTerminationEvents = appSchema.table(
  'contract_termination_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    terminationId: uuid('termination_id').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    actorRole: text('actor_role').notNull(),
    action: text('action').notNull(),
    fromStatus: text('from_status').$type<TerminationStatus>(),
    toStatus: text('to_status').$type<TerminationStatus>().notNull(),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('contract_termination_events_org_id_unique').on(t.organizationId, t.id),
    index('contract_termination_events_history_idx').on(
      t.organizationId,
      t.terminationId,
      t.createdAt,
    ),
    check(
      'contract_termination_events_action_check',
      sql`${t.action} in ('requested', 'accepted', 'rejected', 'withdrawn', 'executed', 'expired')`,
    ),
    check(
      'contract_termination_events_to_status_check',
      sql`${t.toStatus} in ('requested', 'pending_counterparty', 'accepted', 'rejected', 'withdrawn', 'executed', 'expired')`,
    ),
    check(
      'contract_termination_events_from_status_check',
      sql`${t.fromStatus} is null or ${t.fromStatus} in ('requested', 'pending_counterparty', 'accepted', 'rejected', 'withdrawn', 'executed', 'expired')`,
    ),
    foreignKey({
      name: 'contract_termination_events_termination_fk',
      columns: [t.organizationId, t.terminationId],
      foreignColumns: [contractTerminations.organizationId, contractTerminations.id],
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

// ---------- Electronic signatures (Phase 4, spec §7.7) ----------

/**
 * One attempt at collecting every required signature on an approved contract. The required
 * signers are fixed when the round starts (recipient; guardian too if the recipient is a minor
 * that day). Cancelling a round revokes its links; a new round starts from scratch.
 */
export const signingRounds = appSchema.table(
  'signing_rounds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    contractId: uuid('contract_id').notNull(),
    approvalRequestId: uuid('approval_request_id').notNull(),
    status: text('status').notNull().default('in_progress'),
    minor: boolean('minor').notNull(),
    minorOn: text('minor_on').notNull(),
    /** SHA-256 of the stamped approved PDF every signer signs. */
    approvedDocumentSha256: text('approved_document_sha256').notNull(),
    startedByUserId: uuid('started_by_user_id').references(() => users.id),
    startedAt: tstz('started_at').notNull().defaultNow(),
    completedAt: tstz('completed_at'),
    cancelledAt: tstz('cancelled_at'),
    cancelledByUserId: uuid('cancelled_by_user_id').references(() => users.id),
    cancelReason: text('cancel_reason'),
    signedDocumentFileId: uuid('signed_document_file_id'),
    signedDocumentSha256: text('signed_document_sha256'),
  },
  (t) => [
    unique('signing_rounds_org_id_unique').on(t.organizationId, t.id),
    uniqueIndex('signing_rounds_one_open')
      .on(t.contractId)
      .where(sql`${t.status} = 'in_progress'`),
    check(
      'signing_rounds_completed_document',
      sql`${t.status} <> 'completed' or (${t.signedDocumentFileId} is not null and ${t.completedAt} is not null)`,
    ),
    check(
      'signing_rounds_cancel_reason',
      sql`${t.status} <> 'cancelled' or (${t.cancelReason} is not null and length(trim(${t.cancelReason})) > 0)`,
    ),
    foreignKey({
      name: 'signing_rounds_contract_fk',
      columns: [t.organizationId, t.contractId],
      foreignColumns: [contracts.organizationId, contracts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'signing_rounds_approval_fk',
      columns: [t.organizationId, t.approvalRequestId],
      foreignColumns: [approvalRequests.organizationId, approvalRequests.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'signing_rounds_document_fk',
      columns: [t.organizationId, t.signedDocumentFileId],
      foreignColumns: [storedFiles.organizationId, storedFiles.id],
    }).onDelete('restrict'),
  ],
);

/**
 * A required signer and, once given, their signature with its consent record. A signed row can
 * never change (trigger in migration 0007).
 */
export const contractSigners = appSchema.table(
  'contract_signers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    roundId: uuid('round_id').notNull(),
    role: text('role').notNull(),
    signOrder: integer('sign_order').notNull(),
    nameEn: text('name_en'),
    nameAr: text('name_ar'),
    email: text('email'),
    phone: text('phone'),
    relationship: text('relationship'),
    status: text('status').notNull().default('pending'),
    // The signature and its record (null until signed).
    signedAt: tstz('signed_at'),
    signedViaLinkId: uuid('signed_via_link_id'),
    verificationMethod: text('verification_method'),
    verificationDestination: text('verification_destination'),
    verifiedAt: tstz('verified_at'),
    signatureMethod: text('signature_method'),
    typedName: text('typed_name'),
    fontKey: text('font_key'),
    strokes: jsonb('strokes').$type<[number, number][][]>(),
    consentVersion: text('consent_version'),
    consentLocale: text('consent_locale'),
    consentText: text('consent_text'),
    /** SHA-256 of the approved PDF this person signed. */
    documentSha256: text('document_sha256'),
    /** SHA-256 over the canonical signature record (who, what, when, how). */
    recordSha256: text('record_sha256'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    /**
     * ID-document patch: the identity document this signature was given with (recipients).
     * Foreign key and "must belong to this signer" rule in migration 0013.
     */
    idDocumentId: uuid('id_document_id'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('contract_signers_org_id_unique').on(t.organizationId, t.id),
    unique('contract_signers_round_role_unique').on(t.roundId, t.role),
    check(
      'contract_signers_signed_record',
      sql`${t.status} <> 'signed' or (${t.signedAt} is not null and ${t.signatureMethod} is not null and ${t.consentText} is not null and ${t.documentSha256} is not null and ${t.verifiedAt} is not null and ${t.recordSha256} is not null)`,
    ),
    foreignKey({
      name: 'contract_signers_round_fk',
      columns: [t.organizationId, t.roundId],
      foreignColumns: [signingRounds.organizationId, signingRounds.id],
    }).onDelete('restrict'),
  ],
);

/**
 * Signing links. Only a hash of the token is stored. A signer has at most one usable link: a
 * new one replaces the old. Codes (emailed or handed over) are stored as keyed hashes.
 */
export const signingLinks = appSchema.table(
  'signing_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    signerId: uuid('signer_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    method: text('method').notNull(),
    destination: text('destination'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    createdAt: createdAt(),
    expiresAt: tstz('expires_at').notNull(),
    revokedAt: tstz('revoked_at'),
    revokedByUserId: uuid('revoked_by_user_id').references(() => users.id),
    revokeReason: text('revoke_reason'),
    usedAt: tstz('used_at'),
    lockedAt: tstz('locked_at'),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    accessCodeHash: text('access_code_hash'),
    emailCodeHash: text('email_code_hash'),
    emailCodeExpiresAt: tstz('email_code_expires_at'),
    emailCodesSent: integer('email_codes_sent').notNull().default(0),
    lastCodeSentAt: tstz('last_code_sent_at'),
    openedAt: tstz('opened_at'),
    verifiedAt: tstz('verified_at'),
  },
  (t) => [
    unique('signing_links_token_unique').on(t.tokenHash),
    index('signing_links_signer_idx').on(t.signerId),
    foreignKey({
      name: 'signing_links_signer_fk',
      columns: [t.organizationId, t.signerId],
      foreignColumns: [contractSigners.organizationId, contractSigners.id],
    }).onDelete('restrict'),
  ],
);

/**
 * ID-document patch: the identity document (passport or national ID) a recipient uploads before
 * signing. The bytes are in `stored_files` (kind `signer_id_document`), ENCRYPTED with AES-256-GCM
 * (see contracts/signer-id.service.ts); this row holds what is needed to find, decrypt and check
 * them. It is never part of the contract PDF and is served only to holders of
 * `contracts.view_signer_id`, each view audited.
 *
 * Rows are never deleted or edited (migration 0013): how long they are kept is an open product
 * decision. The only change allowed is marking an upload superseded when the signer replaces it
 * before signing.
 */
export const signerIdDocuments = appSchema.table(
  'signer_id_documents',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    roundId: uuid('round_id').notNull(),
    signerId: uuid('signer_id').notNull(),
    fileId: uuid('file_id').notNull(),
    documentType: text('document_type').notNull(),
    /** The real type of the original bytes (sniffed, not declared). */
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    /** SHA-256 of the original (decrypted) bytes. */
    sha256: text('sha256').notNull(),
    uploadedViaLinkId: uuid('uploaded_via_link_id')
      .notNull()
      .references(() => signingLinks.id),
    uploadedAt: tstz('uploaded_at').notNull().defaultNow(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    supersededAt: tstz('superseded_at'),
  },
  (t) => [
    unique('signer_id_documents_org_id_unique').on(t.organizationId, t.id),
    uniqueIndex('signer_id_documents_one_current')
      .on(t.signerId)
      .where(sql`${t.supersededAt} is null`),
    index('signer_id_documents_round_idx').on(t.roundId),
    foreignKey({
      name: 'signer_id_documents_round_fk',
      columns: [t.organizationId, t.roundId],
      foreignColumns: [signingRounds.organizationId, signingRounds.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'signer_id_documents_signer_fk',
      columns: [t.organizationId, t.signerId],
      foreignColumns: [contractSigners.organizationId, contractSigners.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'signer_id_documents_file_fk',
      columns: [t.organizationId, t.fileId],
      foreignColumns: [storedFiles.organizationId, storedFiles.id],
    }).onDelete('restrict'),
  ],
);
