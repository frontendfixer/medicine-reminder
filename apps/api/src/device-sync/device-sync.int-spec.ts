import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { auditLog, devices, doseInstances, medicines, notificationLog, patients, subscriptions } from '../db/schema.js';
import { startApp } from '../testing/harness.js';

let t: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  t = await startApp();
});
beforeEach(() => t.redis.flushdb());
afterAll(() => t.close());

const minutes = (n: number) => new Date(Date.now() + n * 60_000);
const schedule = { pattern: 'daily', start_date: '2026-01-01', times: [{ local_time: '08:00', amount_text: '1 tablet' }, { local_time: '21:00', amount_text: '2 tablets' }] };

async function setup(type: 'managed' | 'self' = 'managed') {
  const me = await t.caregiver();
  const p = await t.patientOf(me, { type });
  const med = (await t.call(me, 'post', `/v1/patients/${p.id}/medicines`, { name: 'Metformin 500', notes: 'After food', notification_type: 'alarm', schedule })).body;
  const phone = await t.pair(me, p.id);
  const doses = await t.db.select().from(doseInstances).where(eq(doseInstances.patientId, p.id)).orderBy(asc(doseInstances.scheduledAt));
  const answer = (token: string, ...rs: object[]) => t.asDevice(token, 'post', '/v1/device/dose-responses').send({ responses: rs });
  const event = (dose: { id: string }, action: string, respondedAt = new Date(), over: object = {}) => ({ client_event_id: randomUUID(), dose_id: dose.id, action, responded_at: respondedAt.toISOString(), ...over });
  const dose = async (id: string) => (await t.db.select().from(doseInstances).where(eq(doseInstances.id, id)))[0]!;
  const queued = (kind: string, doseId: string) => t.db.select().from(notificationLog).where(and(eq(notificationLog.kind, kind as 'correction'), eq(notificationLog.doseInstanceId, doseId)));
  // Put one dose in a known time position so the rules can be exercised without waiting.
  const place = (id: string, scheduledMinutes: number, delayMin = 30, status: 'pending' | 'missed' | 'taken' | 'not_taken' | 'snoozed' = 'pending') =>
    t.db.update(doseInstances).set({ scheduledAt: minutes(scheduledMinutes), alertDueAt: minutes(scheduledMinutes + delayMin), status, alertSentAt: status === 'missed' ? new Date() : null }).where(eq(doseInstances.id, id));
  return { me, p, med, phone, doses, answer, event, dose, queued, place };
}

