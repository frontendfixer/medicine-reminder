import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { auditLog, authSessions, caregiverSettings, consents, devices, doseInstances, idempotencyKeys, medicines, notificationLog, pairingCodes, patients, scheduleVersions, subscriptions, users } from '../db/schema.js';
import { MemoryObjectStorage } from '../storage/memory-object-storage.js';
import { ObjectStorage } from '../storage/object-storage.js';
import { startApp } from '../testing/harness.js';

let t: Awaited<ReturnType<typeof startApp>>;
let store: MemoryObjectStorage;
beforeAll(async () => {
  t = await startApp();
  store = t.app.get(ObjectStorage) as MemoryObjectStorage;
});
beforeEach(() => t.redis.flushdb());
afterAll(() => t.close());

const PASSWORD = 'correct horse battery';
const schedule = { pattern: 'daily', start_date: '2026-01-01', times: [{ local_time: '08:00', amount_text: '2 tablets' }] };
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from('JFIF\0'), Buffer.alloc(9), Buffer.from([0xff, 0xda, 0, 2]), Buffer.alloc(50)]);

async function life() {
  const me = await t.caregiver();
  const p = await t.patientOf(me, { display_name: 'Grandma Asha' });
  const key = (await t.call(me, 'post', '/v1/uploads/presign', { patient_id: p.id, content_type: 'image/jpeg', byte_size: 100 })).body.object_key as string;
  store.put(key, jpeg());
  const med = (await t.call(me, 'post', `/v1/patients/${p.id}/medicines`, { name: 'Metformin SECRET', notes: 'After food SECRETNOTE', photo_object_key: key, schedule })).body;
  const phone = await t.pair(me, p.id);
  const doses = await t.db.select().from(doseInstances).where(eq(doseInstances.patientId, p.id));
  await t.http().post('/v1/device/dose-responses').set('Authorization', `Device ${phone.token}`).send({ responses: [{ client_event_id: randomUUID(), dose_id: doses[0]!.id, action: 'not_taken', responded_at: new Date().toISOString() }] });
  return { me, p, med, key, phone, doses };
}
const remove = (who: Awaited<ReturnType<typeof t.caregiver>>, password = PASSWORD, confirm = 'DELETE') => t.call(who, 'post', '/v1/me/delete', { confirm, password });

describe('POST /v1/me/export', () => {
  it('gives the caller a private file with their own data, decrypted, and no credentials', async () => {
    const { me, p } = await life();
    const res = await t.call(me, 'post', '/v1/me/export');
    expect(res.status).toBe(202);
    const link = await t.call(me, 'get', `/v1/me/export/${res.body.request_id}`);
    expect(link.status).toBe(200);
    expect(link.body).toMatchObject({ request_id: res.body.request_id, status: 'ready' });
    expect(link.body.download_url).toContain(`exports/${me.id}/${res.body.request_id}.json`);
    expect(new Date(link.body.expires_at).getTime()).toBeGreaterThan(Date.now());

    const file = JSON.parse(store.objects.get(`exports/${me.id}/${res.body.request_id}.json`)!.body.toString('utf8'));
    expect(file.account).toMatchObject({ id: me.id, email: me.email });
    expect(file.patients).toHaveLength(1);
    expect(file.patients[0]).toMatchObject({ id: p.id, display_name: 'Grandma Asha' });
    expect(file.patients[0].medicines[0]).toMatchObject({ name: 'Metformin SECRET', notes: 'After food SECRETNOTE', has_photo: true });
    expect(file.patients[0].medicines[0].schedules[0].times).toEqual([{ local_time: '08:00', amount_text: '2 tablets' }]);
    expect(file.patients[0].doses.length).toBeGreaterThanOrEqual(13);
    expect(file.patients[0].devices).toHaveLength(1);
    expect(file.consents.length).toBeGreaterThanOrEqual(2);
    const text = JSON.stringify(file);
    for (const credential of ['password_hash', 'token_hash', 'refresh_hash', 'push_token', 'argon2']) expect(text).not.toContain(credential);
    expect((await t.db.select().from(auditLog).where(eq(auditLog.action, 'account.export_requested'))).length).toBeGreaterThanOrEqual(1);
  });

  it('never includes another caregiver’s data, and its link works only for its owner', async () => {
    const a = await life();
    const b = await life();
    const res = await t.call(a.me, 'post', '/v1/me/export');
    const file = store.objects.get(`exports/${a.me.id}/${res.body.request_id}.json`)!.body.toString('utf8');
    expect(file).not.toContain(b.p.id);
    expect(file).not.toContain(b.me.email);
    expect((await t.call(b.me, 'get', `/v1/me/export/${res.body.request_id}`)).status).toBe(404);
    expect((await t.call(a.me, 'get', `/v1/me/export/${randomUUID()}`)).status).toBe(404);
    expect((await t.call(a.me, 'get', '/v1/me/export/not-a-uuid')).status).toBe(404);
    expect((await t.http().post('/v1/me/export')).status).toBe(401);
  });

  it('is limited to 3 a day', async () => {
    const { me } = await life();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await t.call(me, 'post', '/v1/me/export')).status);
    expect(statuses).toEqual([202, 202, 202, 429]);
  });
});

