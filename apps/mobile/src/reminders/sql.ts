// A small async SQL interface. Production wraps expo-sqlite; tests run the same queries on Node's built-in SQLite, so the
// real SQL (schema, constraints, transactions) is exercised without a phone.
export interface SqlDb {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  first<T>(sql: string, params?: unknown[]): Promise<T | null>;
  // All-or-nothing. Queries inside must go through the `tx` argument.
  transaction<T>(fn: (tx: SqlDb) => Promise<T>): Promise<T>;
}
