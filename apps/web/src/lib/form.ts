import type { z } from 'zod';

/**
 * Client-side pre-validation with the SAME zod schema the API enforces. Returns the set of
 * top-level fields that failed, so forms can show a localized message next to each one.
 */
export function invalidFields<T extends z.ZodType>(schema: T, values: unknown): Set<string> {
  const res = schema.safeParse(values);
  if (res.success) return new Set();
  return new Set(res.error.issues.map((i) => String(i.path[0] ?? '')));
}
