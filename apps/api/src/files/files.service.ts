/**
 * File storage for uploaded assets and generated documents, kept in Postgres (`stored_files`).
 *
 * Why Postgres for now: Supabase Storage needs project credentials that don't exist yet, and the
 * files are small (logos, stamps, backgrounds ≤ 5 MB; contract PDFs ~100 KB). Storing them with
 * the data keeps backups, tenancy and integrity checks in one place. The service is the only
 * code that touches the table, so moving to Supabase Storage later is one adapter.
 *
 * Uploads are identified by their bytes (magic numbers), never by the declared type alone, and
 * SVG is not accepted (it can carry script).
 */
import { Inject, Injectable } from '@nestjs/common';
import { FILE_LIMITS, type FileKind, type StoredFileDto } from '@esports/shared';
import { and, eq } from 'drizzle-orm';
import { AppError, Errors } from '../common/errors';
import { DB, type Database, type DbOrTx } from '../db/client';
import { storedFiles } from '../db/schema-contracts';
import { sha256Hex } from '../versioning/versioning.service';

/** Detects the real type from the first bytes. */
export function sniffContentType(data: Buffer): string | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 12 && data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (data.length >= 5 && data.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

const toDto = (f: Pick<typeof storedFiles.$inferSelect, 'id' | 'kind' | 'contentType' | 'sizeBytes' | 'sha256' | 'createdAt'>): StoredFileDto => ({
  id: f.id,
  kind: f.kind,
  contentType: f.contentType,
  sizeBytes: f.sizeBytes,
  sha256: f.sha256,
  createdAt: f.createdAt.toISOString(),
});

@Injectable()
export class FilesService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Validates and stores an upload of one of the user-facing kinds. */
  async upload(organizationId: string, userId: string, kind: FileKind, data: Buffer, declaredType: string | undefined): Promise<StoredFileDto> {
    const limit = FILE_LIMITS[kind];
    if (!data.length) throw Errors.badRequest('validation_failed', 'Empty file');
    if (data.length > limit.maxBytes) throw new AppError('file_too_large', 413, `Files of this kind can be at most ${Math.round(limit.maxBytes / 1048576)} MB`);
    const actual = sniffContentType(data);
    if (!actual || !limit.types.includes(actual) || (declaredType && declaredType.split(';')[0]!.trim() !== actual)) {
      throw new AppError('unsupported_file_type', 415, `Accepted: ${limit.types.join(', ')}`);
    }
    // Backgrounds are composited with pdf-lib, which reads PNG, JPEG and PDF (not WebP).
    if (kind === 'background' && actual === 'image/webp') throw new AppError('unsupported_file_type', 415, 'Backgrounds must be PNG, JPEG or PDF');
    return this.put(this.db, organizationId, userId, kind, actual, data);
  }

  /** Stores bytes the platform produced itself (e.g. an approved contract PDF). */
  async put(db: DbOrTx, organizationId: string, userId: string | null, kind: string, contentType: string, data: Buffer): Promise<StoredFileDto> {
    const [row] = await db
      .insert(storedFiles)
      .values({ organizationId, kind, contentType, sizeBytes: data.length, sha256: sha256Hex(data), data, createdByUserId: userId })
      .returning();
    return toDto(row!);
  }

  async get(organizationId: string, id: string, db: DbOrTx = this.db) {
    const [row] = await db.select().from(storedFiles).where(and(eq(storedFiles.id, id), eq(storedFiles.organizationId, organizationId)));
    return row ?? null;
  }

  /** Metadata only, and only for the given kinds (so ids of other files can't be repurposed). */
  async requireOfKind(db: DbOrTx, organizationId: string, id: string, kinds: string[]) {
    const [row] = await db
      .select({ id: storedFiles.id, kind: storedFiles.kind, contentType: storedFiles.contentType })
      .from(storedFiles)
      .where(and(eq(storedFiles.id, id), eq(storedFiles.organizationId, organizationId)));
    if (!row || !kinds.includes(row.kind)) throw Errors.badRequest('validation_failed', 'Unknown file');
    return row;
  }
}
