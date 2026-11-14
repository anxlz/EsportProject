import { Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { FILE_KINDS, type FileKind, type PermissionKey } from '@esports/shared';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { RequireOrg, type TenantContext, TenantCtx } from '../authz/context.js';
import { AuditService } from '../audit/audit.service.js';
import { Errors } from '../common/errors.js';
import { UuidPipe, ZodQuery } from '../common/zod.js';
import { FilesService } from './files.service.js';

/** Who may upload each kind: layout assets with template rights, the stamp with sensitive settings. */
const UPLOAD_PERMISSION: Record<FileKind, PermissionKey> = {
  logo: 'contracts.manage_templates',
  background: 'contracts.manage_templates',
  stamp: 'org.settings.edit_sensitive',
};
/** Who may view uploaded assets (contract previews show them). */
const VIEW_PERMISSIONS: PermissionKey[] = [
  'contracts.view',
  'contracts.create',
  'contracts.approve',
  'contracts.manage_templates',
  'org.settings.edit_sensitive',
];

@ApiTags('files')
@Controller('files')
export class FilesController {
  constructor(
    private readonly files: FilesService,
    private readonly audit: AuditService,
  ) {}

  /** Raw upload: the request body is the file itself (Content-Type: image/png, image/jpeg, image/webp or application/pdf). */
  @Post()
  @RequireOrg()
  async upload(
    @TenantCtx() ctx: TenantContext,
    @ZodQuery(z.object({ kind: z.enum(FILE_KINDS) })) q: { kind: FileKind },
    @Req() req: Request,
  ) {
    if (!ctx.access.has(UPLOAD_PERMISSION[q.kind])) throw Errors.forbidden();
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const file = await this.files.upload(
      ctx.organizationId,
      ctx.user.id,
      q.kind,
      body,
      req.headers['content-type'],
    );
    await this.audit.fromCtx(
      ctx,
      'file.uploaded',
      { type: 'file', id: file.id },
      {
        kind: q.kind,
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
      },
    );
    return file;
  }

  /** Uploaded assets only; generated documents are served by their own, permission-checked routes. */
  @Get(':id')
  @RequireOrg()
  async get(
    @TenantCtx() ctx: TenantContext,
    @Param('id', UuidPipe) id: string,
    @Res() res: Response,
  ) {
    if (!VIEW_PERMISSIONS.some((p) => ctx.access.has(p))) throw Errors.forbidden();
    const f = await this.files.get(ctx.organizationId, id);
    if (!f || !(FILE_KINDS as readonly string[]).includes(f.kind)) throw Errors.notFound('File');
    res
      .status(200)
      .set({
        'Content-Type': f.contentType,
        'Content-Length': String(f.sizeBytes),
        'Content-Disposition': 'inline',
        'Cache-Control': 'private, max-age=3600, immutable',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        ETag: `"${f.sha256}"`,
      })
      .end(f.data);
  }
}
