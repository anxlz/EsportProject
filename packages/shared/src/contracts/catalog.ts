/**
 * Contract vocabularies (spec §7). Keys are stored in the database; labels live in ./i18n.ts so the
 * dashboard and the generated documents use the same words.
 */

/**
 * Lifecycle.
 *   draft ──submit──▶ pending_approval ──approve──▶ approved ──start signing──▶ awaiting_signatures
 *     ▲                 │        │                     ▲                          │        │
 *     └────withdraw─────┘        │                     └──────cancel signing──────┘        │
 *                                └──reject (reason)──▶ changes_requested ──submit──▶ …     │
 *   draft / changes_requested ──cancel──▶ cancelled           all required signers signed ─┴─▶ signed
 */
export const CONTRACT_STATUSES = [
  'draft',
  'pending_approval',
  'changes_requested',
  'approved',
  'awaiting_signatures',
  'signed',
  'cancelled',
  'terminated',
] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const CONTRACT_TEXT_FONTS = [
  { family: 'Cairo', weights: [300, 400, 500, 600, 700, 800] },
  { family: 'Tajawal', weights: [300, 400, 500, 700, 800] },
  { family: 'IBM Plex Sans Arabic', weights: [300, 400, 500, 600, 700] },
  { family: 'Noto Kufi Arabic', weights: [300, 400, 500, 600, 700, 800] },
  { family: 'Almarai', weights: [300, 400, 700, 800] },
  { family: 'IBM Plex Sans', weights: [300, 400, 500, 600, 700] },
] as const;
export type ContractTextFontFamily = (typeof CONTRACT_TEXT_FONTS)[number]['family'];
export const CONTRACT_TEXT_FONT_FAMILIES = [
  'Cairo',
  'Tajawal',
  'IBM Plex Sans Arabic',
  'Noto Kufi Arabic',
  'Almarai',
  'IBM Plex Sans',
] as const satisfies readonly ContractTextFontFamily[];
export interface ContractTextStyle {
  fontFamily: ContractTextFontFamily;
  fontWeight: number;
  color: string;
}
export const DEFAULT_CONTRACT_TEXT_STYLE: ContractTextStyle = {
  fontFamily: 'Cairo',
  fontWeight: 400,
  color: '#1c2321',
};

export const TERMINATION_REASON_CODES = [
  'breach',
  'mutual_agreement',
  'non_performance',
  'force_majeure',
  'convenience',
  'other',
] as const;
export type TerminationReasonCode = (typeof TERMINATION_REASON_CODES)[number];

export const TERMINATION_STATUSES = [
  'requested',
  'pending_counterparty',
  'accepted',
  'rejected',
  'withdrawn',
  'executed',
  'expired',
] as const;
export type TerminationStatus = (typeof TERMINATION_STATUSES)[number];

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

// ---------- Electronic signatures (spec §7.7, Phase 4) ----------

/**
 * Who signs. The recipient always; a parent or guardian too when the recipient is under 18 on
 * the day signing starts — a second, separate signing step after the recipient's.
 */
export const SIGNER_ROLES = ['recipient', 'guardian'] as const;
export type SignerRole = (typeof SIGNER_ROLES)[number];
export const ADULT_AGE = 18;

export const SIGNING_ROUND_STATUSES = ['in_progress', 'completed', 'cancelled'] as const;
export type SigningRoundStatus = (typeof SIGNING_ROUND_STATUSES)[number];

export const SIGNER_STATUSES = ['pending', 'signed'] as const;
export type SignerStatus = (typeof SIGNER_STATUSES)[number];

/**
 * How the person opening a link proves they are the signer, before seeing the contract:
 * - `email_code`: a 6-digit code emailed to the signer's address (needs a mail transport);
 * - `access_code`: a 6-digit code shown once to the manager, who passes it on through a
 *   different channel than the link (phone, in person).
 */
export const VERIFICATION_METHODS = ['email_code', 'access_code'] as const;
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];

export const SIGNATURE_METHODS = ['typed', 'drawn'] as const;
export type SignatureMethod = (typeof SIGNATURE_METHODS)[number];

/** Typed signatures are drawn in this blue (spec: "rendered in blue"). Drawn ones use it too. */
export const SIGNATURE_INK = '#1d3fa8';

/** Fonts for typed signatures (all SIL OFL, bundled from @fontsource). */
export const SIGNATURE_FONTS = [
  { key: 'dancing-script', family: 'Dancing Script', scripts: ['latin'] },
  { key: 'great-vibes', family: 'Great Vibes', scripts: ['latin'] },
  { key: 'caveat', family: 'Caveat', scripts: ['latin'] },
  { key: 'aref-ruqaa', family: 'Aref Ruqaa', scripts: ['arabic', 'latin'] },
  { key: 'amiri', family: 'Amiri', scripts: ['arabic', 'latin'] },
] as const;
export type SignatureFontKey = (typeof SIGNATURE_FONTS)[number]['key'];
export const SIGNATURE_FONT_KEYS = SIGNATURE_FONTS.map((f) => f.key) as [
  SignatureFontKey,
  ...SignatureFontKey[],
];
const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
/** The script a typed signature is written in (Arabic if it contains any Arabic letter). */
export const scriptOf = (text: string): 'arabic' | 'latin' =>
  ARABIC_RE.test(text) ? 'arabic' : 'latin';
/** Fonts that can draw a typed signature in that script. */
export const signatureFontsFor = (text: string) =>
  SIGNATURE_FONTS.filter((f) => (f.scripts as readonly string[]).includes(scriptOf(text)));

/** Drawn signatures are vector strokes on a fixed canvas (coordinates in these units). */
export const DRAW_CANVAS = { width: 600, height: 200 } as const;
/** A drawn signature's minimum total path length, in canvas units (a dot isn't a signature). */
export const MIN_DRAWN_LENGTH = 60;

/**
 * ID-document patch: before signing, the RECIPIENT (not a guardian) uploads a photo or scan of a
 * passport or a national/government ID. It is stored encrypted, apart from the contract, and is
 * viewable only with `contracts.view_signer_id`. It strengthens the record of who signed; it is
 * not an official or certified identity check.
 */
export const ID_DOCUMENT_TYPES = ['passport', 'national_id'] as const;
export type IdDocumentType = (typeof ID_DOCUMENT_TYPES)[number];
/** Signer roles that must upload one. A guardian may be signing for a minor without either. */
export const ID_DOCUMENT_ROLES: readonly SignerRole[] = ['recipient'];
export const ID_DOCUMENT_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;
export const ID_DOCUMENT_MAX_BYTES = 8 * 1024 * 1024;

export const SIGNING_LINK_DEFAULT_DAYS = 7;
export const SIGNING_LINK_MAX_DAYS = 30;
/** Wrong codes allowed per link before it locks (a new link is then needed). */
export const VERIFY_MAX_ATTEMPTS = 5;
/** An emailed code is valid this long. */
export const EMAIL_CODE_MINUTES = 10;
/** After verifying, the signer has this long to review and sign before verifying again. */
export const SIGNING_SESSION_MINUTES = 30;