describe('GET /v1/device/sync', () => {
  it('needs a device token', async () => {
    const { me } = await setup();
    expect((await t.http().get('/v1/device/sync')).status).toBe(401);
    expect((await t.http().get('/v1/device/sync').set('Authorization', `Bearer ${me.token}`)).status).toBe(401);
    expect((await t.asDevice('nope', 'get', '/v1/device/sync')).body.error.code).toBe('DEVICE_TOKEN_REJECTED');
  });

  it('issues the patient, medicines and a 5-day Android window of decrypted doses', async () => {
    const { p, med, phone, doses } = await setup();
    const res = await t.asDevice(phone.token, 'get', '/v1/device/sync');
    expect(res.status).toBe(200);
    expect(res.body.patient).toMatchObject({ id: p.id, display_name: 'Grandma Asha', timezone: 'Asia/Kolkata', status: 'active', lockscreen_detail: 'full' });
    expect(res.body.account_state).toBe('active');
    expect(res.body.commands).toEqual([]);
    expect(res.body.medicines).toEqual([{ id: med.id, name: 'Metformin 500', notes: 'After food', notification_type: 'alarm', photo: null }]);
    const days = (new Date(res.body.window.through).getTime() - new Date(res.body.window.from).getTime()) / 86_400_000;
    expect(days).toBeCloseTo(5, 1);
    expect(res.body.doses.length).toBeGreaterThanOrEqual(9);
    expect(res.body.doses.length).toBeLessThanOrEqual(11);
    expect(res.body.doses[0]).toMatchObject({ medicine_id: med.id, name: 'Metformin 500', amount: expect.any(String), status: 'pending', notification_type: 'alarm', snooze_until: null });
    expect(res.body.doses.map((d: { id: string }) => d.id)).toEqual(expect.arrayContaining([doses[0]!.id]));
    expect(res.body.doses.every((d: { scheduled_at: string }) => new Date(d.scheduled_at) <= new Date(res.body.window.through))).toBe(true);
    expect(typeof res.body.cursor).toBe('string');
    expect((await t.db.select().from(devices).where(eq(devices.id, phone.deviceId)))[0]!.lastSeenAt).toBeTruthy();
  });

  it('only ever shows the device’s own patient', async () => {
    const a = await setup();
    const b = await setup();
    const res = await t.asDevice(a.phone.token, 'get', '/v1/device/sync');
    const ids = new Set(res.body.doses.map((d: { id: string }) => d.id));
    for (const d of b.doses) expect(ids.has(d.id)).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain(b.p.id);
  });

  it('keeps recent answered doses for the Today screen, drops archived medicines and old doses', async () => {
    const { me, med, phone, doses, place } = await setup();
    await place(doses[0]!.id, -120, 30, 'taken');
    await t.db.update(doseInstances).set({ scheduledAt: minutes(-60 * 30) }).where(eq(doseInstances.id, doses[1]!.id)); // 30 h ago
    const res = await t.asDevice(phone.token, 'get', '/v1/device/sync');
    const byId = new Map(res.body.doses.map((d: { id: string; status: string }) => [d.id, d.status]));
    expect(byId.get(doses[0]!.id)).toBe('taken');
    expect(byId.has(doses[1]!.id)).toBe(false);
    await t.call(me, 'post', `/v1/medicines/${med.id}/archive`);
    const after = await t.asDevice(phone.token, 'get', '/v1/device/sync');
    expect(after.body.medicines).toEqual([]);
    expect(after.body.doses.filter((d: { status: string }) => d.status === 'pending')).toEqual([]);
  });

  it('resolves lock-screen detail: patient override, then the caregiver setting', async () => {
    const { me, p, phone } = await setup();
    await t.call(me, 'patch', '/v1/settings', { lockscreen_detail: 'generic' });
    expect((await t.asDevice(phone.token, 'get', '/v1/device/sync')).body.patient.lockscreen_detail).toBe('generic');
    await t.call(me, 'patch', `/v1/patients/${p.id}`, { lockscreen_detail: 'full' });
    expect((await t.asDevice(phone.token, 'get', '/v1/device/sync')).body.patient.lockscreen_detail).toBe('full');
  });

  it('sizes the iOS window from the notification budget (D-038, D-078)', async () => {
    const { me, p } = await setup();
    const ios = await t.pair(me, p.id, { platform: 'ios' });
    // 2 alarm times at a 30 min delay = 12 slots a day: 60 / 12 = 5 days (docs/05 example).
    const days = (b: { window: { from: string; through: string } }) => (new Date(b.window.through).getTime() - new Date(b.window.from).getTime()) / 86_400_000;
    expect(days((await t.asDevice(ios.token, 'get', '/v1/device/sync')).body)).toBeCloseTo(5, 1);
    for (let i = 0; i < 2; i++) await t.call(me, 'post', `/v1/patients/${p.id}/medicines`, { name: `Alarm ${i}`, notification_type: 'alarm', schedule });
    expect(days((await t.asDevice(ios.token, 'get', '/v1/device/sync')).body)).toBeCloseTo(2, 1); // 36 slots a day: does not fit, so the floor of 2 days
  });

  it('a suspended patient gets cancel_all and nothing else (07)', async () => {
    const { p, phone } = await setup();
    await t.db.update(patients).set({ status: 'suspended' }).where(eq(patients.id, p.id));
    const res = await t.asDevice(phone.token, 'get', '/v1/device/sync');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ account_state: 'suspended', commands: ['cancel_all'], medicines: [], doses: [] });
  });

  it('during grace the window ends at cutoff (D-087)', async () => {
    const { me, phone } = await setup();
    const cutoff = minutes(60 * 6);
    await t.db.update(subscriptions).set({ status: 'grace', expiredAt: new Date(), cutoffAt: cutoff }).where(eq(subscriptions.userId, me.id));
    const res = await t.asDevice(phone.token, 'get', '/v1/device/sync');
    expect(res.body.account_state).toBe('grace');
    expect(new Date(res.body.window.through).getTime()).toBe(cutoff.getTime());
    expect(res.body.doses.every((d: { scheduled_at: string }) => new Date(d.scheduled_at) <= cutoff)).toBe(true);
  });

  it('a revoked device is refused', async () => {
    const { me, phone } = await setup();
    await t.call(me, 'post', `/v1/devices/${phone.deviceId}/revoke`);
    expect((await t.asDevice(phone.token, 'get', '/v1/device/sync')).body.error.code).toBe('DEVICE_TOKEN_REJECTED');
  });
});

