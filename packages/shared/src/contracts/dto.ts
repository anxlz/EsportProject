/** Response shapes for Phase 3 (contracts). */
import type {
  ApprovalRequestStatus,
  BackgroundKind,
  ClauseSource,
  ContractStatus,
  ContractTextStyle,
  DocumentLanguage,
  IdDocumentType,
  LogoPosition,
  SignatureFontKey,
  SignatureMethod,
  SignerRole,
  SignerStatus,
  SigningRoundStatus,
  StampPosition,
  TerminationReasonCode,
  TerminationStatus,
  VerificationMethod,
} from './catalog.js';
import type { ContractDetailsInput } from './schemas.js';

export interface ContractClause {
  id: string;
  templateClauseId: string | null;
  source: ClauseSource;
  required: boolean;
  included: boolean;
  titleEn: string;
  titleAr: string;
  bodyEn: string;
  bodyAr: string;
}

/**
 * Everything a version of a contract says, frozen at save time (names of the team, game and type
 * included, so the document never changes when those are renamed later).
 */
export interface ContractSnapshot {
  contractTypeId: string;
  typeNameEn: string;
  typeNameAr: string;
  teamId: string | null;
  teamName: string | null;
  gameName: string | null;
  rosterMemberId: string | null;
  details: ContractDetailsInput;
  clauses: ContractClause[];
  textStyle?: ContractTextStyle;
}

export interface ContractVersionDto {
  version: number;
  sha256: string;
  /** The stored snapshot still matches its fingerprint. */
  verified: boolean;
  note: string | null;
  createdBy: { id: string; displayName: string } | null;
  createdAt: string;
}

export interface ApprovalRequestDto {
  id: string;
  contractId: string;
  contractNumber: string;
  contractTitle: string;
  version: number;
  status: ApprovalRequestStatus;
  note: string | null;
  requestedBy: { id: string; displayName: string };
  requestedAt: string;
  decidedBy: { id: string; displayName: string } | null;
  decidedAt: string | null;
  /** Rejection reason or approval comment. */
  comment: string | null;
  selfApproved: boolean;
  /** SHA-256 of the stamped approved PDF (approved requests only). */
  documentSha256: string | null;
}

export interface ContractSummaryDto {
  id: string;
  number: string;
  title: string;
  status: ContractStatus;
  contractTypeId: string;
  typeNameEn: string;
  typeNameAr: string;
  teamId: string | null;
  teamName: string | null;
  recipientName: string | null;
  currentVersion: number;
  pendingRequestId: string | null;
  /** The caller may approve or reject the pending request (approvals view). */
  canDecide: boolean;
  createdBy: { id: string; displayName: string } | null;
  updatedAt: string;
  approvedAt: string | null;
  /** When the last required signature was collected (status `signed`). */
  signedAt: string | null;
}

export interface ContractDto extends ContractSummaryDto {
  snapshot: ContractSnapshot;
  /** Fields still preventing submission (empty when ready). */
  missing: string[];
  versions: ContractVersionDto[];
  requests: ApprovalRequestDto[];
  /** Clause ids whose wording differs from the template clause they came from (shown to approvers). */
  modifiedClauseIds: string[];
  /** The stamped approved PDF, once approved. `verified`: its bytes still match the recorded hash. */
  approvedDocument: {
    version: number;
    sha256: string;
    sizeBytes: number;
    verified: boolean;
  } | null;
  /** What the caller may do now (UI hint; the API re-checks every action). */
  can: {
    edit: boolean;
    submit: boolean;
    withdraw: boolean;
    cancel: boolean;
    /** Approve or reject the pending request. */
    decide: boolean;
    export: boolean;
  };
}

export interface ContractTerminationEventDto {
  id: string;
  action: 'requested' | 'accepted' | 'rejected' | 'withdrawn' | 'executed' | 'expired';
  fromStatus: TerminationStatus | null;
  toStatus: TerminationStatus;
  actor: { id: string; displayName: string } | null;
  actorRole: string;
  note: string | null;
  createdAt: string;
}

