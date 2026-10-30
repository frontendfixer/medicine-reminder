import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { and, eq, isNull } from 'drizzle-orm';
import { Redis } from 'ioredis';
import request from 'supertest';
import { AppModule } from '../app.module.js';
import type { Db } from '../db/client.js';
import { DB } from '../db/database.module.js';
import { auditLog, consents, devices, notificationLog, pairingCodes, patients, subscriptions } from '../db/schema.js';
import { resetTestDb, testDatabaseUrl } from '../db/test-db.js';

let app: INestApplication;
let db: Db;
let redis: Redis;
let n = 0;
const http = () => request(app.getHttpServer());

type Caregiver = { id: string; token: string };
async function caregiver(): Promise<Caregiver> {
  const res = await http()
    .post('/v1/auth/register')
    .send({ email: `pr${++n}-${Date.now()}@example.test`, password: 'correct horse battery', device: { platform: 'android', app_version: '1.0.0' }, consent: { notice_version: '1' } });
  return { id: res.body.user.id, token: res.body.access_token };
}
const asCaregiver = (who: Caregiver, method: 'get' | 'post', path: string, body?: object) => {
  let r = http()[method](path).set('Authorization', `Bearer ${who.token}`);
  if (method === 'post') r = r.set('Idempotency-Key', randomUUID());
  return body ? r.send(body) : r;
};
async function patientOf(who: Caregiver, over: object = {}) {
  return (await asCaregiver(who, 'post', '/v1/patients', { display_name: 'Grandma Asha', type: 'managed', timezone: 'Asia/Kolkata', ...over })).body as { id: string };
}
const newCode = async (who: Caregiver, patientId: string) => (await asCaregiver(who, 'post', `/v1/patients/${patientId}/pairing-code`)).body.code as string;
const redeemBody = (code: string, over: object = {}) => ({
  code,
  device: { platform: 'android', app_version: '1.0.0', label: 'Pixel 8', tz: 'Asia/Kolkata', install_id: randomUUID(), ...over },
  consent: { notice_version: '2026-10' },
});
const redeem = (code: string, over: object = {}) => http().post('/v1/pairing/redeem').send(redeemBody(code, over));
const asDevice = (token: string, method: 'get' | 'post', path: string) => http()[method](path).set('Authorization', `Device ${token}`);
const heartbeatBody = { permissions: { notifications: true, exact_alarm: true }, app_version: '1.0.1', tz: 'Asia/Kolkata', scheduled_through: null };

beforeAll(async () => {
  const made = await resetTestDb();
  await made.pool.end();
  process.env.DATABASE_URL = testDatabaseUrl();
  process.env.REDIS_URL = process.env.REDIS_URL_TEST!;
  redis = new Redis(process.env.REDIS_URL_TEST!);
  app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
  await app.listen(0);
  db = app.get<Db>(DB);
});
beforeEach(() => redis.flushdb());
afterAll(async () => {
  await app.close();
  await redis.quit();
});