describe('POST /v1/device/dose-responses', () => {
  it('records Taken, clears the dose on the other phones, and sends the caregiver nothing', async () => {
    const { me, p, phone, doses, answer, event, dose, queued } = await setup();
    const second = await t.pair(me, p.id);
    const res = await answer(phone.token, event(doses[0]!, 'taken'));
    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({ outcome: 'applied', dose: { id: doses[0]!.id, status: 'taken' } });
    const row = await dose(doses[0]!.id);
    expect(row).toMatchObject({ status: 'taken' });
    expect(row.receivedAt).toBeTruthy();
    const pushes = await queued('sync', doses[0]!.id);
    expect(pushes.map((n) => n.deviceId)).toEqual([second.deviceId]); // the other phone, not the one that answered
    expect(await queued('not_taken', doses[0]!.id)).toHaveLength(0);
    expect(await queued('correction', doses[0]!.id)).toHaveLength(0);
    expect(await t.db.$count(notificationLog, and(eq(notificationLog.deviceId, phone.deviceId), eq(notificationLog.kind, 'sync')))).toBe(0);
    void me;
  });

  it('needs no Idempotency-Key and is accepted from an old app version', async () => {
    const { phone, doses, answer, event } = await setup();
    const was = process.env.APP_MIN_VERSION_ANDROID;
    process.env.APP_MIN_VERSION_ANDROID = '9.0.0';
    try {
      const res = await t.asDevice(phone.token, 'post', '/v1/device/dose-responses').set({ 'X-App-Version': '1.0.0', 'X-Platform': 'android' }).send({ responses: [event(doses[0]!, 'taken')] });
      expect(res.status).toBe(200);
      expect(res.body.results[0].outcome).toBe('applied');
      void answer;
    } finally {
      process.env.APP_MIN_VERSION_ANDROID = was;
    }
  });

  it('treats a resent event as a duplicate and does not apply it twice', async () => {
    const { phone, doses, answer, event, p, me } = await setup();
    await t.pair(me, p.id);
    const e = event(doses[0]!, 'taken');
    await answer(phone.token, e);
    const again = await answer(phone.token, e);
    expect(again.body.results[0].outcome).toBe('duplicate');
    expect(await t.db.$count(notificationLog, and(eq(notificationLog.kind, 'sync'), eq(notificationLog.doseInstanceId, doses[0]!.id)))).toBe(1);
  });

  it('Not taken alerts the caregiver at once and stops the missed alert', async () => {
    const { phone, doses, answer, event, dose, queued, me } = await setup();
    await answer(phone.token, event(doses[0]!, 'not_taken'));
    const row = await dose(doses[0]!.id);
    expect(row.status).toBe('not_taken');
    expect(row.alertSentAt).toBeTruthy(); // the sweeper will not also send "no answer recorded"
    const alerts = await queued('not_taken', doses[0]!.id);
    expect(alerts).toHaveLength(1);
    const caregiverDevice = (await t.db.select().from(devices).where(eq(devices.userId, me.id)))[0]!;
    expect(alerts[0]).toMatchObject({ deviceId: caregiverDevice.id, kind: 'not_taken', status: 'queued' });
  });

  it('a self profile gets no pushes to itself', async () => {
    const { phone, doses, answer, event, queued } = await setup('self');
    await answer(phone.token, event(doses[0]!, 'not_taken'));
    expect(await queued('not_taken', doses[0]!.id)).toHaveLength(0);
  });

  it('the earliest answer wins; a later one is superseded; an earlier one replaces (D-085)', async () => {
    const { phone, doses, answer, event, dose, place } = await setup();
    await place(doses[0]!.id, -30);
    const base = Date.now() - 10 * 60_000;
    const first = await answer(phone.token, event(doses[0]!, 'taken', new Date(base)));
    expect(first.body.results[0].outcome).toBe('applied');
    const later = await answer(phone.token, event(doses[0]!, 'not_taken', new Date(base + 60_000)));
    expect(later.body.results[0].outcome).toBe('superseded');
    expect((await dose(doses[0]!.id)).status).toBe('taken');
    const earlier = await answer(phone.token, event(doses[0]!, 'not_taken', new Date(base - 120_000)));
    expect(earlier.body.results[0].outcome).toBe('applied');
    expect((await dose(doses[0]!.id)).status).toBe('not_taken');
    const tie = await answer(phone.token, event(doses[0]!, 'taken', new Date(base - 120_000)));
    expect(tie.body.results[0].outcome).toBe('superseded'); // same time: first to arrive keeps it
  });

  it('clamps a wild responded_at into [scheduled − 1 h, received]', async () => {
    const { phone, doses, answer, event, dose, place } = await setup();
    await place(doses[0]!.id, -30);
    await answer(phone.token, event(doses[0]!, 'taken', new Date(Date.now() + 3_600_000)));
    const future = await dose(doses[0]!.id);
    expect(future.respondedAt!.getTime()).toBeLessThanOrEqual(future.receivedAt!.getTime());
    await place(doses[1]!.id, -30);
    await answer(phone.token, event(doses[1]!, 'taken', new Date(0)));
    const old = await dose(doses[1]!.id);
    expect(old.respondedAt!.getTime()).toBe(old.scheduledAt.getTime() - 3_600_000);
  });

  it('a late answer to a missed dose flips it and sends exactly one correction', async () => {
    const { phone, doses, answer, event, dose, queued, place } = await setup();
    await place(doses[0]!.id, -60, 30, 'missed');
    const res = await answer(phone.token, event(doses[0]!, 'taken', new Date(Date.now() - 5 * 60_000)));
    expect(res.body.results[0].outcome).toBe('applied');
    expect((await dose(doses[0]!.id)).status).toBe('taken');
    expect(await queued('correction', doses[0]!.id)).toHaveLength(1);
    expect(await queued('not_taken', doses[0]!.id)).toHaveLength(0);
    await answer(phone.token, event(doses[0]!, 'not_taken', new Date(Date.now() - 20 * 60_000))); // an earlier answer replaces it
    expect(await queued('correction', doses[0]!.id)).toHaveLength(1); // still just one
  });

  it('Snooze sets snooze_until 10 minutes on and never moves alert_due_at (D-030)', async () => {
    const { phone, doses, answer, event, dose, place } = await setup();
    await place(doses[0]!.id, -5, 30);
    const before = await dose(doses[0]!.id);
    const at = new Date();
    const res = await answer(phone.token, event(doses[0]!, 'snooze', at));
    expect(res.body.results[0].outcome).toBe('applied');
    const row = await dose(doses[0]!.id);
    expect(row.status).toBe('snoozed');
    expect(row.snoozeUntil!.getTime() - at.getTime()).toBeGreaterThan(9.9 * 60_000);
    expect(row.snoozeUntil!.getTime() - at.getTime()).toBeLessThan(10.1 * 60_000);
    expect(row.alertDueAt.getTime()).toBe(before.alertDueAt.getTime());
    expect((await answer(phone.token, event(doses[0]!, 'snooze', at))).body.results[0].outcome).toBe('applied'); // snoozing again is allowed
  });

  it('refuses Snooze when 10 minutes would pass the deadline, or after an answer (D-085)', async () => {
    const { phone, doses, answer, event, dose, place } = await setup();
    await place(doses[0]!.id, -25, 30); // 5 minutes to the deadline
    expect((await answer(phone.token, event(doses[0]!, 'snooze'))).body.results[0].outcome).toBe('rejected');
    expect((await dose(doses[0]!.id)).status).toBe('pending');
    await answer(phone.token, event(doses[1]!, 'taken'));
    expect((await answer(phone.token, event(doses[1]!, 'snooze'))).body.results[0].outcome).toBe('rejected');
  });

  it('rejects another patient’s dose and changes nothing', async () => {
    const a = await setup();
    const b = await setup();
    const res = await a.answer(a.phone.token, a.event(b.doses[0]!, 'taken'));
    expect(res.body.results[0]).toMatchObject({ outcome: 'rejected', dose: null });
    expect((await b.dose(b.doses[0]!.id)).status).toBe('pending');
    expect((await a.answer(a.phone.token, a.event({ id: randomUUID() }, 'taken'))).body.results[0].outcome).toBe('rejected');
  });

  it('rejects answers for a suspended patient', async () => {
    const { p, phone, doses, answer, event, dose } = await setup();
    await t.db.update(patients).set({ status: 'suspended' }).where(eq(patients.id, p.id));
    expect((await answer(phone.token, event(doses[0]!, 'taken'))).body.results[0].outcome).toBe('rejected');
    expect((await dose(doses[0]!.id)).status).toBe('pending');
  });

  it('handles a mixed batch item by item, and validates the whole request', async () => {
    const { phone, doses, answer, event } = await setup();
    const res = await answer(phone.token, event(doses[0]!, 'taken'), event(doses[1]!, 'snooze'), event({ id: randomUUID() }, 'taken'));
    expect(res.body.results.map((r: { outcome: string }) => r.outcome)).toEqual(['applied', 'applied', 'rejected']);
    expect((await answer(phone.token)).status).toBe(400);
    expect((await answer(phone.token, ...Array.from({ length: 101 }, () => event(doses[2]!, 'taken')))).status).toBe(400);
    expect((await answer(phone.token, { ...event(doses[2]!, 'taken'), action: 'maybe' })).status).toBe(400);
    expect((await answer(phone.token, { ...event(doses[2]!, 'taken'), client_event_id: 'x' })).status).toBe(400);
  });

  it('two phones answering the same dose at once end with the earliest answer', async () => {
    const { me, p, phone, doses, answer, event, dose, place } = await setup();
    const second = await t.pair(me, p.id);
    await place(doses[0]!.id, -30);
    const base = Date.now() - 10 * 60_000;
    const results = await Promise.all([answer(phone.token, event(doses[0]!, 'taken', new Date(base))), answer(second.token, event(doses[0]!, 'not_taken', new Date(base - 60_000)))]);
    const outcomes = results.map((r) => r.body.results[0].outcome).sort((a: string, b: string) => (a < b ? -1 : 1));
    expect(outcomes.every((o: string) => o === 'applied' || o === 'superseded')).toBe(true);
    expect((await dose(doses[0]!.id)).status).toBe('not_taken'); // the earlier answer, whatever the arrival order
  });
});

