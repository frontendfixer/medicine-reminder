// Local SQLite store: an event log for measurements and the answer outbox (D-031).
// Opened lazily because headless tasks may run before any screen mounts.
import * as SQLite from 'expo-sqlite';

let db: SQLite.SQLiteDatabase | null = null;

async function open(): Promise<SQLite.SQLiteDatabase> {
  if (db) return db;
  const conn = await SQLite.openDatabaseAsync('spike.db');
  await conn.execAsync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      kind TEXT NOT NULL,
      detail TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outbox (
      client_event_id TEXT PRIMARY KEY,
      response_key TEXT NOT NULL UNIQUE,
      dose_id TEXT NOT NULL,
      action TEXT NOT NULL,
      responded_at TEXT NOT NULL,
      written_at TEXT NOT NULL,
      source TEXT NOT NULL,
      sent_at TEXT
    );
    CREATE TABLE IF NOT EXISTS scheduled (
      identifier TEXT PRIMARY KEY,
      dose_id TEXT NOT NULL,
      type TEXT NOT NULL,
      delivery TEXT NOT NULL,
      fire_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      delivered_at TEXT
    );
  `);
  db = conn;
  return conn;
}

export type EventRow = { id: number; at: string; kind: string; detail: string };
export type OutboxRow = {
  client_event_id: string;
  // Same tap seen by two handlers (listener + last response) yields the same key.
  response_key: string;
  dose_id: string;
  action: 'taken' | 'not_taken' | 'snooze';
  responded_at: string;
  written_at: string;
  source: string;
  sent_at: string | null;
};

export async function logEvent(kind: string, detail: unknown = {}): Promise<void> {
  const conn = await open();
  await conn.runAsync(
    'INSERT INTO events (at, kind, detail) VALUES (?, ?, ?)',
    new Date().toISOString(),
    kind,
    JSON.stringify(detail),
  );
}

export async function recentEvents(limit = 200): Promise<EventRow[]> {
  const conn = await open();
  return conn.getAllAsync<EventRow>('SELECT * FROM events ORDER BY id DESC LIMIT ?', limit);
}

export async function allEvents(): Promise<EventRow[]> {
  const conn = await open();
  return conn.getAllAsync<EventRow>('SELECT * FROM events ORDER BY id');
}

export async function clearEvents(): Promise<void> {
  const conn = await open();
  await conn.execAsync('DELETE FROM events');
}

// Every answer is queued; the server applies the earliest one (D-031, D-085).
// Returns false when this exact tap was already stored by another handler.
export async function insertAnswer(row: Omit<OutboxRow, 'sent_at'>): Promise<boolean> {
  const conn = await open();
  const res = await conn.runAsync(
    `INSERT OR IGNORE INTO outbox
       (client_event_id, response_key, dose_id, action, responded_at, written_at, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    row.client_event_id,
    row.response_key,
    row.dose_id,
    row.action,
    row.responded_at,
    row.written_at,
    row.source,
  );
  return res.changes > 0;
}

export async function unsentAnswers(): Promise<OutboxRow[]> {
  const conn = await open();
  return conn.getAllAsync<OutboxRow>('SELECT * FROM outbox WHERE sent_at IS NULL ORDER BY responded_at');
}

export async function allAnswers(): Promise<OutboxRow[]> {
  const conn = await open();
  return conn.getAllAsync<OutboxRow>('SELECT * FROM outbox ORDER BY responded_at');
}

export async function markSent(ids: string[]): Promise<void> {
  const conn = await open();
  const now = new Date().toISOString();
  await conn.withExclusiveTransactionAsync(async (txn) => {
    for (const id of ids) {
      await txn.runAsync('UPDATE outbox SET sent_at = ? WHERE client_event_id = ?', now, id);
    }
  });
}

export async function recordScheduled(
  rows: { identifier: string; doseId: string; type: string; delivery: string; fireAt: Date }[],
): Promise<void> {
  const conn = await open();
  const now = new Date().toISOString();
  await conn.withExclusiveTransactionAsync(async (txn) => {
    for (const r of rows) {
      await txn.runAsync(
        `INSERT OR REPLACE INTO scheduled (identifier, dose_id, type, delivery, fire_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        r.identifier,
        r.doseId,
        r.type,
        r.delivery,
        r.fireAt.toISOString(),
        now,
      );
    }
  });
}

// Returns true the first time a delivery is seen for this identifier.
// Notifications we never scheduled (e.g. remote pushes) are recorded too.
export async function markDelivered(identifier: string, deliveredAt: string): Promise<boolean> {
  const conn = await open();
  await conn.runAsync(
    `INSERT OR IGNORE INTO scheduled (identifier, dose_id, type, delivery, fire_at, created_at)
     VALUES (?, ?, 'unknown', 'unknown', ?, ?)`,
    identifier,
    identifier,
    deliveredAt,
    deliveredAt,
  );
  const res = await conn.runAsync(
    'UPDATE scheduled SET delivered_at = ? WHERE identifier = ? AND delivered_at IS NULL',
    deliveredAt,
    identifier,
  );
  return res.changes > 0;
}

export async function scheduledFireAt(identifier: string): Promise<string | null> {
  const conn = await open();
  const row = await conn.getFirstAsync<{ fire_at: string }>(
    'SELECT fire_at FROM scheduled WHERE identifier = ?',
    identifier,
  );
  return row?.fire_at ?? null;
}