describe('POST /v1/me/delete (D-081)', () => {
  it('needs the exact confirmation and the right password, and deletes nothing otherwise', async () => {
    const { me, p } = await life();
    expect((await remove(me, PASSWORD, 'delete')).status).toBe(400);
    expect((await t.call(me, 'post', '/v1/me/delete', { password: PASSWORD })).status).toBe(400);
    const wrong = await remove(me, 'not the password');
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    expect((await t.call(me, 'get', `/v1/patients/${p.id}`)).status).toBe(200);
    expect((await t.http().post('/v1/me/delete').send({ confirm: 'DELETE', password: PASSWORD })).status).toBe(401);
  });

  it('slows password guessing here just like sign-in', async () => {
    const { me } = await life();
    for (let i = 0; i < 5; i++) await remove(me, `guess ${i}`);
    expect((await remove(me, PASSWORD)).status).toBe(429);
  });

  it('erases the person, their patients, medicines, doses, phones and photos', async () => {
    const { me, p, med, key, phone, doses } = await life();
    const res = await remove(me);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'deleted' });

    expect(await t.db.$count(patients, eq(patients.ownerUserId, me.id))).toBe(0);
    expect(await t.db.$count(medicines, eq(medicines.id, med.id))).toBe(0);
    expect(await t.db.$count(scheduleVersions, eq(scheduleVersions.medicineId, med.id))).toBe(0);
    expect(await t.db.$count(doseInstances, inArray(doseInstances.id, doses.map((d) => d.id)))).toBe(0);
    expect(await t.db.$count(devices, eq(devices.userId, me.id))).toBe(0);
    expect(await t.db.$count(devices, eq(devices.id, phone.deviceId))).toBe(0);
    expect(await t.db.$count(pairingCodes, eq(pairingCodes.patientId, p.id))).toBe(0);
    expect(await t.db.$count(authSessions, eq(authSessions.userId, me.id))).toBe(0);
    expect(await t.db.$count(caregiverSettings, eq(caregiverSettings.userId, me.id))).toBe(0);
    expect(await t.db.$count(idempotencyKeys, eq(idempotencyKeys.principal, me.id))).toBe(0);
    await new Promise((r) => setTimeout(r, 50));
    expect(store.objects.has(key)).toBe(false);

    const [user] = await t.db.select().from(users).where(eq(users.id, me.id));
    expect(user).toMatchObject({ email: `deleted-${me.id}@deleted.invalid`, passwordHash: 'deleted' });
    expect(user!.deletedAt).toBeTruthy();
  });

  it('shuts every door: sessions, sign-in, the patient’s phone and the old email', async () => {
    const { me, phone } = await life();
    await remove(me);
    expect((await t.call(me, 'get', '/v1/patients')).status).toBe(401);
    expect((await t.http().post('/v1/auth/login').send({ email: me.email, password: PASSWORD, device: { platform: 'android', app_version: '1' } })).body.error.code).toBe('INVALID_CREDENTIALS');
    expect((await t.asDevice(phone.token, 'get', '/v1/device/sync')).body.error.code).toBe('DEVICE_TOKEN_REJECTED');
    const again = await t.http().post('/v1/auth/register').send({ email: me.email, password: PASSWORD, device: { platform: 'android', app_version: '1' }, consent: { notice_version: '1' } });
    expect(again.status).toBe(201); // the address is free again, with a brand-new empty account
    expect(again.body.user.id).not.toBe(me.id);
  });

  it('keeps audit and notification logs without links to people, phones or doses (Rule 8(3), C-10)', async () => {
    const { me, p } = await life();
    const logsBefore = await t.db.select().from(notificationLog).where(eq(notificationLog.patientId, p.id));
    const auditBefore = await t.db.select().from(auditLog).where(eq(auditLog.patientId, p.id));
    expect(logsBefore.length).toBeGreaterThan(0);
    await remove(me);

    const logsAfter = await t.db.select().from(notificationLog).where(inArray(notificationLog.id, logsBefore.map((l) => l.id)));
    expect(logsAfter).toHaveLength(logsBefore.length);
    for (const l of logsAfter) expect(l).toMatchObject({ patientId: null, deviceId: null, doseInstanceId: null, data: null });
    expect(logsAfter.map((l) => l.kind).sort((a, b) => (a < b ? -1 : 1))).toEqual(logsBefore.map((l) => l.kind).sort((a, b) => (a < b ? -1 : 1)));
    const auditAfter = await t.db.select().from(auditLog).where(eq(auditLog.patientId, p.id));
    expect(auditAfter.length).toBeGreaterThanOrEqual(auditBefore.length);
    expect((await t.db.select().from(auditLog).where(eq(auditLog.actorId, me.id))).map((a) => a.action)).toContain('account.deletion_requested');
    expect(JSON.stringify(auditAfter)).not.toMatch(/Asha|Metformin|SECRET/);
    expect(await t.db.$count(consents, eq(consents.userId, me.id))).toBeGreaterThanOrEqual(1); // proof of consent stays
    expect(await t.db.$count(subscriptions, eq(subscriptions.userId, me.id))).toBe(1); // billing record stays
  });

  it('leaves everyone else’s data exactly as it was', async () => {
    const gone = await life();
    const stays = await life();
    await remove(gone.me);
    expect((await t.call(stays.me, 'get', `/v1/patients/${stays.p.id}`)).body.display_name).toBe('Grandma Asha');
    expect((await t.call(stays.me, 'get', `/v1/patients/${stays.p.id}/medicines`)).body.items[0].name).toBe('Metformin SECRET');
    expect((await t.asDevice(stays.phone.token, 'get', '/v1/device/sync')).status).toBe(200);
    expect(store.objects.has(stays.key)).toBe(true);
    expect(await t.db.$count(notificationLog, eq(notificationLog.patientId, stays.p.id))).toBeGreaterThan(0);
  });

  it('works for an account with nothing but a login', async () => {
    const bare = await t.caregiver();
    expect((await remove(bare)).status).toBe(202);
  });
});
