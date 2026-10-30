import * as SQLite from 'expo-sqlite';
import type { SqlDb } from './sql';

type Executor = Pick<SQLite.SQLiteDatabase, 'execAsync' | 'runAsync' | 'getAllAsync' | 'getFirstAsync'>;

const wrap = (db: Executor, transaction: SqlDb['transaction']): SqlDb => ({
  exec: (sql) => db.execAsync(sql),
  run: async (sql, params = []) => ({ changes: (await db.runAsync(sql, params as SQLite.SQLiteBindValue[])).changes }),
  all: <T>(sql: string, params: unknown[] = []) => db.getAllAsync<T>(sql, params as SQLite.SQLiteBindValue[]),
  first: <T>(sql: string, params: unknown[] = []) => db.getFirstAsync<T>(sql, params as SQLite.SQLiteBindValue[]),
  transaction,
});

// One database file shared by the app and by the headless task that answers a lock-screen tap. WAL lets the two connections
// read while one writes; the busy timeout makes a writer wait instead of failing with "database is locked".
// Whether a headless task can open the same file is not stated in the Expo docs: it is a device test (docs/13-roadmap.md).
let opening: Promise<SqlDb> | null = null;
export function openLocalDb(): Promise<SqlDb> {
  opening ??= (async () => {
    const db = await SQLite.openDatabaseAsync('reminders.db');
    await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    const transaction: SqlDb['transaction'] = async <T>(fn: (tx: SqlDb) => Promise<T>): Promise<T> => {
      let result!: T;
      await db.withExclusiveTransactionAsync(async (txn) => {
        result = await fn(wrap(txn, () => Promise.reject(new Error('transactions do not nest'))));
      });
      return result;
    };
    return wrap(db, transaction);
  })();
  return opening;
}