describe('history', () => {
  async function withHistory() {
    const s = await setup();
    // Spread the generated doses over the last week with a mix of outcomes.
    const all = s.doses;
    const statuses = ['taken', 'taken', 'missed', 'not_taken', 'taken', 'missed', 'pending', 'snoozed'] as const;
    for (const [i, d] of all.slice(0, statuses.length).entries()) {
      await t.db.update(doseInstances).set({ scheduledAt: minutes(-(i + 1) * 12 * 60), alertDueAt: minutes(-(i + 1) * 12 * 60 + 30), status: statuses[i]! }).where(eq(doseInstances.id, d.id));
    }
    return s;
  }
  const list = (who: Awaited<ReturnType<typeof t.caregiver>>, pid: string, q = '') => t.call(who, 'get', `/v1/patients/${pid}/doses${q}`);

  it('lists newest first with decrypted names, and pages without gaps or repeats', async () => {
    const { me, p, med } = await withHistory();
    const all = await list(me, p.id, '?limit=100&from=2020-01-01T00:00:00Z&to=2030-01-01T00:00:00Z');
    expect(all.body.items[0]).toMatchObject({ medicine_id: med.id, medicine_name: 'Metformin 500', amount: expect.any(String) });
    const times = all.body.items.map((d: { scheduled_at: string }) => d.scheduled_at);
    expect(times).toEqual([...times].sort((a: string, b: string) => (a < b ? 1 : -1)));

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await list(me, p.id, `?limit=3&from=2020-01-01T00:00:00Z&to=2030-01-01T00:00:00Z${cursor ? `&cursor=${cursor}` : ''}`);
      expect(page.body.items.length).toBeLessThanOrEqual(3);
      seen.push(...page.body.items.map((d: { id: string }) => d.id));
      cursor = page.body.next_cursor;
    } while (cursor);
    expect(seen).toEqual(all.body.items.map((d: { id: string }) => d.id));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('filters by status, medicine and time, and validates its inputs', async () => {
    const { me, p, med } = await withHistory();
    const missed = await list(me, p.id, '?status=missed&from=2020-01-01T00:00:00Z');
    expect(missed.body.items).toHaveLength(2);
    expect(missed.body.items.every((d: { status: string }) => d.status === 'missed')).toBe(true);
    expect((await list(me, p.id, `?medicine_id=${med.id}&status=taken&from=2020-01-01T00:00:00Z`)).body.items).toHaveLength(3);
    expect((await list(me, p.id, `?medicine_id=${randomUUID()}&from=2020-01-01T00:00:00Z`)).body.items).toHaveLength(0);
    for (const q of ['?status=lost', '?limit=0', '?limit=101', '?cursor=garbage', '?from=yesterday', '?medicine_id=x']) expect((await list(me, p.id, q)).status).toBe(400);
  });

  it('is owner-only, and still readable once the patient is suspended', async () => {
    const { me, p } = await withHistory();
    const stranger = await t.caregiver();
    for (const path of ['doses', 'adherence', 'audit-log']) expect((await t.call(stranger, 'get', `/v1/patients/${p.id}/${path}`)).status).toBe(404);
    await t.db.update(patients).set({ status: 'suspended' }).where(eq(patients.id, p.id));
    expect((await list(me, p.id, '?from=2020-01-01T00:00:00Z')).status).toBe(200);
    expect((await t.call(me, 'get', `/v1/patients/${p.id}/adherence`)).status).toBe(200);
  });

  it('counts adherence per medicine and per local day, snoozed as pending', async () => {
    const { me, p, med } = await withHistory();
    const q = '?from=2020-01-01T00:00:00Z&to=2030-01-01T00:00:00Z';
    const byMed = await t.call(me, 'get', `/v1/patients/${p.id}/adherence${q}&group_by=medicine`);
    const row = byMed.body.buckets.find((b: { key: string }) => b.key === med.id);
    expect(row).toMatchObject({ taken: 3, not_taken: 1, missed: 2 });
    expect(row.pending).toBeGreaterThanOrEqual(2); // the pending + snoozed seeds, plus the not-yet-due doses
    const byDay = await t.call(me, 'get', `/v1/patients/${p.id}/adherence${q}`);
    expect(byDay.body.buckets.every((b: { key: string }) => /^\d{4}-\d{2}-\d{2}$/.test(b.key))).toBe(true);
    const keys = byDay.body.buckets.map((b: { key: string }) => b.key);
    expect(keys).toEqual([...keys].sort((a: string, b: string) => (a < b ? -1 : 1)));
    const total = byDay.body.buckets.reduce((n: number, b: { taken: number; not_taken: number; missed: number; pending: number }) => n + b.taken + b.not_taken + b.missed + b.pending, 0);
    expect(total).toBe(await t.db.$count(doseInstances, eq(doseInstances.patientId, p.id)));
    expect((await t.call(me, 'get', `/v1/patients/${p.id}/adherence?group_by=week`)).status).toBe(400);
    expect((await t.call(me, 'get', `/v1/patients/${p.id}/adherence?from=2030-01-01T00:00:00Z&to=2020-01-01T00:00:00Z`)).status).toBe(400);
  });

  it('shows the audit log newest first, paged, to the owner only', async () => {
    const { me, p } = await setup();
    await t.call(me, 'patch', `/v1/patients/${p.id}`, { missed_delay_min: 20 });
    const log = await t.call(me, 'get', `/v1/patients/${p.id}/audit-log?limit=2`);
    expect(log.status).toBe(200);
    expect(log.body.items).toHaveLength(2);
    expect(log.body.next_cursor).toBeTruthy();
    const rest = await t.call(me, 'get', `/v1/patients/${p.id}/audit-log?limit=100&cursor=${log.body.next_cursor}`);
    const ids = [...log.body.items, ...rest.body.items].map((a: { id: string }) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(await t.db.$count(auditLog, eq(auditLog.patientId, p.id)));
    expect(JSON.stringify(log.body)).not.toMatch(/Metformin|Asha/);
    expect((await t.call(me, 'get', `/v1/patients/${p.id}/audit-log?cursor=bad`)).status).toBe(400);
  });
});

it('keeps medicines table untouched by sync (sanity)', async () => {
  const { med, phone } = await setup();
  await t.asDevice(phone.token, 'get', '/v1/device/sync');
  expect((await t.db.select().from(medicines).where(eq(medicines.id, med.id))).length).toBe(1);
});