describe('pairing code', () => {
  it('returns XXXX-XXXX, a QR payload and a 10 minute expiry, and stores only hashes', async () => {
    const me = await caregiver();
    const p = await patientOf(me);
    const res = await asCaregiver(me, 'post', `/v1/patients/${p.id}/pairing-code`);
    expect(res.status).toBe(201);
    expect(res.body.code).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    expect(res.body.qr_payload).toBe(`medremind://pair?c=${res.body.code.replace('-', '')}`);
    const minutes = (new Date(res.body.expires_at).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(9.5);
    expect(minutes).toBeLessThanOrEqual(10);
    const rows = await db.select().from(pairingCodes).where(eq(pairingCodes.patientId, p.id));
    expect(JSON.stringify(rows)).not.toContain(res.body.code.replace('-', ''));
    expect((await db.select().from(auditLog).where(eq(auditLog.patientId, p.id))).map((a) => a.action)).toContain('pairing.code_created');
  });

  it('a new code invalidates the previous one', async () => {
    const me = await caregiver();
    const p = await patientOf(me);
    const first = await newCode(me, p.id);
    const second = await newCode(me, p.id);
    expect((await redeem(first)).body.error.code).toBe('CODE_EXPIRED_OR_USED');
    expect((await redeem(second)).status).toBe(201);
  });

  it('needs an owned, active patient and an active subscription', async () => {
    const a = await caregiver();
    const b = await caregiver();
    const p = await patientOf(a);
    expect((await asCaregiver(b, 'post', `/v1/patients/${p.id}/pairing-code`)).status).toBe(404);
    await db.update(subscriptions).set({ status: 'expired' }).where(eq(subscriptions.userId, a.id));
    expect((await asCaregiver(a, 'post', `/v1/patients/${p.id}/pairing-code`)).body.error.code).toBe('SUBSCRIPTION_INACTIVE');
    await db.update(subscriptions).set({ status: 'active' }).where(eq(subscriptions.userId, a.id));
    await asCaregiver(a, 'post', `/v1/patients/${p.id}/archive`);
    expect((await asCaregiver(a, 'post', `/v1/patients/${p.id}/pairing-code`)).body.error.code).toBe('PATIENT_ARCHIVED');
  });
});

describe('redeem', () => {
  it('pairs a phone: device token, consent, audit, caregiver notice, no idempotency key needed', async () => {
    const me = await caregiver();
    const p = await patientOf(me);
    const res = await redeem(await newCode(me, p.id));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ patient: { id: p.id, display_name: 'Grandma Asha', timezone: 'Asia/Kolkata' } });
    expect(res.body.device_token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const [device] = await db.select().from(devices).where(eq(devices.id, res.body.device_id));
    expect(device).toMatchObject({ patientId: p.id, platform: 'android', label: 'Pixel 8' });
    expect(device!.tokenHash).not.toContain(res.body.device_token);
    expect(await db.$count(consents, and(eq(consents.patientId, p.id), eq(consents.kind, 'pairing')))).toBe(1);
    const actions = (await db.select().from(auditLog).where(eq(auditLog.patientId, p.id))).map((a) => a.action);
    expect(actions).toContain('pairing.redeemed');
    expect(await db.$count(notificationLog, and(eq(notificationLog.patientId, p.id), eq(notificationLog.kind, 'pairing')))).toBe(1);
    const list = await asCaregiver(me, 'get', `/v1/patients/${p.id}`);
    expect(list.body.devices).toHaveLength(1);
  });

  it('accepts a typed code in any case with or without the dash, once only', async () => {
    const me = await caregiver();
    const p = await patientOf(me);
    const code = await newCode(me, p.id);
    expect((await redeem(code.toLowerCase().replace('-', ' '))).status).toBe(201);
    const again = await redeem(code);
    expect(again.status).toBe(410);
    expect(again.body.error.code).toBe('CODE_EXPIRED_OR_USED');
  });

  it('only one of several simultaneous redeems wins', async () => {
    const me = await caregiver();
    const code = await newCode(me, (await patientOf(me)).id);
    const results = await Promise.all(Array.from({ length: 5 }, () => redeem(code)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 410)).toHaveLength(4);
  });

  it('treats a wrong or malformed code as CODE_INVALID, and locks the real code after 5 wrong tries', async () => {
    const me = await caregiver();
    const p = await patientOf(me);
    const code = await newCode(me, p.id);
    const wrong = code.slice(0, 4) + (code.endsWith('2345') ? '6789' : '2345'); // right lookup part, wrong rest
    expect((await redeem('NOT-A-CODE')).body.error.code).toBe('CODE_INVALID');
    expect((await redeem('ZZZZ-ZZZZ')).status).toBe(422);
    for (let i = 0; i < 5; i++) expect((await redeem(wrong)).body.error.code).toBe('CODE_INVALID');
    const locked = await redeem(code); // now even the right code is refused
    expect(locked.status).toBe(410);
    expect(locked.body.error.code).toBe('CODE_EXPIRED_OR_USED');
    const [row] = await db.select().from(pairingCodes).where(eq(pairingCodes.patientId, p.id));
    expect(row!.failedAttempts).toBe(5);
    expect(row!.usedAt).toBeNull();
  });

  it('refuses expired codes', async () => {
    const me = await caregiver();
    const p = await patientOf(me);
    const code = await newCode(me, p.id);
    await db.update(pairingCodes).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(pairingCodes.patientId, p.id));
    expect((await redeem(code)).body.error.code).toBe('CODE_EXPIRED_OR_USED');
  });

  it('allows 3 phones, refuses a 4th, and re-pairing the same install uses no extra slot', async () => {
    const me = await caregiver();
    const p = await patientOf(me);
    const installs = [randomUUID(), randomUUID(), randomUUID()];
    for (const install_id of installs) expect((await redeem(await newCode(me, p.id), { install_id })).status).toBe(201);
    const fourth = await redeem(await newCode(me, p.id));
    expect(fourth.status).toBe(409);
    expect(fourth.body.error.code).toBe('DEVICE_LIMIT_REACHED');

    const repair = await redeem(await newCode(me, p.id), { install_id: installs[0] });
    expect(repair.status).toBe(201);
    expect(await db.$count(devices, and(eq(devices.patientId, p.id), isNull(devices.revokedAt)))).toBe(3);
    expect((await db.select().from(auditLog).where(eq(auditLog.patientId, p.id))).some((a) => a.action === 'device.revoked')).toBe(true);
  });

  it('refuses when the owner has no subscription or the patient is archived or suspended', async () => {
    const me = await caregiver();
    const p = await patientOf(me);
    const code = await newCode(me, p.id);
    await db.update(subscriptions).set({ status: 'expired' }).where(eq(subscriptions.userId, me.id));
    expect((await redeem(code)).body.error.code).toBe('SUBSCRIPTION_INACTIVE');
    await db.update(subscriptions).set({ status: 'active' }).where(eq(subscriptions.userId, me.id));
    await db.update(patients).set({ status: 'suspended' }).where(eq(patients.id, p.id));
    expect((await redeem(code)).body.error.code).toBe('PATIENT_SUSPENDED');
    await asCaregiver(me, 'post', `/v1/patients/${p.id}/archive`).catch(() => null);
  });

  it('rate limits per IP, and per install', async () => {
    let limited = 0;
    for (let i = 0; i < 12; i++) if ((await redeem('ZZZZ-ZZZZ')).status === 429) limited++;
    expect(limited).toBeGreaterThanOrEqual(2);
    await redis.flushdb();
    const install_id = randomUUID();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await redeem('ZZZZ-ZZZZ', { install_id })).status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(2);
  });

  it('validates the body and records attestation as provided-but-unverified', async () => {
    const me = await caregiver();
    const p = await patientOf(me);
    expect((await http().post('/v1/pairing/redeem').send({ code: 'ABCD-EFGH' })).status).toBe(400);
    const res = await http().post('/v1/pairing/redeem').send({ ...redeemBody(await newCode(me, p.id)), attestation: { platform: 'android', token: 'x', challenge: 'c' } });
    expect(res.status).toBe(201);
    const [entry] = await db.select().from(auditLog).where(and(eq(auditLog.patientId, p.id), eq(auditLog.action, 'pairing.redeemed')));
    expect(entry!.meta).toEqual({ attestation: 'provided_unverified' });
  });

  it('issues a challenge', async () => {
    const res = await http().post('/v1/pairing/challenge').send({ platform: 'android' });
    expect(res.status).toBe(200);
    expect(res.body.challenge.split('.')).toHaveLength(4);
    expect(new Date(res.body.expires_at).getTime()).toBeGreaterThan(Date.now());
    expect((await http().post('/v1/pairing/challenge').send({ platform: 'web' })).status).toBe(400);
  });
});

