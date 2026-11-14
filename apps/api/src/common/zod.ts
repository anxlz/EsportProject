/**
 * Zod-based request validation + OpenAPI documentation from the same schema.
 *
 *   @Post() create(@ZodBody(teamCreateSchema) body: TeamCreateInput) { ... }
 *
 * The schema is the single source of truth: it validates the request and is converted to JSON
 * Schema (zod v4's native z.toJSONSchema) for the Swagger document.
 */
import {
  type ArgumentMetadata,
  Body,
  Injectable,
  type PipeTransform,
  Query,
  applyDecorators,
} from '@nestjs/common';
import { ApiBody } from '@nestjs/swagger';
import { z } from 'zod';
import { Errors } from './errors.js';

@Injectable()
export class ZodPipe<T extends z.ZodType> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown, _meta: ArgumentMetadata): z.infer<T> {
    const result = this.schema.safeParse(value ?? {});
    if (!result.success) {
      throw Errors.validation(
        result.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
          code: i.code,
        })),
      );
    }
    return result.data;
  }
}

function toOpenApi(schema: z.ZodType): Record<string, unknown> {
  try {
    return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<
      string,
      unknown
    >;
  } catch {
    return { type: 'object' };
  }
}

export function ZodBody<T extends z.ZodType>(schema: T): ParameterDecorator {
  const param = Body(new ZodPipe(schema));
  const doc = ApiBody({ schema: toOpenApi(schema) as never });
  return (target, key, index) => {
    param(target, key, index);
    if (key !== undefined) {
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      if (descriptor) applyDecorators(doc)(target, key, descriptor);
    }
  };
}

export function ZodQuery<T extends z.ZodType>(schema: T): ParameterDecorator {
  return Query(new ZodPipe(schema));
}

/** Route-param pipe: a malformed id is indistinguishable from a missing record (404). */
@Injectable()
export class UuidPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    const res = z.uuid().safeParse(value);
    if (!res.success) throw Errors.notFound();
    return res.data;
  }
}
