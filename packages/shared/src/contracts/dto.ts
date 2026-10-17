/** Response shapes for Phase 3 (contracts). */
import type {
  ApprovalRequestStatus,
  BackgroundKind,
  ClauseSource,
  ContractStatus,
  DocumentLanguage,
  LogoPosition,
  StampPosition,
} from './catalog';
import type { ContractDetailsInput } from './schemas';

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