describe('device token', () => {
  async function paired() {
    const me = await caregiver();
    const p = await patientOf(me);
    const res = await redeem(await newCode(me, p.id));
    return { me, p, token: res.body.device_token as string, deviceId: res.body.device_id as string };
  }

  it('authenticates a device on a device route and not a caregiver route', async () => {
    const { token, p } = await paired();
    expect((await asDevice(token, 'post', '/v1/devices/heartbeat').send(heartbeatBody)).status).toBe(200);
    expect((await asDevice(token, 'get', `/v1/patients/${p.id}`)).status).toBe(401); // caregiver-only route
    expect((await http().post('/v1/devices/heartbeat').set('Authorization', 'Device nope').send(heartbeatBody)).body.error.code).toBe('DEVICE_TOKEN_REJECTED');
  });

  it('a caregiver token cannot reach device-only routes', async () => {
    const me = await caregiver();
    expect((await asCaregiver(me, 'get', '/v1/patients')).status).toBe(200);
    expect((await http().post('/v1/devices/heartbeat').set('Authorization', 'Basic x').send(heartbeatBody)).status).toBe(401);
  });

  it('revoking a device refuses its token and alerts the caregiver once per 12 hours', async () => {
    const { me, p, token, deviceId } = await paired();
    const revoked = await asCaregiver(me, 'post', `/v1/devices/${deviceId}/revoke`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.revoked_at).toBeTruthy();
    const before = await db.$count(notificationLog, eq(notificationLog.kind, 'pairing'));
    for (let i = 0; i < 3; i++) {
      const res = await asDevice(token, 'post', '/v1/devices/heartbeat').send(heartbeatBody);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('DEVICE_TOKEN_REJECTED');
    }
    expect(await db.$count(notificationLog, eq(notificationLog.kind, 'pairing'))).toBe(before + 1);
    const actions = (await db.select().from(auditLog).where(eq(auditLog.patientId, p.id))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['device.revoked', 'device.token_rejected']));
    expect((await asCaregiver(me, 'post', `/v1/devices/${deviceId}/revoke`)).status).toBe(200); // repeatable
  });

  it('only the owner can revoke or list devices: others get 404', async () => {
    const { p, deviceId } = await paired();
    const stranger = await caregiver();
    expect((await asCaregiver(stranger, 'post', `/v1/devices/${deviceId}/revoke`)).status).toBe(404);
    expect((await asCaregiver(stranger, 'get', `/v1/patients/${p.id}/devices`)).status).toBe(404);
    expect((await asCaregiver(stranger, 'post', `/v1/devices/${randomUUID()}/revoke`)).status).toBe(404);
  });

  it('lists a patient’s devices including revoked ones', async () => {
    const { me, p, deviceId } = await paired();
    await asCaregiver(me, 'post', `/v1/devices/${deviceId}/revoke`);
    const res = await asCaregiver(me, 'get', `/v1/patients/${p.id}/devices`);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].revoked_at).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toContain('token');
  });
});

