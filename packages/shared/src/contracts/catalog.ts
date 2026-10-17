/**
 * Contract vocabularies (spec §7). Keys are stored in the database; labels live in ./i18n.ts so the
 * dashboard and the generated documents use the same words.
 */

/**
 * Lifecycle in Phase 3. Phase 4 (signatures) adds the signing states after `approved`.
 *   draft ──submit──▶ pending_approval ──approve──▶ approved
 *     ▲                 │        │
 *     └────withdraw─────┘        └──reject (reason required)──▶ changes_requested ──submit──▶ …
 *   draft / changes_requested ──cancel──▶ cancelled
 */
export const CONTRACT_STATUSES = [
  'draft',
  'pending_approval',
  'changes_requested',
  'approved',
  'cancelled',
] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

/** Statuses in which the working copy may be edited (each save is a new version). */
export const EDITABLE_STATUSES: readonly ContractStatus[] = ['draft', 'changes_requested'];

export const APPROVAL_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'withdrawn'] as const;
export type ApprovalRequestStatus = (typeof APPROVAL_REQUEST_STATUSES)[number];

/** Which language(s) the document is produced in. Bilingual = English and Arabic side by side. */
export const DOCUMENT_LANGUAGES = ['bilingual', 'ar', 'en'] as const;
export type DocumentLanguage = (typeof DOCUMENT_LANGUAGES)[number];

export const RECIPIENT_KINDS = ['player', 'coach', 'manager', 'staff', 'other'] as const;
export type RecipientKind = (typeof RECIPIENT_KINDS)[number];

/** The fixed default contract types (spec §7.2). Owners can add custom types alongside them. */
export const SYSTEM_CONTRACT_TYPES = ['player', 'coach', 'manager', 'staff'] as const;
export type SystemContractType = (typeof SYSTEM_CONTRACT_TYPES)[number];

export const CLAUSE_SOURCES = ['template', 'custom', 'assistant'] as const;
export type ClauseSource = (typeof CLAUSE_SOURCES)[number];

/**
 * Placeholders a clause can use, written `{{fieldName}}`. Values come from the contract details
 * at render time; a placeholder with no value is shown as missing and blocks submission.
 */
export const MERGE_FIELDS = [
  'organizationName',
  'organizationLegalName',
  'contractNumber',
  'recipientName',
  'teamName',
  'gameName',
  'role',
  'startDate',
  'endDate',
  'duration',
  'salary',
  'paymentFrequency',
] as const;
export type MergeField = (typeof MERGE_FIELDS)[number];

export const STAMP_POSITIONS = ['start', 'center', 'end'] as const;
export type StampPosition = (typeof STAMP_POSITIONS)[number];

export const LOGO_POSITIONS = ['start', 'center', 'end'] as const;
export type LogoPosition = (typeof LOGO_POSITIONS)[number];

export const BACKGROUND_KINDS = ['none', 'image', 'pdf'] as const;
export type BackgroundKind = (typeof BACKGROUND_KINDS)[number];

/** Uploadable asset kinds and their limits. SVG is deliberately not accepted (script risk). */
export const FILE_KINDS = ['logo', 'background', 'stamp'] as const;
export type FileKind = (typeof FILE_KINDS)[number];
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const FILE_LIMITS: Record<FileKind, { maxBytes: number; types: readonly string[] }> = {
  logo: { maxBytes: 2 * 1024 * 1024, types: IMAGE_TYPES },
  stamp: { maxBytes: 2 * 1024 * 1024, types: IMAGE_TYPES },
  background: { maxBytes: 5 * 1024 * 1024, types: [...IMAGE_TYPES, 'application/pdf'] },
};
