import type { DoseResponseItem, DoseResponseResult, SyncDose, SyncResult } from '../api/endpoints';
import { ApiError } from '../api/http';
import { FakeNotifier } from '../testing/fake-notifier';
import { nodeSql } from '../testing/node-sql';
import { RemindersEngine, type EngineApi } from './engine';
import { Store } from './store';

const MIN = 60_000;
const T0 = Date.parse('2026-11-01T06:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const dose = (id: string, atMin: number, over: Partial<SyncDose> = {}): SyncDose => ({ id, medicine_id: 'm', scheduled_at: iso(T0 + atMin * MIN), local_time: '08:00', name: 'Metformin', amount: '1 tablet', status: 'pending', snooze_until: null, alert_due_at: iso(T0 + (atMin + 30) * MIN), notification_type: 'standard', ...over });
const syncOf = (doses: SyncDose[], over: Partial<SyncResult> = {}): SyncResult => ({ cursor: 'c', patient: { id: 'p1', display_name: 'A', timezone: 'UTC', status: 'active', lockscreen_detail: 'full' }, account_state: 'active', medicines: [], doses, window: { from: iso(T0), through: iso(T0 + 5 * 86_400_000) }, commands: [], ...over });

async function make(platform: 'ios' | 'android' = 'android') {
  const store = new Store(nodeSql());
  await store.migrate();
  const notifier = new FakeNotifier();
  const clock = { now: T0 };
  let server: SyncResult = syncOf([]);
  const sent: DoseResponseItem[][] = [];
  const heartbeats: any[] = [];
  const net = { offline: false, respond: (items: DoseResponseItem[]): DoseResponseResult[] => items.map((i) => ({ client_event_id: i.client_event_id, outcome: 'applied', dose: null })) };
  let n = 0;
  const api: EngineApi = {
    sync: async () => {
      if (net.offline) throw new ApiError('NETWORK', 0, 'offline');
      return structuredClone(server);
    },
    respond: async (items) => {
      if (net.offline) throw new ApiError('NETWORK', 0, 'offline');
      sent.push(items);
      return { results: net.respond(items) };
    },
    heartbeat: async (b) => void heartbeats.push(b),
  };
  const engine = new RemindersEngine({ store, notifier, api, platform, appVersion: '1.0.0', timeZone: () => 'Asia/Kolkata', patientId: () => 'p1', now: () => clock.now, newId: () => `ev-${++n}` });
  return { engine, store, notifier, clock, net, sent, heartbeats, setServer: (s: SyncResult) => (server = s) };
}

describe('syncing', () => {
  it('schedules the issued window, keyed by dose ID, and reports how far it got', async () => {
    const t = await make();
    t.setServer(syncOf([dose('a', 60), dose('b', 180)]));
    expect(await t.engine.sync()).toEqual({ ok: true });
    expect(t.notifier.ids()).toEqual(['dose:a', 'dose:b']);
    expect(t.heartbeats[0]).toMatchObject({ permissions: { notifications: true, exact_alarm: true, battery_unrestricted: true }, app_version: '1.0.0', tz: 'Asia/Kolkata', scheduled_through: iso(T0 + 5 * 86_400_000) });
  });

  it('syncing again changes nothing on the phone (no duplicates, no churn)', async () => {
    const t = await make();
    t.setServer(syncOf([dose('a', 60), dose('b', 180, { notification_type: 'alarm' })]));
    await t.engine.sync();
    const first = t.notifier.scheduleCalls;
    await t.engine.sync();
    await t.engine.sync();
    expect(t.notifier.scheduleCalls).toBe(first);
    expect(t.notifier.byId.size).toBe(1 + 6);
  });

  it('follows the server: a dose that was edited or archived has its reminders removed', async () => {
    const t = await make();
    t.setServer(syncOf([dose('a', 60), dose('b', 180)]));
    await t.engine.sync();
    t.setServer(syncOf([dose('a', 60), dose('c', 240)]));
    await t.engine.sync();
    expect(t.notifier.ids()).toEqual(['dose:a', 'dose:c']);
  });

  it('applies a lock-screen setting change by replacing the notifications', async () => {
    const t = await make();
    t.setServer(syncOf([dose('a', 60)]));
    await t.engine.sync();
    expect(t.notifier.byId.get('dose:a')!.title).toBe('Metformin — 1 tablet');
    t.setServer(syncOf([dose('a', 60)], { patient: { id: 'p1', display_name: 'A', timezone: 'UTC', status: 'active', lockscreen_detail: 'generic' } }));
    await t.engine.sync();
    expect(t.notifier.byId.get('dose:a')!.title).toBe('Medicine reminder');
  });

  it('works offline: the schedule already on the phone stays right, and passed notifications are cleared', async () => {
    const t = await make();
    t.setServer(syncOf([dose('a', 60), dose('b', 180)]));
    await t.engine.sync();
    t.net.offline = true;
    t.clock.now = T0 + 120 * MIN; // dose a has come and gone
    const r = await t.engine.sync();
    expect(r.ok).toBe(false);
    expect((r as { error: ApiError }).error.code).toBe('NETWORK');
    expect(t.notifier.ids()).toEqual(['dose:b']);
  });

  it('never touches notifications that are not ours', async () => {
    const t = await make();
    t.notifier.foreign.add('someone-else');
    t.setServer(syncOf([dose('a', 60)]));
    await t.engine.sync();
    t.setServer(syncOf([]));
    await t.engine.sync();
    expect(t.notifier.foreign.has('someone-else')).toBe(true);
    expect(t.notifier.ids()).toEqual([]);
  });

  it('a cutoff command silences every alarm and forgets the doses (07)', async () => {
    const t = await make();
    t.setServer(syncOf([dose('a', 60, { notification_type: 'alarm' }), dose('b', 180)]));
    await t.engine.sync();
    expect(t.notifier.byId.size).toBeGreaterThan(2);
    t.notifier.foreign.add('someone-else');
    t.setServer(syncOf([], { account_state: 'suspended', commands: ['cancel_all'] }));
    await t.engine.sync();
    expect(t.notifier.ids()).toEqual([]);
    expect(t.notifier.foreign.has('someone-else')).toBe(true);
    expect(await t.store.listDoses()).toEqual([]);
  });

  it('reports a permission that is off, and an iOS phone sends no Android-only fields', async () => {
    const off = await make();
    off.notifier.perms = { notifications: false, exactAlarm: false, batteryUnrestricted: false };
    off.setServer(syncOf([dose('a', 60)]));
    await off.engine.sync();
    expect(off.heartbeats[0].permissions).toEqual({ notifications: false, exact_alarm: false, battery_unrestricted: false });
    const ios = await make('ios');
    ios.notifier.perms = { notifications: true, exactAlarm: null, batteryUnrestricted: null };
    ios.setServer(syncOf([dose('a', 60)]));
    await ios.engine.sync();
    expect(ios.heartbeats[0].permissions).toEqual({ notifications: true });
  });
});

describe('answering (D-031: local first)', () => {
  it('Taken: the reminders go, the shade is cleared, and the answer is sent', async () => {
    const t = await make();
    t.setServer(syncOf([dose('a', 60, { notification_type: 'alarm' })]));
    await t.engine.sync();
    expect(t.notifier.byId.size).toBe(6);
    t.clock.now = T0 + 62 * MIN;
    const r = await t.engine.answer('a', 'taken');
    expect(r.ok).toBe(true);
    expect(t.notifier.ids()).toEqual([]); // the dose and its follow-ups
    expect(t.notifier.dismissed).toEqual(['a']);
    await t.engine.flush();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]![0]).toMatchObject({ client_event_id: 'ev-1', dose_id: 'a', action: 'taken', responded_at: iso(T0 + 62 * MIN), network_restored_at: null });
    expect(await t.store.dueOutbox(t.clock.now)).toEqual([]);
  });

  it('with no connection the answer still counts, and is delivered later', async () => {
    const t = await make();
    t.setServer(syncOf([dose('a', 60, { notification_type: 'alarm' })]));
    await t.engine.sync();
    t.net.offline = true;
    t.clock.now = T0 + 62 * MIN;
    await t.engine.answer('a', 'not_taken');
    await t.engine.flush().catch(() => undefined);
    expect(t.notifier.ids()).toEqual([]); // no more nagging, though nothing was sent
    expect((await t.store.listDoses())[0]!.status).toBe('not_taken');
    expect(await t.store.hasUnsent()).toBe(true);

    t.net.offline = false;
    t.clock.now += 10 * MIN; // the retry wait has passed
    await t.engine.flush();
    expect(t.sent[0]![0]).toMatchObject({ action: 'not_taken', responded_at: iso(T0 + 62 * MIN) }); // the time they tapped, not the time it got through
    expect(await t.store.hasUnsent()).toBe(false);
  });

  it('a pull cannot undo an answer that has not been delivered yet', async () => {
    const t = await make();
    t.setServer(syncOf([dose('a', 60)]));
    await t.engine.sync();
    t.net.offline = true;
    t.clock.now = T0 + 61 * MIN;
    await t.engine.answer('a', 'taken');
    t.net.offline = false;
    t.net.respond = () => {
      throw new Error('server down'); // delivery fails, but the pull below succeeds
    };
    await t.engine.sync();
    expect((await t.store.listDoses())[0]!.status).toBe('taken');
    expect(t.notifier.ids()).toEqual([]);
  });

  it('Snooze replaces the reminder with one 10 minutes later, and Alarm follow-ups resume after it', async () => {
    const t = await make();
    t.setServer(syncOf([dose('a', 60, { notification_type: 'alarm' })], {}));
    await t.engine.sync();
    t.clock.now = T0 + 61 * MIN;
    await t.engine.answer('a', 'snooze');
    expect(t.notifier.ids()).toEqual(['dose:a:s', 'dose:a:sf1', 'dose:a:sf2', 'dose:a:sf3']);
    expect(t.notifier.byId.get('dose:a:s')!.fireAt).toBe(T0 + 71 * MIN);
    expect(t.notifier.byId.get('dose:a:sf3')!.fireAt).toBe(T0 + 86 * MIN); // deadline is +90, so +5 steps from +71 until before it
  });

  it('refuses a Snooze that would pass the deadline, and sends nothing', async () => {
    const t = await make();
    t.setServer(syncOf([dose('a', 60)]));
    await t.engine.sync();
    t.clock.now = T0 + 85 * MIN;
    expect(await t.engine.answer('a', 'snooze')).toEqual({ ok: false, reason: 'snooze_not_allowed' });
    await t.engine.flush();
    expect(t.sent).toHaveLength(0);
  });

  it('the server’s version wins when an earlier answer from another phone beat ours', async () => {
    const t = await make();
    t.setServer(syncOf([dose('a', 60)]));
    await t.engine.sync();
    t.net.respond = (items) => items.map((i) => ({ client_event_id: i.client_event_id, outcome: 'superseded' as const, dose: { id: 'a', status: 'not_taken' as const, snooze_until: null, responded_at: iso(T0 + 50 * MIN), alert_due_at: iso(T0 + 90 * MIN) } }));
    t.clock.now = T0 + 62 * MIN;
    await t.engine.answer('a', 'taken');
    await t.engine.flush();
    expect((await t.store.listDoses())[0]!.status).toBe('not_taken');
    expect(t.notifier.ids()).toEqual([]);
  });

  it('a Snooze the server refuses puts the reminders back', async () => {
    const t = await make();
    t.setServer(syncOf([dose('a', 60, { alert_due_at: iso(T0 + 200 * MIN) })]));
    await t.engine.sync();
    t.net.respond = (items) => items.map((i) => ({ client_event_id: i.client_event_id, outcome: 'rejected' as const, dose: { id: 'a', status: 'pending' as const, snooze_until: null, responded_at: null, alert_due_at: iso(T0 + 63 * MIN) } }));
    t.clock.now = T0 + 55 * MIN;
    await t.engine.answer('a', 'snooze');
    expect(t.notifier.ids()).toEqual(['dose:a:s']);
    await t.engine.flush();
    expect((await t.store.listDoses())[0]).toMatchObject({ status: 'pending', alertDueAt: T0 + 63 * MIN });
  });

  it('sends the waiting answers before pulling, so the server hears them first', async () => {
    const t = await make();
    t.setServer(syncOf([dose('a', 60), dose('b', 120)]));
    await t.engine.sync();
    t.net.offline = true;
    t.clock.now = T0 + 61 * MIN;
    await t.engine.answer('a', 'taken');
    t.net.offline = false;
    t.clock.now += 10 * MIN;
    await t.engine.sync();
    expect(t.sent[0]![0]!.dose_id).toBe('a');
    expect(await t.store.hasUnsent()).toBe(false);
  });

  it('two flushes at once make one request', async () => {
    const t = await make();
    t.setServer(syncOf([dose('a', 60)]));
    await t.engine.sync();
    t.clock.now = T0 + 61 * MIN;
    await t.engine.answer('a', 'taken');
    await Promise.all([t.engine.flush(), t.engine.flush(), t.engine.flush()]);
    expect(t.sent).toHaveLength(1);
  });

  it('keeps trying with a growing wait while the server keeps failing', async () => {
    const t = await make();
    t.setServer(syncOf([dose('a', 60)]));
    await t.engine.sync();
    let tries = 0;
    t.net.respond = () => {
      tries++;
      throw new ApiError('NETWORK', 0, 'down');
    };
    t.clock.now = T0 + 61 * MIN;
    await t.engine.answer('a', 'taken');
    await t.engine.flush().catch(() => undefined);
    expect(tries).toBe(1);
    await t.engine.flush().catch(() => undefined); // straight away: still waiting
    expect(tries).toBe(1);
    t.clock.now += 31_000; // 30 s wait over
    await t.engine.flush().catch(() => undefined);
    expect(tries).toBe(2);
    t.clock.now += 31_000; // the next wait is 60 s
    await t.engine.flush().catch(() => undefined);
    expect(tries).toBe(2);
    t.clock.now += 30_000;
    await t.engine.flush().catch(() => undefined);
    expect(tries).toBe(3);
    expect(await t.store.hasUnsent()).toBe(true); // never dropped
  });
});

describe('the cutoff leaves a record the screen can show', () => {
  it('remembers that reminders are paused after clearing everything', async () => {
    const t = await make();
    t.setServer(syncOf([dose('a', 60)]));
    await t.engine.sync();
    t.setServer(syncOf([], { account_state: 'suspended', commands: ['cancel_all'] }));
    await t.engine.sync();
    expect(await t.store.getKv('account_state')).toBe('suspended');
    expect(await t.store.listDoses()).toEqual([]);
  });
});
