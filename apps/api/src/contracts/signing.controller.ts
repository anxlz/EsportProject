/**
 * Signing routes (spec §7.7).
 *   /contracts/:id/signing…        dashboard side (session + permissions)
 *   /public/signing/:token…        the signer's page (no account; token + code + rate limits)
 */
import {
  type CallHandler,
  Controller,
  type ExecutionContext,
  Get,
  Headers,
  HttpCode,
  Injectable,
  type NestInterceptor,
  Param,
  Post,
  Res,
  StreamableFile,
  UseInterceptors,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  cancelSigningSchema,
  type CreateSigningLinkInput,
  createSigningLinkSchema,
  type SignInput,
  signSchema,
  verifySigningCodeSchema,
} from '@esports/shared';
import type { Response } from 'express';
import type { Observable } from 'rxjs';
import type { z } from 'zod';
import {
  type ClientMeta,
  Meta,
  Public,
  RequireOrg,
  RequirePermission,
  type TenantContext,
  TenantCtx,
} from '../authz/context';
import { RateLimit } from '../common/rate-limit';
import { UuidPipe, ZodBody } from '../common/zod';
import { requireAny } from './contract-types.controller';
import { asciiFilename, sendPreviewHtml } from './http';
import { SigningService } from './signing.service';

const SEE: Parameters<typeof requireAny>[1] = ['contracts.view', 'contracts.approve'];

const pdfFile = (res: Response, f: { pdf: Buffer; filename: string; sha256: string }) => {
  res.set('X-Document-SHA256', f.sha256);
  return new StreamableFile(f.pdf, {
    type: 'application/pdf',
    disposition: `attachment; filename="${asciiFilename(f.filename)}"`,
  });
};

@ApiTags('contracts')
@Controller('contracts')
export class SigningController {
  constructor(private readonly signing: SigningService) {}

  @Get(':id/signing')
  @RequireOrg()
  state(@TenantCtx() ctx: TenantContext, @Param('id', UuidPipe) id: string) {
    requireAny(ctx, SEE);
    return this.signing.state(ctx, id);
  }

  /** Fixes the required signers from the approved version and opens signing. */
  @Post(':id/signing')
  @HttpCode(200)
  @RequirePermission('contracts.send_for_signature')
  start(@TenantCtx() ctx: TenantContext, @Param('id', UuidPipe) id: string) {
    return this.signing.start(ctx, id);
  }

  /** A new link for one signer (replaces their previous one). The link is shown once. */
  @Post(':id/signing/signers/:signerId/link')
  @HttpCode(200)
  @RequirePermission('contracts.send_for_signature')
  createLink(
    @TenantCtx() ctx: TenantContext,
    @Param('id', UuidPipe) id: string,
    @Param('signerId', UuidPipe) signerId: string,
    @ZodBody(createSigningLinkSchema) body: CreateSigningLinkInput,
  ) {
    return this.signing.createLink(ctx, id, signerId, body);
  }

  @Post(':id/signing/signers/:signerId/link/revoke')
  @HttpCode(200)
  @RequirePermission('contracts.send_for_signature')
  revokeLink(
    @TenantCtx() ctx: TenantContext,
    @Param('id', UuidPipe) id: string,
    @Param('signerId', UuidPipe) signerId: string,
  ) {
    return this.signing.revokeLink(ctx, id, signerId);
  }

  @Post(':id/signing/cancel')
  @HttpCode(200)
  @RequirePermission('contracts.send_for_signature')
  cancel(
    @TenantCtx() ctx: TenantContext,
    @Param('id', UuidPipe) id: string,
    @ZodBody(cancelSigningSchema) body: z.infer<typeof cancelSigningSchema>,
  ) {
    return this.signing.cancel(ctx, id, body.reason);
  }

  /** The fully signed document (approved PDF + signature record), exactly as stored. */
  @Get(':id/signed.pdf')
  @RequirePermission('contracts.export')
  async signed(
    @TenantCtx() ctx: TenantContext,
    @Param('id', UuidPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    return pdfFile(res, await this.signing.signedPdf(ctx, id));
  }
}

/** Signing responses are never cached and never indexed; the token is in the URL. */
@Injectable()
class PublicSigningHeaders implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    ctx.switchToHttp().getResponse<Response>().set({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
    });
    return next.handle();
  }
}

const SESSION_HEADER = 'x-signing-session';

@ApiTags('signing')
@Controller('public/signing')
@UseInterceptors(PublicSigningHeaders)
export class PublicSigningController {
  constructor(private readonly signing: SigningService) {}

  /** Before the code check: who is asked to sign which contract, nothing more. */
  @Get(':token')
  @Public()
  @RateLimit('signingView')
  info(@Param('token') token: string) {
    return this.signing.info(token);
  }

  @Post(':token/code')
  @Public()
  @HttpCode(200)
  @RateLimit('signingCode')
  sendCode(@Param('token') token: string, @Meta() meta: ClientMeta) {
    return this.signing.sendCode(token, meta);
  }

  @Post(':token/verify')
  @Public()
  @HttpCode(200)
  @RateLimit('signingVerify')
  verify(
    @Param('token') token: string,
    @ZodBody(verifySigningCodeSchema) body: z.infer<typeof verifySigningCodeSchema>,
    @Meta() meta: ClientMeta,
  ) {
    return this.signing.verify(token, body.code, meta);
  }

  @Get(':token/session')
  @Public()
  @RateLimit('signingView')
  session(@Param('token') token: string, @Headers(SESSION_HEADER) session?: string) {
    return this.signing.session(token, session);
  }

  /** The approved version for reading on screen (sandboxed, no scripts). */
  @Get(':token/document.html')
  @Public()
  @RateLimit('signingView')
  async documentHtml(
    @Param('token') token: string,
    @Headers(SESSION_HEADER) session: string | undefined,
    @Res() res: Response,
  ) {
    sendPreviewHtml(res, await this.signing.documentHtml(token, session));
  }

  /** The approved PDF being signed, exactly as stored. */
  @Get(':token/document.pdf')
  @Public()
  @RateLimit('signingView')
  async documentPdf(
    @Param('token') token: string,
    @Headers(SESSION_HEADER) session: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    return pdfFile(res, await this.signing.documentPdf(token, session));
  }

  @Post(':token/sign')
  @Public()
  @HttpCode(200)
  @RateLimit('signingSign')
  sign(
    @Param('token') token: string,
    @Headers(SESSION_HEADER) session: string | undefined,
    @ZodBody(signSchema) body: SignInput,
    @Meta() meta: ClientMeta,
  ) {
    return this.signing.sign(token, session, body, meta);
  }

  /** The fully signed copy, once every required signature is in. */
  @Get(':token/signed.pdf')
  @Public()
  @RateLimit('signingView')
  async signedCopy(
    @Param('token') token: string,
    @Headers(SESSION_HEADER) session: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    return pdfFile(res, await this.signing.signedCopy(token, session));
  }
}
