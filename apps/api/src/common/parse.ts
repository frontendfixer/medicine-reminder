import type { ZodType } from 'zod';
import { ApiException } from './api-exception.js';

// Validates a request body or query. Errors name the field and the rule, never the value (passwords!).
export function parse<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const field = issue.path.join('.') || '_';
    fields[field] ??= issue.message;
  }
  throw ApiException.validation(fields);
}
