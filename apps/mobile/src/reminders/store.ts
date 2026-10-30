import type { DoseStatus, NotificationType } from '@med/shared';
import type { SyncResult } from '../api/endpoints';
import type { SqlDb } from './sql';

export type Action = 'taken' | 'not_taken' | 'snooze';
export const SNOOZE_MS = 10 * 60_000; // D-029

export interface LocalDose {
  id: string;
  medicineId: string;
  scheduledAt: number; // epoch ms
  alertDueAt: number;
  localTime: string;
  name: string;
  amount: string;
  type: NotificationType;
  status: DoseStatus;
  snoozeUntil: number | null;
}
export interface OutboxRow {
  clientEventId: string;
  doseId: string;
  action: Action;
  respondedAt: number;
  networkRestoredAt: number | null;
  attempts: number;
}
export type AnswerResult = { ok: true; dose: LocalDose; event: OutboxRow } | { ok: false; reason: 'unknown_dose' | 'already_answered' | 'snooze_not_allowed' };

const MIGRATIONS: string[] = [
  `create table doses (
     id text primary key,
     medicine_id text not null,
     scheduled_at integer not null,
     alert_due_at integer not null,
     local_time text not null,
     name text not null,
     amount text not null,
     notification_type text not null,
     status text not null,
     snooze_until integer
   );
   create table outbox (
     client_event_id text primary key,
     dose_id text not null,
     action text not null check (action in ('taken','not_taken','snooze')),
     responded_at integer not null,
     network_restored_at integer,
     created_at integer not null,
     attempts integer not null default 0,
     next_attempt_at integer not null default 0,
     sent_at integer
   );
   create index outbox_unsent_idx on outbox (next_attempt_at) where sent_at is null;
   create table kv (k text primary key, v text not null);`,
];

interface DoseRow {
  id: string;
  medicine_id: string;
  scheduled_at: number;
  alert_due_at: number;
  local_time: string;
  name: string;
  amount: string;
  notification_type: NotificationType;
  status: DoseStatus;
  snooze_until: number | null;
}
const toDose = (r: DoseRow): LocalDose => ({ id: r.id, medicineId: r.medicine_id, scheduledAt: r.scheduled_at, alertDueAt: r.alert_due_at, localTime: r.local_time, name: r.name, amount: r.amount, type: r.notification_type, status: r.status, snoozeUntil: r.snooze_until });
const toOutbox = (r: { client_event_id: string; dose_id: string; action: Action; responded_at: number; network_restored_at: number | null; attempts: number }): OutboxRow => ({ clientEventId: r.client_event_id, doseId: r.dose_id, action: r.action, respondedAt: r.responded_at, networkRestoredAt: r.network_restored_at, attempts: r.attempts });

const BACKOFF_BASE_MS = 30_000; // then doubling, capped at an hour (05: exponential backoff)
const BACKOFF_MAX_MS = 3_600_000;
export const backoffMs = (attempts: number): number => Math.min(BACKOFF_BASE_MS * 2 ** Math.max(attempts - 1, 0), BACKOFF_MAX_MS);

// The phone's own copy of what the server issued, plus the answers it has not yet delivered (D-031: answers are written
// here first, then sent). Everything that must be all-or-nothing happens in one transaction.
export class Store {
  constructor(private readonly db: SqlDb) {}

  async migrate(): Promise<void> {
    const row = await this.db.first<{ user_version: number }>('pragma user_version');
    for (let v = row?.user_version ?? 0; v < MIGRATIONS.length; v++) {
      await this.db.transaction(async (tx) => {
        await tx.exec(MIGRATIONS[v]!);
        await tx.exec(`pragma user_version = ${v + 1}`);
      });
    }
  }

  async getKv(key: string): Promise<string | null> {
    return (await this.db.first<{ v: string }>('select v from kv where k = ?', [key]))?.v ?? null;
  }
  async setKv(key: string, value: string): Promise<void> {
    await this.db.run('insert into kv (k, v) values (?, ?) on conflict (k) do update set v = excluded.v', [key, value]);
  }

  async listDoses(): Promise<LocalDose[]> {
    return (await this.db.all<DoseRow>('select * from doses order by scheduled_at, id')).map(toDose);
  }