export interface ContractTerminationDto {
  id: string;
  contractId: string;
  initiatedBy: { id: string; displayName: string };
  initiatorRole: string;
  reasonCode: TerminationReasonCode;
  reasonDetails: string | null;
  effectiveDate: string;
  noticePeriodDays: number;
  status: TerminationStatus;
  counterpartyResponseAt: string | null;
  counterpartyNote: string | null;
  settlementNotes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContractTerminationViewDto {
  current: ContractTerminationDto | null;
  events: ContractTerminationEventDto[];
  can: {
    request: boolean;
    respond: boolean;
    withdraw: boolean;
    execute: boolean;
  };
}

export interface ContractTypeDto {
  id: string;
  key: string | null;
  isSystem: boolean;
  nameEn: string;
  nameAr: string;
  descriptionEn: string | null;
  descriptionAr: string | null;
  clauseCount: number;
  archived: boolean;
}

export interface TemplateClauseDto {
  id: string;
  position: number;
  required: boolean;
  titleEn: string;
  titleAr: string;
  bodyEn: string;
  bodyAr: string;
}

export interface DocumentSettingsDto {
  organizationName: string;
  legalNameEn: string | null;
  legalNameAr: string | null;
  commercialRegistration: string | null;
  taxNumber: string | null;
  addressEn: string | null;
  addressAr: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  headerTextEn: string | null;
  headerTextAr: string | null;
  footerTextEn: string | null;
  footerTextAr: string | null;
  logoFileId: string | null;
  logoPosition: LogoPosition;
  backgroundKind: BackgroundKind;
  backgroundFileId: string | null;
  marginTopMm: number;
  marginBottomMm: number;
  marginStartMm: number;
  marginEndMm: number;
  pageBorder: boolean;
  fontSizePt: number;
  lineHeight: number;
  defaultLanguage: DocumentLanguage;
  stampFileId: string | null;
  stampPosition: StampPosition;
  stampWidthMm: number;
}

export interface StoredFileDto {
  id: string;
  kind: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

export interface ClauseProposalDto {
  id: string;
  contractId: string;
  purpose: string;
  feedback: string | null;
  revisionOf: string | null;
  status: 'proposed' | 'accepted' | 'rejected';
  titleEn: string;
  titleAr: string;
  bodyEn: string;
  bodyAr: string;
  /** Details the assistant could not infer and that the user should supply or confirm. */
  questions: string[];
  notes: string | null;
  model: string;
  createdAt: string;
}

export interface AssistantStatusDto {
  configured: boolean;
  provider: string | null;
  model: string | null;
}

// ---------- Electronic signatures (Phase 4) ----------

export type SigningLinkState = 'none' | 'active' | 'expired' | 'revoked' | 'used' | 'locked';

export interface SignerDto {
  id: string;
  role: SignerRole;
  order: number;
  nameEn: string | null;
  nameAr: string | null;
  email: string | null;
  phone: string | null;
  relationship: string | null;
  status: SignerStatus;
  /** Earlier signers have all signed, so this one can sign now. */
  turn: boolean;
  link: {
    state: SigningLinkState;
    method: VerificationMethod | null;
    /** Masked address the email code goes to. */
    destination: string | null;
    createdAt: string | null;
    expiresAt: string | null;
    createdBy: { id: string; displayName: string } | null;
  };
  signature: {
    method: SignatureMethod;
    typedName: string | null;
    fontKey: SignatureFontKey | null;
    /** Drawn signatures: the strokes on the DRAW_CANVAS grid. */
    strokes: [number, number][][] | null;
    signedAt: string;
    verification: VerificationMethod;
    verifiedAt: string;
    ip: string | null;
    userAgent: string | null;
    consentLocale: 'ar' | 'en';
    consentText: string;
    documentSha256: string;
  } | null;
  /**
   * ID-document patch. `required` and `provided` are shown to everyone who sees the signing
   * status; `details` only to holders of `contracts.view_signer_id` (null otherwise).
   */
  idDocument: {
    required: boolean;
    provided: boolean;
    details: SignerIdDocumentDto[] | null;
  };
}

/** Metadata of an uploaded ID document (never its content). Newest first; one is current. */
export interface SignerIdDocumentDto {
  id: string;
  documentType: IdDocumentType;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  uploadedAt: string;
  /** The one the signature was given with (or, before signing, the latest upload). */
  current: boolean;
}

export interface SigningRoundDto {
  id: string;
  status: SigningRoundStatus;
  /** A guardian signs too because the recipient was under 18 on this date. */
  minor: boolean;
  minorOn: string;
  approvedDocumentSha256: string;
  startedAt: string;
  startedBy: { id: string; displayName: string } | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelledBy: { id: string; displayName: string } | null;
  cancelReason: string | null;
  signedDocument: { sha256: string; sizeBytes: number; verified: boolean } | null;
  signers: SignerDto[];
}

export interface ContractSigningDto {
  /** Newest first; at most one is in progress. */
  rounds: SigningRoundDto[];
  can: { start: boolean; manageLinks: boolean; cancel: boolean; download: boolean };
}

/** Returned once when a link is created: the link (and access code) are never shown again. */
export interface SigningLinkCreatedDto {
  signerId: string;
  url: string;
  expiresAt: string;
  method: VerificationMethod;
  /** Only for the access-code method: the code to pass on through another channel. */
  accessCode: string | null;
  destination: string | null;
}

export type PublicSigningState = 'verify' | 'waiting' | 'ready' | 'signed' | 'completed';

/** What an unverified visitor of a signing link sees: no contract content, no personal data. */
export interface PublicSigningInfo {
  state: PublicSigningState;
  organizationName: string;
  contractNumber: string;
  signerRole: SignerRole;
  method: VerificationMethod;
  destination: string | null;
  expiresAt: string;
}

/** After the code check: what the signer needs to review and sign. */
export interface PublicSigningSession {
  state: PublicSigningState;
  organizationName: string;
  contractNumber: string;
  contractTitle: { en: string; ar: string };
  documentLanguage: DocumentLanguage;
  /** SHA-256 of the approved PDF being signed (shown so the signer can check their copy). */
  documentSha256: string;
  signer: {
    role: SignerRole;
    nameEn: string | null;
    nameAr: string | null;
    relationship: string | null;
  };
  recipientName: { en: string | null; ar: string | null };
  /** The statement to agree to, in both languages (stored verbatim in the one used). */
  consent: { version: string; en: string; ar: string };
  /** Every required signer of this contract, in signing order (no contact details). */
  signers: { role: SignerRole; status: SignerStatus; signedAt: string | null }[];
  /** This person's own signature once given. */
  signedAt: string | null;
  sessionExpiresAt: string;
  /**
   * ID-document patch: whether this signer must upload an identity document before signing, and
   * what was received (metadata only; the file itself is never sent back to the signing page).
   */
  idDocument: {
    required: boolean;
    uploaded: {
      documentType: IdDocumentType;
      contentType: string;
      sizeBytes: number;
      uploadedAt: string;
    } | null;
  };
}

/** Returned by a successful code check; the token goes in the `x-signing-session` header. */
export interface PublicSigningVerified {
  sessionToken: string;
  session: PublicSigningSession;
}
