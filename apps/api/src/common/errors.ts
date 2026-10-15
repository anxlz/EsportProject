import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { ApiErrorBody, ErrorCode } from '@esports/shared';
import type { Response } from 'express';

/** The only exception type services should throw. `code` is stable and translated client-side. */
export class AppError extends HttpException {
  constructor(
    public readonly code: ErrorCode,
    status: number,
    message?: string,
    public readonly details?: unknown,
  ) {
    super({ code, message: message ?? code, details }, status);
  }
}

export const Errors = {
  validation: (details?: unknown) =>
    new AppError('validation_failed', HttpStatus.BAD_REQUEST, 'Validation failed', details),
  unauthenticated: () => new AppError('unauthenticated', HttpStatus.UNAUTHORIZED),
  forbidden: (message = 'You do not have permission to do this') =>
    new AppError('forbidden', HttpStatus.FORBIDDEN, message),
  notFound: (what = 'Resource') =>
    new AppError('not_found', HttpStatus.NOT_FOUND, `${what} not found`),
  conflict: (code: ErrorCode, message?: string) => new AppError(code, HttpStatus.CONFLICT, message),
  badRequest: (code: ErrorCode, message?: string) =>
    new AppError(code, HttpStatus.BAD_REQUEST, message),
};

const PG_UNIQUE_VIOLATION = '23505';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: ApiErrorBody = {
      error: { code: 'internal_error', message: 'Internal server error' },
    };

    if (exception instanceof AppError) {
      status = exception.getStatus();
      body = {
        error: { code: exception.code, message: exception.message, details: exception.details },
      };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const code: ErrorCode =
        status === 404
          ? 'not_found'
          : status === 401
            ? 'unauthenticated'
            : status === 403
              ? 'forbidden'
              : status === 429
                ? 'rate_limited'
                : status === 400
                  ? 'validation_failed'
                  : 'internal_error';
      body = { error: { code, message: exception.message } };
    } else if (isPgError(exception) && exception.code === PG_UNIQUE_VIOLATION) {
      // Safety net: services pre-check uniqueness, but a race can still hit the constraint.
      status = HttpStatus.CONFLICT;
      body = { error: { code: 'conflict', message: 'Already exists' } };
    } else {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }
    res.status(status).json(body);
  }
}

function isPgError(e: unknown): e is { code: string } {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    typeof (e as { code: unknown }).code === 'string' &&
    'severity' in e
  );
}