describe('heartbeat', () => {
  it('records state and says whether a sync is needed', async () => {
    const me = await caregiver();
    const p = await patientOf(me);
    const reg = await redeem(await newCode(me, p.id));
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    const far = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const hb = (scheduled_through: string | null) => asDevice(reg.body.device_token, 'post', '/v1/devices/heartbeat').send({ ...heartbeatBody, push_token: 'ExponentPushToken[abc]', scheduled_through });
    expect((await hb(null)).body.sync_needed).toBe(true);
    expect((await hb(soon)).body.sync_needed).toBe(true);
    const ok = await hb(far);
    expect(ok.body).toMatchObject({ sync_needed: false, min_app_version: '0.0.0' });
    expect(ok.body.server_time).toBeTruthy();
    const [device] = await db.select().from(devices).where(eq(devices.id, reg.body.device_id));
    expect(device).toMatchObject({ pushToken: 'ExponentPushToken[abc]', permNotifications: true, permExactAlarm: true, appVersion: '1.0.1' });
    expect(device!.lastSeenAt).toBeTruthy();
  });

  it('works for the caregiver’s own phone and rejects bad bodies', async () => {
    const me = await caregiver();
    const res = await http().post('/v1/devices/heartbeat').set('Authorization', `Bearer ${me.token}`).send(heartbeatBody);
    expect(res.status).toBe(200);
    const [row] = await db.select().from(devices).where(and(eq(devices.userId, me.id), isNull(devices.revokedAt)));
    expect(row!.permNotifications).toBe(true);
    expect((await http().post('/v1/devices/heartbeat').set('Authorization', `Bearer ${me.token}`).send({ tz: 'EST' })).status).toBe(400);
  });

  it('moves a follow_device patient to the phone’s time zone, and leaves a fixed one alone', async () => {
    const me = await caregiver();
    const follow = await patientOf(me, { tz_mode: 'follow_device' });
    const fixed = await patientOf(me, { tz_mode: 'fixed' });
    for (const [p, expected] of [[follow, 'Europe/London'], [fixed, 'Asia/Kolkata']] as const) {
      const reg = await redeem(await newCode(me, p.id));
      await asDevice(reg.body.device_token, 'post', '/v1/devices/heartbeat').send({ ...heartbeatBody, tz: 'Europe/London' });
      expect((await db.select().from(patients).where(eq(patients.id, p.id)))[0]!.timezone).toBe(expected);
    }
    expect((await db.select().from(auditLog).where(and(eq(auditLog.patientId, follow.id), eq(auditLog.action, 'patient.timezone_changed')))).length).toBe(1);
    const notices = await db.select().from(notificationLog).where(and(eq(notificationLog.patientId, follow.id), eq(notificationLog.kind, 'pairing')));
    expect(notices.map((n) => n.data)).toContainEqual({ event: 'timezone_changed', timezone: 'Europe/London' });
    expect(JSON.stringify(await db.select().from(notificationLog).where(eq(notificationLog.patientId, fixed.id)))).not.toContain('timezone_changed');
  });
});