  // Replaces the issued window with the server's. A dose with an answer still waiting to be delivered keeps its local state:
  // the server may not know yet, and the phone must not undo what the patient just did.
  async applySync(sync: SyncResult): Promise<void> {
    await this.db.transaction(async (tx) => {
      const pending = new Set((await tx.all<{ dose_id: string }>('select distinct dose_id from outbox where sent_at is null')).map((r) => r.dose_id));
      const kept: string[] = [];
      for (const d of sync.doses) {
        kept.push(d.id);
        if (pending.has(d.id)) continue;
        await tx.run(
          `insert into doses (id, medicine_id, scheduled_at, alert_due_at, local_time, name, amount, notification_type, status, snooze_until)
           values (?,?,?,?,?,?,?,?,?,?)
           on conflict (id) do update set medicine_id = excluded.medicine_id, scheduled_at = excluded.scheduled_at, alert_due_at = excluded.alert_due_at,
             local_time = excluded.local_time, name = excluded.name, amount = excluded.amount, notification_type = excluded.notification_type,
             status = excluded.status, snooze_until = excluded.snooze_until`,
          [d.id, d.medicine_id, Date.parse(d.scheduled_at), Date.parse(d.alert_due_at), d.local_time, d.name, d.amount, d.notification_type, d.status, d.snooze_until ? Date.parse(d.snooze_until) : null],
        );
      }
      // Doses the server no longer issues (edited, archived, outside the window) disappear, unless an answer is waiting.
      const have = await tx.all<{ id: string }>('select id from doses');
      for (const { id } of have) if (!kept.includes(id) && !pending.has(id)) await tx.run('delete from doses where id = ?', [id]);
      await tx.run("insert into kv (k, v) values ('window_through', ?) on conflict (k) do update set v = excluded.v", [String(Date.parse(sync.window.through))]);
      await tx.run("insert into kv (k, v) values ('lockscreen_detail', ?) on conflict (k) do update set v = excluded.v", [sync.patient.lockscreen_detail]);
      await tx.run("insert into kv (k, v) values ('cursor', ?) on conflict (k) do update set v = excluded.v", [sync.cursor]);
      await tx.run("insert into kv (k, v) values ('account_state', ?) on conflict (k) do update set v = excluded.v", [sync.account_state]);
      await tx.run("insert into kv (k, v) values ('patient_name', ?) on conflict (k) do update set v = excluded.v", [sync.patient.display_name]);
    });
  }

  // The patient's tap: the dose changes and the answer is queued in one transaction, so a crash can never leave one without
  // the other. The same rules the server applies (D-085) are checked here so the phone and server agree.
  async recordAnswer(a: { doseId: string; action: Action; at: number; eventId: string; networkRestoredAt?: number | null }): Promise<AnswerResult> {
    return this.db.transaction(async (tx) => {
      const row = await tx.first<DoseRow>('select * from doses where id = ?', [a.doseId]);
      if (!row) return { ok: false, reason: 'unknown_dose' };
      const dose = toDose(row);
      if (a.action === 'snooze') {
        const open = dose.status === 'pending' || dose.status === 'snoozed';
        if (!open || a.at + SNOOZE_MS >= dose.alertDueAt) return { ok: false, reason: 'snooze_not_allowed' };
      } else if (dose.status === 'taken' || dose.status === 'not_taken') {
        return { ok: false, reason: 'already_answered' }; // the first tap wins; a changed mind is a correction the server merges
      }
      const status: DoseStatus = a.action === 'snooze' ? 'snoozed' : a.action;
      const snoozeUntil = a.action === 'snooze' ? a.at + SNOOZE_MS : null;
      await tx.run('update doses set status = ?, snooze_until = ? where id = ?', [status, snoozeUntil, dose.id]);
      await tx.run('insert into outbox (client_event_id, dose_id, action, responded_at, network_restored_at, created_at) values (?,?,?,?,?,?)', [a.eventId, dose.id, a.action, a.at, a.networkRestoredAt ?? null, a.at]);
      const event: OutboxRow = { clientEventId: a.eventId, doseId: dose.id, action: a.action, respondedAt: a.at, networkRestoredAt: a.networkRestoredAt ?? null, attempts: 0 };
      return { ok: true, dose: { ...dose, status, snoozeUntil }, event };
    });
  }

  async dueOutbox(now: number, limit = 100): Promise<OutboxRow[]> {
    return (await this.db.all<Parameters<typeof toOutbox>[0]>('select * from outbox where sent_at is null and next_attempt_at <= ? order by created_at limit ?', [now, limit])).map(toOutbox);
  }
  async hasUnsent(): Promise<boolean> {
    return (await this.db.first<{ n: number }>('select count(*) as n from outbox where sent_at is null'))!.n > 0;
  }
  async markDelivered(eventId: string, now: number): Promise<void> {
    await this.db.run('update outbox set sent_at = ? where client_event_id = ?', [now, eventId]);
  }
  async markFailed(eventId: string, now: number): Promise<void> {
    const row = await this.db.first<{ attempts: number }>('select attempts from outbox where client_event_id = ?', [eventId]);
    if (!row) return;
    await this.db.run('update outbox set attempts = ?, next_attempt_at = ? where client_event_id = ?', [row.attempts + 1, now + backoffMs(row.attempts + 1), eventId]);
  }

  // The server's final word on a dose (superseded, or a snooze it refused) replaces the local guess.
  async adoptServerState(s: { id: string; status: DoseStatus; snooze_until: string | null; alert_due_at: string }): Promise<void> {
    await this.db.run('update doses set status = ?, snooze_until = ?, alert_due_at = ? where id = ?', [s.status, s.snooze_until ? Date.parse(s.snooze_until) : null, Date.parse(s.alert_due_at), s.id]);
  }

  async purgeDelivered(olderThan: number): Promise<void> {
    await this.db.run('delete from outbox where sent_at is not null and sent_at < ?', [olderThan]);
  }

  async wipe(): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.run('delete from doses');
      await tx.run('delete from outbox');
      await tx.run('delete from kv');
    });
  }
}
