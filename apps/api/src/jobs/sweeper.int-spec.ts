import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { devices, doseInstances, notificationLog, patients, subscriptions } from '../db/schema.js';
import { PushModule } from '../push/push.module.js';
import { staggerMs, startApp } from '../testing/harness.js';
import { JobsCoreModule } from './jobs.module.js';
import { SweeperService } from './sweeper.service.js';

let t: Awaited<ReturnType<typeof startApp>>;
let sweeper: SweeperService;
beforeAll(async () => {
  t = await startApp({ imports: [PushModule, JobsCoreModule] });
  sweeper = t.app.get(SweeperService);
});
beforeEach(async () => {
  await t.redis.flushdb();
  // The sweeper is global: leftovers from earlier tests would be counted as this test's work.
  await t.db.delete(notificationLog);
  await t.db.delete(doseInstances);
});
afterAll(() => t.close());

const ago = (min: number) => new Date(Date.now() - min * 60_000);
const ahead = (min: number) => new Date(Date.now() + min * 60_000);
const schedule = { pattern: 'daily', start_date: '2026-01-01', times: [{ local_time: '08:00', amount_text: '1' }] };
const healthyBeat = { permissions: { notifications: true, exact_alarm: true, battery_unrestricted: true }, app_version: '1.0.0', tz: 'Asia/Kolkata', scheduled_through: ahead(60 * 72).toISOString() };

async function setup(over: object = {}) {
  const me = await t.caregiver();
  const p = await t.patientOf(me, over);
  const med = (await t.call(me, 'post', `/v1/patients/${p.id}/medicines`, { name: 'Metformin', schedule })).body;
  const phone = await t.pair(me, p.id);
  await t.asDevice(phone.token, 'post', '/v1/devices/heartbeat').send(healthyBeat);
  const doses = await t.db.select().from(doseInstances).where(eq(doseInstances.patientId, p.id)).orderBy(asc(doseInstances.scheduledAt));
  // Make one dose due: it was scheduled `due` minutes ago with a deadline `deadline` minutes after that.
  const place = (id: string, due: number, deadline = 30, status: 'pending' | 'snoozed' | 'taken' = 'pending') => {
    const at = new Date(ago(due).getTime() - staggerMs());
    return t.db.update(doseInstances).set({ scheduledAt: at, alertDueAt: new Date(at.getTime() + deadline * 60_000), status, pushSentAt: null, alertSentAt: null }).where(eq(doseInstances.id, id));
  };
  const rows = (kind: string) => t.db.select().from(notificationLog).where(and(eq(notificationLog.patientId, p.id), eq(notificationLog.kind, kind as 'backup')));
  const dose = async (id: string) => (await t.db.select().from(doseInstances).where(eq(doseInstances.id, id)))[0]!;
  const carerDevice = async () => (await t.db.select().from(devices).where(eq(devices.userId, me.id)))[0]!;
  return { me, p, med, phone, doses, place, rows, dose, carerDevice };
}

describe('Pass A: backup push (D-036)', () => {
  it('queues nothing for a healthy phone, but still marks the dose as evaluated', async () => {
    const s = await setup();
    await s.place(s.doses[0]!.id, 5);
    expect(await sweeper.passA(new Date())).toBe(1);
    expect(await s.rows('backup')).toHaveLength(0);
    expect((await s.dose(s.doses[0]!.id)).pushSentAt).toBeTruthy();
  });

  it.each([
    ['the dose is beyond scheduled_through', { scheduledThrough: ago(60) }],
    ['the phone never reported a window', { scheduledThrough: null }],
    ['the phone has been silent for 13 hours', { lastSeenAt: ago(13 * 60) }],
    ['exact alarms are off', { permExactAlarm: false }],
    ['battery optimisation is on', { permBatteryUnrestricted: false }],
    ['notifications are off', { permNotifications: false }],
    ['a permission was never reported', { permExactAlarm: null }],
  ])('queues a backup when %s', async (_l, change) => {
    const s = await setup();
    await t.db.update(devices).set(change).where(eq(devices.id, s.phone.deviceId));
    await s.place(s.doses[0]!.id, 5);
    await sweeper.passA(new Date());
    const rows = await s.rows('backup');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ deviceId: s.phone.deviceId, doseInstanceId: s.doses[0]!.id, status: 'queued' });
  });

  it('only the unhealthy phone of two gets a backup', async () => {
    const s = await setup();
    const second = await t.pair(s.me, s.p.id);
    await t.asDevice(second.token, 'post', '/v1/devices/heartbeat').send({ ...healthyBeat, permissions: { ...healthyBeat.permissions, exact_alarm: false } });
    await s.place(s.doses[0]!.id, 5);
    await sweeper.passA(new Date());
    expect((await s.rows('backup')).map((r) => r.deviceId)).toEqual([second.deviceId]);
  });

  it('skips revoked phones, suspended patients, answered doses, future doses and doses past their deadline', async () => {
    const s = await setup();
    await t.db.update(devices).set({ scheduledThrough: null }).where(eq(devices.id, s.phone.deviceId)); // would need a backup
    await s.place(s.doses[0]!.id, 5, 30, 'taken');
    await s.place(s.doses[1]!.id, 60, 30); // deadline passed 30 minutes ago: Pass B's
    await t.db.update(doseInstances).set({ scheduledAt: ahead(30), pushSentAt: null }).where(eq(doseInstances.id, s.doses[2]!.id));
    await sweeper.passA(new Date());
    expect(await s.rows('backup')).toHaveLength(0);
    expect((await s.dose(s.doses[1]!.id)).pushSentAt).toBeNull();
    expect((await s.dose(s.doses[2]!.id)).pushSentAt).toBeNull();

    await s.place(s.doses[3]!.id, 5);
    await t.db.update(patients).set({ status: 'suspended' }).where(eq(patients.id, s.p.id));
    expect(await sweeper.passA(new Date())).toBe(0);
    await t.db.update(patients).set({ status: 'active' }).where(eq(patients.id, s.p.id));
    await t.db.update(devices).set({ revokedAt: new Date() }).where(eq(devices.id, s.phone.deviceId));
    await sweeper.passA(new Date());
    expect(await s.rows('backup')).toHaveLength(0); // no active phone to push to
  });

  it('is idempotent: a second run does nothing', async () => {
    const s = await setup();
    await t.db.update(devices).set({ scheduledThrough: null }).where(eq(devices.id, s.phone.deviceId));
    await s.place(s.doses[0]!.id, 5);
    await sweeper.passA(new Date());
    expect(await sweeper.passA(new Date())).toBe(0);
    expect(await s.rows('backup')).toHaveLength(1);
  });
});

