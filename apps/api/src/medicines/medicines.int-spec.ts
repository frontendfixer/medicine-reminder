import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { auditLog, caregiverSettings, doseInstances, medicines, patients, scheduleVersions } from '../db/schema.js';
import { startApp } from '../testing/harness.js';

let t: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  t = await startApp();
});
beforeEach(() => t.redis.flushdb());
afterAll(() => t.close());

const schedule = (over: object = {}) => ({
  pattern: 'daily',
  start_date: '2026-01-01',
  times: [
    { local_time: '08:00', amount_text: '1 tablet' },
    { local_time: '21:00', amount_text: '2 tablets' },
  ],
  ...over,
});
const input = (over: object = {}) => ({ name: 'Metformin 500', notes: 'After food', notification_type: 'alarm', schedule: schedule(), ...over });
async function setup() {
  const me = await t.caregiver();
  const p = await t.patientOf(me);
  const create = (over: object = {}) => t.call(me, 'post', `/v1/patients/${p.id}/medicines`, input(over));
  return { me, p, create };
}
const dosesOf = (medicineId: string) => t.db.select().from(doseInstances).where(eq(doseInstances.medicineId, medicineId)).orderBy(asc(doseInstances.scheduledAt));
const days = (n: number) => new Date(Date.now() + n * 86_400_000);