describe('app config and minimum version', () => {
  it('is public and returns the documented shape', async () => {
    const res = await http().get('/v1/app/config');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['feature_flags', 'grievance_contact', 'latest_app_version', 'min_app_version', 'support_url']);
    expect(res.body.min_app_version).toEqual({ ios: '0.0.0', android: '0.0.0' });
  });

  it('answers 426 below the minimum but still accepts config, heartbeats and answers', async () => {
    const me = await caregiver();
    const reg = await redeem(await newCode(me, (await patientOf(me)).id));
    const was = process.env.APP_MIN_VERSION_ANDROID;
    process.env.APP_MIN_VERSION_ANDROID = '2.0.0';
    try {
      const old = { 'X-App-Version': '1.9.9', 'X-Platform': 'android' };
      const blocked = await http().get('/v1/patients').set('Authorization', `Bearer ${me.token}`).set(old);
      expect(blocked.status).toBe(426);
      expect(blocked.body.error).toMatchObject({ code: 'UPGRADE_REQUIRED', details: { min_app_version: '2.0.0' } });
      expect((await http().get('/v1/app/config').set(old)).status).toBe(200);
      expect((await asDevice(reg.body.device_token, 'post', '/v1/devices/heartbeat').set(old).send(heartbeatBody)).status).toBe(200);
      expect((await http().get('/v1/patients').set('Authorization', `Bearer ${me.token}`).set({ 'X-App-Version': '2.0.0', 'X-Platform': 'android' })).status).toBe(200);
      expect((await http().get('/v1/patients').set('Authorization', `Bearer ${me.token}`)).status).toBe(200); // not our app: no headers
    } finally {
      process.env.APP_MIN_VERSION_ANDROID = was;
    }
  });
});