describe('Pass B: missed alerts (D-044)', () => {
  it('marks the dose missed once and alerts the owner', async () => {
    const s = await setup();
    await s.place(s.doses[0]!.id, 40, 30);
    expect(await sweeper.passB(new Date())).toBe(1);
    const row = await s.dose(s.doses[0]!.id);
    expect(row.status).toBe('missed');
    expect(row.alertSentAt).toBeTruthy();
    const alerts = await s.rows('missed');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ deviceId: (await s.carerDevice()).id, doseInstanceId: s.doses[0]!.id, status: 'queued' });
    expect(alerts[0]!.data).toMatchObject({ count: 1 });
    expect(await sweeper.passB(new Date())).toBe(0); // exactly once
    expect(await s.rows('missed')).toHaveLength(1);
  });

  it('waits for the deadline, ignores answered doses and snoozing never moves it', async () => {
    const s = await setup();
    await s.place(s.doses[0]!.id, 20, 30); // deadline in 10 minutes
    await s.place(s.doses[1]!.id, 40, 30, 'taken');
    await s.place(s.doses[2]!.id, 40, 30, 'snoozed'); // snoozed past the deadline: still missed
    await sweeper.passB(new Date());
    expect((await s.dose(s.doses[0]!.id)).status).toBe('pending');
    expect((await s.dose(s.doses[1]!.id)).status).toBe('taken');
    expect((await s.dose(s.doses[2]!.id)).status).toBe('missed');
  });

  it('is skipped for suspended patients and sends nothing without a signed-in caregiver phone', async () => {
    const s = await setup();
    await s.place(s.doses[0]!.id, 40, 30);
    await t.db.update(patients).set({ status: 'suspended' }).where(eq(patients.id, s.p.id));
    expect(await sweeper.passB(new Date())).toBe(0);
    await t.db.update(patients).set({ status: 'active' }).where(eq(patients.id, s.p.id));
    await t.call(s.me, 'post', '/v1/auth/logout');
    await sweeper.passB(new Date());
    expect((await s.dose(s.doses[0]!.id)).status).toBe('missed');
    expect(await s.rows('missed')).toHaveLength(0);
  });

  it('groups misses: one alert per run, and a miss within 15 minutes replaces it (D-046)', async () => {
    const s = await setup();
    for (const [i, d] of s.doses.slice(0, 3).entries()) await s.place(d.id, 40 + i, 30);
    const t0 = new Date();
    await sweeper.passB(t0);
    const first = await s.rows('missed');
    expect(first).toHaveLength(1); // three misses, one alert
    expect(first[0]!.data).toMatchObject({ count: 3 });
    expect(first[0]!.groupKey).toMatch(/^missed:/);

    await s.place(s.doses[3]!.id, 40, 30);
    await sweeper.passB(new Date(t0.getTime() + 5 * 60_000)); // 5 minutes later: joins the group
    const second = (await s.rows('missed')).filter((r) => r.id !== first[0]!.id);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ groupKey: first[0]!.groupKey });
    expect(second[0]!.data).toMatchObject({ count: 4 });

    await s.place(s.doses[4]!.id, 40, 30);
    await sweeper.passB(new Date(t0.getTime() + 20 * 60_000)); // 20 minutes after the group began: a new group
    const third = (await s.rows('missed')).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!;
    expect(third.groupKey).not.toBe(first[0]!.groupKey);
    expect(third.data).toMatchObject({ count: 1 });
  });

  it('four workers over thousands of due doses process every one exactly once', async () => {
    const s = await setup();
    const base = s.doses[0]!;
    // Clone one dose 3,000 times, all past their deadline (the medicine × instant pair must be unique).
    await t.db.execute(sql`
      insert into dose_instances (patient_id, medicine_id, schedule_version_id, scheduled_at, local_time, name_snapshot, amount_snapshot, alert_due_at)
      select patient_id, medicine_id, schedule_version_id, now() - make_interval(mins => 60 + g), local_time, name_snapshot, amount_snapshot, now() - make_interval(mins => 30 + g)
      from dose_instances, generate_series(1, 3000) g where id = ${base.id}`);
    const total = await t.db.$count(doseInstances, and(eq(doseInstances.patientId, s.p.id), eq(doseInstances.status, 'pending')));
    const handled = await Promise.all([1, 2, 3, 4].map(() => sweeper.run(new Date())));
    const missed = handled.reduce((n, r) => n + r.missed, 0);
    expect(await t.db.$count(doseInstances, and(eq(doseInstances.patientId, s.p.id), eq(doseInstances.status, 'missed')))).toBeGreaterThanOrEqual(3000);
    const stillPending = await t.db.$count(doseInstances, and(eq(doseInstances.patientId, s.p.id), eq(doseInstances.status, 'pending'), sql`${doseInstances.alertDueAt} <= now()`));
    expect(stillPending).toBe(0);
    expect(missed).toBe(total - (await t.db.$count(doseInstances, and(eq(doseInstances.patientId, s.p.id), eq(doseInstances.status, 'pending')))));
    const flagged = await t.db.select({ id: doseInstances.id }).from(doseInstances).where(and(eq(doseInstances.patientId, s.p.id), eq(doseInstances.status, 'missed')));
    expect(new Set(flagged.map((f) => f.id)).size).toBe(flagged.length);
  }, 120_000);
});

