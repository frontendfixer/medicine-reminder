import { ApiException } from '../common/api-exception.js';

// Opaque keyset cursors: the sort timestamp plus the row ID as a tie-break.
export const encodeCursor = (t: Date, id: string) => Buffer.from(JSON.stringify({ t: t.toISOString(), id })).toString('base64url');

export function decodeCursor(cursor: string): { t: Date; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { t?: unknown; id?: unknown };
    const t = new Date(String(parsed.t));
    if (typeof parsed.id === 'string' && /^[0-9a-f-]{36}$/i.test(parsed.id) && !Number.isNaN(t.getTime())) return { t, id: parsed.id };
  } catch {
    // falls through
  }
  throw ApiException.validation({ cursor: 'is not valid' });
}