describe('POST /v1/patients/:id/medicines', () => {
  it('creates the medicine, schedule version 1 and 14 days of doses, with name and notes encrypted', async () => {
    const { me, p, create } = await setup();
    const res = await create();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ patient_id: p.id, name: 'Metformin 500', notes: 'After food', notification_type: 'alarm', archived_at: null });
    expect(res.body.schedule).toMatchObject({ pattern: 'daily', start_date: '2026-01-01', end_date: null });
    expect(res.body.schedule.times).toMatchObject([{ local_time: '08:00', amount_text: '1 tablet' }, { local_time: '21:00', amount_text: '2 tablets' }]);

    const [row] = await t.db.select().from(medicines).where(eq(medicines.id, res.body.id));
    expect(row!.name.toString('utf8')).not.toContain('Metformin');
    expect(row!.notes!.toString('utf8')).not.toContain('food');

    const doses = await dosesOf(res.body.id);
    expect(doses.length).toBeGreaterThanOrEqual(27); // 2 a day for 14 days, minus the part of today already past
    expect(doses.length).toBeLessThanOrEqual(29);
    expect(doses.every((d) => d.status === 'pending' && d.scheduledAt > new Date() && d.scheduledAt < days(14.01))).toBe(true);
    expect(doses[0]!.nameSnapshot.toString('utf8')).toMatch(/^v1:/);
    expect(doses[0]!.nameSnapshot.toString('utf8')).not.toContain('Metformin');
    expect(new Set(doses.map((d) => d.nameSnapshot.toString('utf8'))).size).toBe(doses.length); // a fresh IV per row
    expect(doses.map((d) => d.localTime.slice(0, 5))).toEqual(expect.arrayContaining(['08:00', '21:00']));
    expect(new Set(doses.map((d) => d.amountSnapshot))).toEqual(new Set(['1 tablet', '2 tablets']));
    const audit = await t.db.select().from(auditLog).where(and(eq(auditLog.patientId, p.id), eq(auditLog.action, 'medicine.created')));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain('Metformin');
    await t.call(me, 'get', `/v1/medicines/${res.body.id}`).then((r) => expect(r.body.name).toBe('Metformin 500'));
  });

  it('freezes alert_due_at from medicine → patient → caregiver default (D-043)', async () => {
    const { me, p, create } = await setup();
    const delays = async (id: string) => new Set((await dosesOf(id)).map((d) => (d.alertDueAt.getTime() - d.scheduledAt.getTime()) / 60_000));
    expect(await delays((await create()).body.id)).toEqual(new Set([30])); // caregiver default
    await t.call(me, 'patch', `/v1/patients/${p.id}`, { missed_delay_min: 20 });
    expect(await delays((await create({ name: 'B' })).body.id)).toEqual(new Set([20])); // patient override
    expect(await delays((await create({ name: 'C', missed_delay_min: 45 })).body.id)).toEqual(new Set([45])); // medicine override
  });

  it('is idempotent with a key, and requires one', async () => {
    const { me, p } = await setup();
    const key = randomUUID();
    const first = await t.call(me, 'post', `/v1/patients/${p.id}/medicines`, input(), key);
    const retry = await t.call(me, 'post', `/v1/patients/${p.id}/medicines`, input(), key);
    expect(retry.body).toEqual(first.body);
    expect(await t.db.$count(medicines, eq(medicines.patientId, p.id))).toBe(1);
    expect((await t.call(me, 'post', `/v1/patients/${p.id}/medicines`, input(), null)).status).toBe(400);
  });

  it('refuses suspended and archived patients, and other caregivers', async () => {
    const { me, p, create } = await setup();
    const stranger = await t.caregiver();
    expect((await t.call(stranger, 'post', `/v1/patients/${p.id}/medicines`, input())).status).toBe(404);
    await t.db.update(patients).set({ status: 'suspended' }).where(eq(patients.id, p.id));
    expect((await create()).body.error.code).toBe('PATIENT_SUSPENDED');
    await t.db.update(patients).set({ status: 'archived' }).where(eq(patients.id, p.id));
    expect((await create()).body.error.code).toBe('PATIENT_ARCHIVED');
    expect(await t.db.$count(medicines, eq(medicines.patientId, p.id))).toBe(0);
    void me;
  });

  it.each([
    ['weekdays without days', { schedule: schedule({ pattern: 'weekdays' }) }, 'schedule.days_of_week'],
    ['weekday 8', { schedule: schedule({ pattern: 'weekdays', days_of_week: [8] }) }, 'schedule.days_of_week.0'],
    ['every_n_days without interval', { schedule: schedule({ pattern: 'every_n_days' }) }, 'schedule.interval_days'],
    ['interval 1', { schedule: schedule({ pattern: 'every_n_days', interval_days: 1 }) }, 'schedule.interval_days'],
    ['end before start', { schedule: schedule({ end_date: '2025-12-31' }) }, 'schedule.end_date'],
    ['no times', { schedule: schedule({ times: [] }) }, 'schedule.times'],
    ['duplicate times', { schedule: schedule({ times: [{ local_time: '08:00', amount_text: 'a' }, { local_time: '08:00', amount_text: 'b' }] }) }, 'schedule.times'],
    ['time 24:00', { schedule: schedule({ times: [{ local_time: '24:00', amount_text: 'a' }] }) }, 'schedule.times.0.local_time'],
    ['empty amount', { schedule: schedule({ times: [{ local_time: '08:00', amount_text: ' ' }] }) }, 'schedule.times.0.amount_text'],
    ['bad date', { schedule: schedule({ start_date: '01/11/2026' }) }, 'schedule.start_date'],
    ['empty name', { name: ' ' }, 'name'],
    ['bad type', { notification_type: 'loud' }, 'notification_type'],
    ['delay 0', { missed_delay_min: 0 }, 'missed_delay_min'],
    ['photo for another patient', { photo_object_key: `p/${randomUUID()}/m/${randomUUID()}.jpg` }, 'photo_object_key'],
  ])('rejects %s', async (_l, over, field) => {
    const { create } = await setup();
    const res = await create(over);
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.error.details.fields)).toContain(field);
  });
});