describe('Pass C: billing cutoff (07)', () => {
  async function inGrace(cutoffInMin: number) {
    const s = await setup();
    await t.db.update(subscriptions).set({ status: 'grace', expiredAt: ago(60 * 24 - cutoffInMin), cutoffAt: ahead(cutoffInMin) }).where(eq(subscriptions.userId, s.me.id));
    return s;
  }

  it('does nothing before the cutoff', async () => {
    const s = await inGrace(120);
    expect(await sweeper.passC(new Date())).toBe(0);
    expect((await t.db.select().from(patients).where(eq(patients.id, s.p.id)))[0]!.status).toBe('active');
  });

  it('warns once, 6 hours before the cutoff', async () => {
    const s = await inGrace(300);
    await sweeper.passC(new Date());
    await sweeper.passC(new Date());
    const warnings = await t.db.select().from(notificationLog).where(and(eq(notificationLog.kind, 'billing'), eq(notificationLog.deviceId, (await s.carerDevice()).id)));
    expect(warnings.map((w) => (w.data as { event: string }).event)).toEqual(['cutoff_soon']);
  });

  it('at the cutoff: expires the subscription, suspends managed and self patients, and cancels every phone', async () => {
    const s = await setup();
    const self = await t.patientOf(s.me, { type: 'self', display_name: 'Me' });
    const archived = await t.patientOf(s.me, { display_name: 'Old' });
    await t.call(s.me, 'post', `/v1/patients/${archived.id}/archive`);
    await t.db.update(subscriptions).set({ status: 'grace', expiredAt: ago(60 * 24 + 1), cutoffAt: ago(1) }).where(eq(subscriptions.userId, s.me.id));
    expect(await sweeper.passC(new Date())).toBe(1);
    expect((await t.db.select().from(subscriptions).where(eq(subscriptions.userId, s.me.id)))[0]!.status).toBe('expired');
    const states = await t.db.select().from(patients).where(inArray(patients.id, [s.p.id, self.id, archived.id]));
    expect(Object.fromEntries(states.map((p) => [p.id, p.status]))).toEqual({ [s.p.id]: 'suspended', [self.id]: 'suspended', [archived.id]: 'archived' });
    const cancel = await t.db.select().from(notificationLog).where(and(eq(notificationLog.kind, 'sync'), eq(notificationLog.deviceId, s.phone.deviceId)));
    expect(cancel.map((c) => c.data)).toContainEqual({ command: 'cancel_all' });
    expect((await t.db.select().from(notificationLog).where(and(eq(notificationLog.kind, 'billing'), eq(notificationLog.deviceId, (await s.carerDevice()).id)))).map((b) => (b.data as { event: string }).event)).toContain('suspended');
    expect(await sweeper.passC(new Date())).toBe(0); // once
    // Nothing more is generated, pushed or alerted for them.
    await s.place(s.doses[0]!.id, 40, 30);
    expect(await sweeper.run(new Date())).toMatchObject({ backup: 0, missed: 0 });
  });
});

it('a run that is late catches up in one go', async () => {
  const s = await setup();
  await s.place(s.doses[0]!.id, 600, 30); // ten hours overdue: the sweeper was down
  const out = await sweeper.run(new Date());
  expect(out.missed).toBe(1);
  void randomUUID;
});
