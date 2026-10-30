import type { SyncDose, SyncResult } from '../api/endpoints';
import { nodeSql } from '../testing/node-sql';
import { backoffMs, SNOOZE_MS, Store } from './store';

const T0 = Date.parse('2026-11-01T08:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const dose = (id: string, over: Partial<SyncDose> = {}): SyncDose => ({ id, medicine_id: 'm1', scheduled_at: iso(T0), local_time: '08:00', name: 'Metformin', amount: '1 tablet', status: 'pending', snooze_until: null, alert_due_at: iso(T0 + 30 * 60_000), notification_type: 'standard', ...over });
const sync = (doses: SyncDose[], through = T0 + 5 * 86_400_000): SyncResult => ({ cursor: 'c1', patient: { id: 'p', display_name: 'A', timezone: 'UTC', status: 'active', lockscreen_detail: 'full' }, account_state: 'active', medicines: [], doses, window: { from: iso(T0), through: iso(through) }, commands: [] });

async function make() {
  const sql = nodeSql();
  const store = new Store(sql);
  await store.migrate();
  return { sql, store };
}

describe('schema', () => {
  it('migrates once and is safe to run again', async () => {
    const { sql, store } = await make();
    await store.migrate();
    expect((await sql.first<{ user_version: number }>('pragma user_version'))!.user_version).toBe(1);
    expect((await sql.all<{ name: string }>("select name from sqlite_master where type = 'table' order by name")).map((r) => r.name)).toEqual(['doses', 'kv', 'outbox']);
  });
  it('refuses an action the server does not know', async () => {
    const { sql } = await make();
    await expect(sql.run("insert into outbox (client_event_id, dose_id, action, responded_at, created_at) values ('e','d','eat',1,1)")).rejects.toThrow();
  });
});

describe('applying a sync', () => {
  it('stores the issued doses in order, with times as instants', async () => {
    const { store } = await make();
    await store.applySync(sync([dose('b', { scheduled_at: iso(T0 + 3_600_000) }), dose('a')]));
    const doses = await store.listDoses();
    expect(doses.map((d) => d.id)).toEqual(['a', 'b']);
    expect(doses[0]).toMatchObject({ scheduledAt: T0, alertDueAt: T0 + 30 * 60_000, name: 'Metformin', status: 'pending', snoozeUntil: null, type: 'standard' });
    expect(await store.getKv('lockscreen_detail')).toBe('full');
    expect(await store.getKv('window_through')).toBe(String(T0 + 5 * 86_400_000));
  });

  it('replaces the window: updates what changed and drops what is no longer issued', async () => {
    const { store } = await make();
    await store.applySync(sync([dose('a'), dose('b')]));
    await store.applySync(sync([dose('a', { name: 'Renamed', status: 'taken' }), dose('c')]));
    const doses = await store.listDoses();
    expect(doses.map((d) => [d.id, d.name, d.status])).toEqual([['a', 'Renamed', 'taken'], ['c', 'Metformin', 'pending']]);
  });

  it('never undoes an answer that has not been delivered yet', async () => {
    const { store } = await make();
    await store.applySync(sync([dose('a'), dose('b')]));
    await store.recordAnswer({ doseId: 'a', action: 'taken', at: T0 + 60_000, eventId: 'e1' });
    await store.applySync(sync([dose('a', { status: 'pending' })])); // the server hasn't heard yet; b is no longer issued
    expect((await store.listDoses()).map((d) => [d.id, d.status])).toEqual([['a', 'taken']]);
    await store.markDelivered('e1', T0 + 120_000);
    await store.applySync(sync([dose('a', { status: 'taken' })]));
    expect((await store.listDoses())[0]!.status).toBe('taken');
  });

  it('keeps an answered dose that the server stopped issuing, until it is delivered', async () => {
    const { store } = await make();
    await store.applySync(sync([dose('a')]));
    await store.recordAnswer({ doseId: 'a', action: 'not_taken', at: T0, eventId: 'e1' });
    await store.applySync(sync([]));
    expect((await store.listDoses()).map((d) => d.id)).toEqual(['a']);
    await store.markDelivered('e1', T0);
    await store.applySync(sync([]));
    expect(await store.listDoses()).toEqual([]);
  });
});

describe('answering', () => {
  const at = T0 + 5 * 60_000;

  it('changes the dose and queues the answer together', async () => {
    const { store } = await make();
    await store.applySync(sync([dose('a')]));
    const r = await store.recordAnswer({ doseId: 'a', action: 'taken', at, eventId: 'e1' });
    expect(r).toMatchObject({ ok: true, dose: { status: 'taken' }, event: { clientEventId: 'e1', action: 'taken', respondedAt: at } });
    expect((await store.listDoses())[0]!.status).toBe('taken');
    expect(await store.dueOutbox(at)).toHaveLength(1);
  });

  it('is all-or-nothing: a failure after the dose changed leaves no half-written answer', async () => {
    const { store, sql } = await make();
    await store.applySync(sync([dose('a')]));
    await store.recordAnswer({ doseId: 'a', action: 'snooze', at, eventId: 'dup' });
    // Reusing an event ID breaks the insert after the dose update: the whole transaction must roll back.
    await sql.run("update doses set status = 'pending', snooze_until = null where id = 'a'");
    await expect(store.recordAnswer({ doseId: 'a', action: 'taken', at: at + 1000, eventId: 'dup' })).rejects.toThrow();
    const [d] = await store.listDoses();
    expect(d).toMatchObject({ status: 'pending', snoozeUntil: null });
    expect(await sql.first<{ n: number }>('select count(*) n from outbox')).toEqual({ n: 1 });
  });

  it('snoozes for 10 minutes without moving the deadline', async () => {
    const { store } = await make();
    await store.applySync(sync([dose('a')]));
    const r = await store.recordAnswer({ doseId: 'a', action: 'snooze', at, eventId: 'e1' });
    expect(r).toMatchObject({ ok: true, dose: { status: 'snoozed', snoozeUntil: at + SNOOZE_MS, alertDueAt: T0 + 30 * 60_000 } });
    expect((await store.recordAnswer({ doseId: 'a', action: 'snooze', at: at + 1000, eventId: 'e2' })).ok).toBe(true); // snoozing again is allowed
    expect((await store.recordAnswer({ doseId: 'a', action: 'taken', at: at + 2000, eventId: 'e3' })).ok).toBe(true);
  });

  it('refuses Snooze when 10 minutes would pass the deadline, as the server does (D-085)', async () => {
    const { store } = await make();
    await store.applySync(sync([dose('a')]));
    expect(await store.recordAnswer({ doseId: 'a', action: 'snooze', at: T0 + 20 * 60_000, eventId: 'e1' })).toEqual({ ok: false, reason: 'snooze_not_allowed' });
    expect(await store.recordAnswer({ doseId: 'a', action: 'snooze', at: T0 + 20 * 60_000 - 1, eventId: 'e2' })).toMatchObject({ ok: true });
  });

  it('a first answer stands: no second answer, no Snooze after one', async () => {
    const { store } = await make();
    await store.applySync(sync([dose('a')]));
    await store.recordAnswer({ doseId: 'a', action: 'not_taken', at, eventId: 'e1' });
    expect(await store.recordAnswer({ doseId: 'a', action: 'taken', at: at + 1, eventId: 'e2' })).toEqual({ ok: false, reason: 'already_answered' });
    expect(await store.recordAnswer({ doseId: 'a', action: 'snooze', at: at + 1, eventId: 'e3' })).toEqual({ ok: false, reason: 'snooze_not_allowed' });
    expect(await store.recordAnswer({ doseId: 'nope', action: 'taken', at, eventId: 'e4' })).toEqual({ ok: false, reason: 'unknown_dose' });
  });

  it('can still answer a dose the server already marked missed (D-032)', async () => {
    const { store } = await make();
    await store.applySync(sync([dose('a', { status: 'missed' })]));
    expect(await store.recordAnswer({ doseId: 'a', action: 'taken', at: T0 + 3_600_000, eventId: 'e1' })).toMatchObject({ ok: true, dose: { status: 'taken' } });
  });
});

describe('delivery queue', () => {
  it('hands out due rows oldest first, and stops once delivered', async () => {
    const { store } = await make();
    await store.applySync(sync([dose('a'), dose('b')]));
    await store.recordAnswer({ doseId: 'a', action: 'taken', at: T0 + 2, eventId: 'e1' });
    await store.recordAnswer({ doseId: 'b', action: 'not_taken', at: T0 + 1, eventId: 'e2' });
    expect((await store.dueOutbox(T0 + 10)).map((r) => r.clientEventId)).toEqual(['e2', 'e1']);
    await store.markDelivered('e2', T0 + 10);
    expect((await store.dueOutbox(T0 + 10)).map((r) => r.clientEventId)).toEqual(['e1']);
    expect(await store.hasUnsent()).toBe(true);
    await store.markDelivered('e1', T0 + 10);
    expect(await store.hasUnsent()).toBe(false);
  });

  it('backs off after a failure, doubling up to an hour', async () => {
    expect([1, 2, 3, 4, 20].map(backoffMs)).toEqual([30_000, 60_000, 120_000, 240_000, 3_600_000]);
    const { store } = await make();
    await store.applySync(sync([dose('a')]));
    await store.recordAnswer({ doseId: 'a', action: 'taken', at: T0, eventId: 'e1' });
    await store.markFailed('e1', T0);
    expect(await store.dueOutbox(T0 + 29_999)).toHaveLength(0);
    expect(await store.dueOutbox(T0 + 30_000)).toHaveLength(1);
    await store.markFailed('e1', T0 + 30_000);
    expect(await store.dueOutbox(T0 + 30_000 + 59_999)).toHaveLength(0);
    expect((await store.dueOutbox(T0 + 30_000 + 60_000))[0]!.attempts).toBe(2);
  });

  it('adopts the server’s final word and forgets old deliveries', async () => {
    const { store } = await make();
    await store.applySync(sync([dose('a')]));
    await store.recordAnswer({ doseId: 'a', action: 'snooze', at: T0 + 60_000, eventId: 'e1' });
    await store.adoptServerState({ id: 'a', status: 'pending', snooze_until: null, alert_due_at: iso(T0 + 30 * 60_000) });
    expect((await store.listDoses())[0]).toMatchObject({ status: 'pending', snoozeUntil: null });
    await store.markDelivered('e1', 1000);
    await store.purgeDelivered(2000);
    expect(await store.dueOutbox(T0)).toEqual([]);
    await store.wipe();
    expect(await store.listDoses()).toEqual([]);
  });
});