describe('isolation', () => {
  it('another caregiver’s medicine is a 404 for get, patch, archive and list', async () => {
    const { p, create } = await setup();
    const med = (await create()).body;
    const stranger = await t.caregiver();
    for (const r of await Promise.all([
      t.call(stranger, 'get', `/v1/medicines/${med.id}`),
      t.call(stranger, 'patch', `/v1/medicines/${med.id}`, { name: 'Hijack' }),
      t.call(stranger, 'post', `/v1/medicines/${med.id}/archive`),
      t.call(stranger, 'get', `/v1/patients/${p.id}/medicines`),
      t.call(stranger, 'get', `/v1/medicines/${randomUUID()}`),
      t.call(stranger, 'get', '/v1/medicines/not-a-uuid'),
    ])) {
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe('NOT_FOUND');
    }
    expect((await t.db.select().from(medicines).where(eq(medicines.id, med.id)))[0]!.archivedAt).toBeNull();
  });
});

describe('PATCH /v1/medicines/:id', () => {
  it('closes the open version, opens a new one now, and rebuilds only future pending doses', async () => {
    const { me, create } = await setup();
    const med = (await create()).body;
    const before = await dosesOf(med.id);
    // Give the history something to protect: one answered, one snoozed, one past pending.
    await t.db.update(doseInstances).set({ status: 'taken', respondedAt: new Date() }).where(eq(doseInstances.id, before[0]!.id));
    await t.db.update(doseInstances).set({ status: 'snoozed', snoozeUntil: days(1) }).where(eq(doseInstances.id, before[1]!.id));
    const [past] = await t.db
      .insert(doseInstances)
      .values({ ...before[2]!, id: undefined, scheduledAt: days(-1), alertDueAt: days(-0.9), status: 'pending' })
      .returning();

    const res = await t.call(me, 'patch', `/v1/medicines/${med.id}`, { name: 'Metformin 850', schedule: schedule({ times: [{ local_time: '09:30', amount_text: '1 tablet' }] }) });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Metformin 850');
    expect(res.body.schedule.times).toMatchObject([{ local_time: '09:30' }]);

    const versions = await t.db.select().from(scheduleVersions).where(eq(scheduleVersions.medicineId, med.id)).orderBy(asc(scheduleVersions.effectiveFrom));
    expect(versions).toHaveLength(2);
    expect(versions[0]!.effectiveUntil).toEqual(versions[1]!.effectiveFrom); // no gap, no overlap
    expect(await t.db.$count(scheduleVersions, and(eq(scheduleVersions.medicineId, med.id), isNull(scheduleVersions.effectiveUntil)))).toBe(1);

    const after = await dosesOf(med.id);
    const ids = new Set(after.map((d) => d.id));
    expect(ids.has(before[0]!.id)).toBe(true); // answered: untouched
    expect(ids.has(before[1]!.id)).toBe(true); // snoozed: untouched
    expect(ids.has(past!.id)).toBe(true); // past pending: untouched
    const rebuilt = after.filter((d) => d.status === 'pending' && d.scheduledAt > new Date());
    expect(rebuilt.length).toBeGreaterThanOrEqual(13);
    expect(rebuilt.every((d) => d.localTime.startsWith('09:30') && !before.some((b) => b.id === d.id))).toBe(true);
    expect(rebuilt.every((d) => d.scheduleVersionId === versions[1]!.id)).toBe(true);
    const audit = await t.db.select().from(auditLog).where(eq(auditLog.action, 'medicine.updated'));
    expect(audit[0]!.meta).toEqual({ fields: ['name', 'schedule'] });
  });

  it('a change that leaves the schedule alone keeps its times and every_n_days anchor', async () => {
    const { me, create } = await setup();
    const med = (await create({ schedule: schedule({ pattern: 'every_n_days', interval_days: 3, start_date: '2026-10-01' }) })).body;
    const before = (await dosesOf(med.id)).map((d) => d.scheduledAt.toISOString());
    const res = await t.call(me, 'patch', `/v1/medicines/${med.id}`, { notes: null, notification_type: 'gentle' });
    expect(res.body).toMatchObject({ notes: null, notification_type: 'gentle' });
    expect(res.body.schedule).toMatchObject({ pattern: 'every_n_days', interval_days: 3, start_date: '2026-10-01' });
    expect((await dosesOf(med.id)).map((d) => d.scheduledAt.toISOString())).toEqual(before); // same instants, rebuilt rows
  });

  it('refreshes name snapshots on upcoming doses and rejects empty, unknown and archived edits', async () => {
    const { me, create } = await setup();
    const med = (await create()).body;
    await t.call(me, 'patch', `/v1/medicines/${med.id}`, { name: 'Renamed' });
    const sample = (await dosesOf(med.id))[0]!;
    const fe = t.app.get((await import('../crypto/field-encryption.js')).FieldEncryption);
    expect(fe.decrypt('dose_instances.name_snapshot', sample.nameSnapshot)).toBe('Renamed');
    for (const body of [{}, { patient_id: randomUUID() }, { archived_at: null }]) expect((await t.call(me, 'patch', `/v1/medicines/${med.id}`, body)).status).toBe(400);
    await t.call(me, 'post', `/v1/medicines/${med.id}/archive`);
    const res = await t.call(me, 'patch', `/v1/medicines/${med.id}`, { name: 'X' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MEDICINE_ARCHIVED');
  });
});

describe('archive', () => {
  it('stops reminders, keeps history, and is repeatable', async () => {
    const { me, p, create } = await setup();
    const med = (await create()).body;
    const all = await dosesOf(med.id);
    await t.db.update(doseInstances).set({ status: 'taken' }).where(eq(doseInstances.id, all[0]!.id));
    const res = await t.call(me, 'post', `/v1/medicines/${med.id}/archive`);
    expect(res.status).toBe(200);
    expect(res.body.archived_at).toBeTruthy();
    expect((await dosesOf(med.id)).map((d) => d.id)).toEqual([all[0]!.id]); // only the answered dose remains
    expect(await t.db.$count(scheduleVersions, and(eq(scheduleVersions.medicineId, med.id), isNull(scheduleVersions.effectiveUntil)))).toBe(0);
    expect((await t.call(me, 'post', `/v1/medicines/${med.id}/archive`)).status).toBe(200);
    expect(await t.db.$count(auditLog, and(eq(auditLog.patientId, p.id), eq(auditLog.action, 'medicine.archived')))).toBe(1);
    expect((await t.call(me, 'get', `/v1/patients/${p.id}/medicines`)).body.items).toHaveLength(0);
    const withArchived = await t.call(me, 'get', `/v1/patients/${p.id}/medicines?include_archived=true`);
    expect(withArchived.body.items).toHaveLength(1);
    expect(withArchived.body.items[0].schedule.times).toHaveLength(2);
  });
});

describe('what a patient or settings change does to doses', () => {
  it('a new timezone rebuilds future doses at the same wall-clock time', async () => {
    const { me, p, create } = await setup();
    const med = (await create({ schedule: schedule({ times: [{ local_time: '08:00', amount_text: 'a' }] }) })).body;
    const kolkata = (await dosesOf(med.id))[0]!;
    expect(kolkata.scheduledAt.toISOString().slice(11, 16)).toBe('02:30');
    await t.call(me, 'patch', `/v1/patients/${p.id}`, { timezone: 'UTC' });
    const utc = await dosesOf(med.id);
    expect(utc.every((d) => d.scheduledAt.toISOString().slice(11, 16) === '08:00')).toBe(true);
    expect(utc.length).toBeGreaterThanOrEqual(13);
  });

  it('a changed default delay reaches future pending doses only, and skips doses with their own delay (D-086)', async () => {
    const { me, p, create } = await setup();
    const plain = (await create({ name: 'Plain' })).body;
    const custom = (await create({ name: 'Custom', missed_delay_min: 45 })).body;
    const [answered, ...rest] = await dosesOf(plain.id);
    await t.db.update(doseInstances).set({ status: 'taken' }).where(eq(doseInstances.id, answered!.id));
    const [past] = await t.db.insert(doseInstances).values({ ...rest[0]!, id: undefined, scheduledAt: days(-1), alertDueAt: new Date(days(-1).getTime() + 30 * 60_000) }).returning();

    expect((await t.call(me, 'patch', '/v1/settings', { default_missed_delay_min: 60 })).body.default_missed_delay_min).toBe(60);
    const gap = (d: { alertDueAt: Date; scheduledAt: Date }) => (d.alertDueAt.getTime() - d.scheduledAt.getTime()) / 60_000;
    const plainAfter = await dosesOf(plain.id);
    expect(plainAfter.filter((d) => d.status === 'pending' && d.id !== past!.id && d.scheduledAt > new Date()).every((d) => gap(d) === 60)).toBe(true);
    expect(gap(plainAfter.find((d) => d.id === answered!.id)!)).toBe(30); // answered: frozen
    expect(gap(plainAfter.find((d) => d.id === past!.id)!)).toBe(30); // past: frozen
    expect((await dosesOf(custom.id)).every((d) => gap(d) === 45)).toBe(true);
    void p;
  });

  it('a patient delay change recomputes that patient’s future doses', async () => {
    const { me, p, create } = await setup();
    const med = (await create()).body;
    await t.call(me, 'patch', `/v1/patients/${p.id}`, { missed_delay_min: 15 });
    expect((await dosesOf(med.id)).every((d) => d.alertDueAt.getTime() - d.scheduledAt.getTime() === 15 * 60_000)).toBe(true);
    await t.call(me, 'patch', `/v1/patients/${p.id}`, { missed_delay_min: null });
    expect((await dosesOf(med.id)).every((d) => d.alertDueAt.getTime() - d.scheduledAt.getTime() === 30 * 60_000)).toBe(true);
  });

  it('archiving and reactivating a patient removes and restores future doses', async () => {
    const { me, p, create } = await setup();
    const med = (await create()).body;
    await t.call(me, 'post', `/v1/patients/${p.id}/archive`);
    expect(await dosesOf(med.id)).toHaveLength(0);
    await t.call(me, 'post', `/v1/patients/${p.id}/reactivate`);
    expect((await dosesOf(med.id)).length).toBeGreaterThanOrEqual(27);
  });
});

describe('settings', () => {
  it('reads defaults and validates updates', async () => {
    const me = await t.caregiver();
    expect((await t.call(me, 'get', '/v1/settings')).body).toEqual({ default_missed_delay_min: 30, lockscreen_detail: 'full', daily_summary: false });
    expect((await t.call(me, 'patch', '/v1/settings', { lockscreen_detail: 'generic' })).body.lockscreen_detail).toBe('generic');
    for (const body of [{}, { default_missed_delay_min: 0 }, { lockscreen_detail: 'none' }, { user_id: randomUUID() }]) expect((await t.call(me, 'patch', '/v1/settings', body)).status).toBe(400);
    const [row] = await t.db.select().from(caregiverSettings).where(eq(caregiverSettings.userId, me.id));
    expect(row!.lockscreenDetail).toBe('generic');
    expect((await t.call(me, 'get', '/v1/settings')).body.default_missed_delay_min).toBe(30);
  });

  it('is per caregiver', async () => {
    const a = await t.caregiver();
    const b = await t.caregiver();
    await t.call(a, 'patch', '/v1/settings', { default_missed_delay_min: 99 });
    expect((await t.call(b, 'get', '/v1/settings')).body.default_missed_delay_min).toBe(30);
  });
});

it('the stock endpoint is a 404 in v1', async () => {
  const { me, create } = await setup();
  const med = (await create()).body;
  expect((await t.call(me, 'patch', `/v1/medicines/${med.id}/stock`, { stock_count: 5, low_stock_at: 2 })).status).toBe(404);
});
