import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { SqlDb } from '../reminders/sql';

// Real SQLite for tests, behind the same interface as the phone's. A transaction really is BEGIN … COMMIT/ROLLBACK, and
// the connection is single-threaded, so queries run strictly one after another like on the device.
export function nodeSql(): SqlDb & { raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  let depth = 0;
  const api: SqlDb & { raw: DatabaseSync } = {
    raw,
    // async, so a failing statement is a rejected promise, as on the phone, not a synchronous throw
    exec: async (sql) => void raw.exec(sql),
    run: async (sql, params = []) => ({ changes: Number(raw.prepare(sql).run(...(params as SQLInputValue[])).changes) }),
    all: async <T>(sql: string, params: unknown[] = []) => raw.prepare(sql).all(...(params as SQLInputValue[])) as T[],
    first: async <T>(sql: string, params: unknown[] = []) => (raw.prepare(sql).get(...(params as SQLInputValue[])) as T | undefined) ?? null,
    transaction: async (fn) => {
      if (depth > 0) throw new Error('transactions do not nest');
      depth++;
      raw.exec('begin immediate');
      try {
        const out = await fn(api);
        raw.exec('commit');
        return out;
      } catch (e) {
        raw.exec('rollback');
        throw e;
      } finally {
        depth--;
      }
    },
  };
  return api;
}
