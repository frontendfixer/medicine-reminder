import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { and, eq, isNull } from 'drizzle-orm';
import { Redis } from 'ioredis';
import request from 'supertest';
import { AppModule } from '../app.module.js';
import type { Db } from '../db/client.js';
import { DB } from '../db/database.module.js';
import { auditLog, devices, doseInstances, medicines, pairingCodes, patients, scheduleVersions, subscriptions } from '../db/schema.js';
import { resetTestDb, testDatabaseUrl } from '../db/test-db.js';

let app: INestApplication;
let db: Db;
let redis: Redis;
let n = 0;

type Caregiver = { id: string; token: string };
const http = () => request(app.getHttpServer());

async function caregiver(): Promise<Caregiver> {
  const res = await http()
    .post('/v1/auth/register')
    .send({ email: `p${++n}-${Date.now()}@example.test`, password: 'correct horse battery', device: { platform: 'android', app_version: '1.0.0' }, consent: { notice_version: '1' } });
  return { id: res.body.user.id, token: res.body.access_token };
}
const call = (who: Caregiver, method: 'get' | 'post' | 'patch', path: string, body?: object, key: string | null = randomUUID()) => {
  let r = http()[method](path).set('Authorization', `Bearer ${who.token}`);
  if (method !== 'get' && key) r = r.set('Idempotency-Key', key);
  return body ? r.send(body) : r;
};
const newPatient = { display_name: 'Grandma Asha', type: 'managed', timezone: 'Asia/Kolkata', tz_mode: 'follow_device' };
const create = (who: Caregiver, over: object = {}) => call(who, 'post', '/v1/patients', { ...newPatient, ...over });
const audit = (patientId: string) => db.select().from(auditLog).where(eq(auditLog.patientId, patientId));

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

describe('POST /v1/patients', () => {
  it('creates a managed patient and returns it decrypted', async () => {
    const me = await caregiver();
    const res = await create(me, { missed_delay_min: 45 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ display_name: 'Grandma Asha', type: 'managed', timezone: 'Asia/Kolkata', tz_mode: 'follow_device', missed_delay_min: 45, lockscreen_detail: null, status: 'active', devices: [] });
    expect(res.body.id).toBeTruthy();
  });

  it('stores the name encrypted and audits the creation without it', async () => {
    const me = await caregiver();
    const res = await create(me);
    const [row] = await db.select().from(patients).where(eq(patients.id, res.body.id));
    expect(row!.displayName.toString('utf8')).toMatch(/^v1:/);
    expect(row!.displayName.toString('utf8')).not.toContain('Asha');
    const entries = await audit(res.body.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: 'patient.created', actorType: 'caregiver', actorId: me.id, meta: { type: 'managed' } });
    expect(JSON.stringify(entries)).not.toContain('Asha');
  });

  it('defaults tz_mode to follow_device', async () => {
    const res = await call(await caregiver(), 'post', '/v1/patients', { display_name: 'A', type: 'managed', timezone: 'UTC' });
    expect(res.body.tz_mode).toBe('follow_device');
  });

  it('requires an Idempotency-Key and creates once for a retried request', async () => {
    const me = await caregiver();
    expect((await call(me, 'post', '/v1/patients', newPatient, null)).status).toBe(400);
    const key = randomUUID();
    const first = await call(me, 'post', '/v1/patients', newPatient, key);
    const retry = await call(me, 'post', '/v1/patients', newPatient, key);
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual(first.body);
    expect(await db.$count(patients, eq(patients.ownerUserId, me.id))).toBe(1);
  });

  it('refuses the 4th managed patient and cannot be raced past the limit', async () => {
    const me = await caregiver();
    const results = await Promise.all(Array.from({ length: 8 }, () => create(me)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    for (const r of results.filter((r) => r.status !== 201)) {
      expect(r.status).toBe(409);
      expect(r.body.error).toMatchObject({ code: 'PATIENT_LIMIT_REACHED', details: { limit: 3 } });
    }
    expect(await db.$count(patients, eq(patients.ownerUserId, me.id))).toBe(3);
  });

  it('allows one self profile, outside the patient limit (D-008, D-092)', async () => {
    const me = await caregiver();
    for (let i = 0; i < 3; i++) await create(me);
    const self = await create(me, { type: 'self', display_name: 'Me' });
    expect(self.status).toBe(201);
    const second = await create(me, { type: 'self', display_name: 'Me again' });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('SELF_PROFILE_EXISTS');
  });

  it('needs an active subscription', async () => {
    const me = await caregiver();
    await db.update(subscriptions).set({ status: 'expired' }).where(eq(subscriptions.userId, me.id));
    for (const type of ['managed', 'self']) {
      const res = await create(me, { type });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('SUBSCRIPTION_INACTIVE');
    }
  });

  it.each([
    ['unknown time zone', { timezone: 'Mars/Olympus' }, 'timezone'],
    ['abbreviated time zone', { timezone: 'EST' }, 'timezone'],
    ['empty name', { display_name: '   ' }, 'display_name'],
    ['long name', { display_name: 'x'.repeat(81) }, 'display_name'],
    ['bad type', { type: 'child' }, 'type'],
    ['bad tz_mode', { tz_mode: 'auto' }, 'tz_mode'],
    ['zero delay', { missed_delay_min: 0 }, 'missed_delay_min'],
    ['fractional delay', { missed_delay_min: 1.5 }, 'missed_delay_min'],
    ['huge delay', { missed_delay_min: 5000 }, 'missed_delay_min'],
  ])('rejects %s', async (_label, over, field) => {
    const res = await create(await caregiver(), over);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(Object.keys(res.body.error.details.fields)).toContain(field);
  });
});

describe('GET /v1/patients', () => {
  it('lists only the caller’s patients, filtered by status', async () => {
    const a = await caregiver();
    const b = await caregiver();
    const mine = (await create(a)).body;
    const archived = (await create(a, { display_name: 'Old' })).body;
    await call(a, 'post', `/v1/patients/${archived.id}/archive`);
    const theirs = (await create(b, { display_name: 'Not yours' })).body;

    const all = await call(a, 'get', '/v1/patients');
    expect(all.body.items.map((p: { id: string }) => p.id).sort((x: string, y: string) => (x < y ? -1 : 1))).toEqual([mine.id, archived.id].sort((x, y) => (x < y ? -1 : 1)));
    expect(JSON.stringify(all.body)).not.toContain(theirs.id);
    expect(JSON.stringify(all.body)).not.toContain('Not yours');

    const active = await call(a, 'get', '/v1/patients?status=active');
    expect(active.body.items.map((p: { id: string }) => p.id)).toEqual([mine.id]);
    expect((await call(a, 'get', '/v1/patients?status=bogus')).status).toBe(400);
  });

  it('includes a patient’s active devices only', async () => {
    const me = await caregiver();
    const p = (await create(me)).body;
    const base = { patientId: p.id, platform: 'android' as const, tokenHash: randomUUID() };
    await db.insert(devices).values({ ...base, label: 'Pixel 8', appVersion: '1.0.0' });
    await db.insert(devices).values({ ...base, tokenHash: randomUUID(), label: 'Old phone', revokedAt: new Date() });
    const res = await call(me, 'get', `/v1/patients/${p.id}`);
    expect(res.body.devices).toHaveLength(1);
    expect(res.body.devices[0]).toMatchObject({ label: 'Pixel 8', platform: 'android', app_version: '1.0.0', revoked_at: null });
    expect(res.body.devices[0]).not.toHaveProperty('token_hash');
  });

  it('needs a signed-in caregiver', async () => {
    expect((await http().get('/v1/patients')).status).toBe(401);
  });
});

describe('isolation: another caregiver’s patient is a 404', () => {
  it('get, update, archive and reactivate all return the same 404 as a patient that does not exist', async () => {
    const a = await caregiver();
    const b = await caregiver();
    const victim = (await create(b)).body;
    const archivedVictim = (await create(b, { display_name: 'Archived' })).body;
    await call(b, 'post', `/v1/patients/${archivedVictim.id}/archive`);

    for (const id of [victim.id, archivedVictim.id, randomUUID(), 'not-a-uuid']) {
      const results = await Promise.all([
        call(a, 'get', `/v1/patients/${id}`),
        call(a, 'patch', `/v1/patients/${id}`, { display_name: 'Hijacked' }),
        call(a, 'post', `/v1/patients/${id}/archive`),
        call(a, 'post', `/v1/patients/${id}/reactivate`),
      ]);
      for (const r of results) {
        expect(r.status, id).toBe(404);
        expect(r.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found.', details: {} } });
      }
    }
    const [after] = await db.select().from(patients).where(eq(patients.id, victim.id));
    expect(after).toMatchObject({ status: 'active', archivedAt: null });
    expect((await call(b, 'get', `/v1/patients/${victim.id}`)).body.display_name).toBe('Grandma Asha');
    expect((await db.select().from(patients).where(eq(patients.id, archivedVictim.id)))[0]!.status).toBe('archived');
  });
});

describe('PATCH /v1/patients/:id', () => {
  it('updates fields, re-encrypts the name, clears overrides with null, and audits field names only', async () => {
    const me = await caregiver();
    const p = (await create(me, { missed_delay_min: 45 })).body;
    const res = await call(me, 'patch', `/v1/patients/${p.id}`, { display_name: 'Grandpa Ravi', lockscreen_detail: 'generic', missed_delay_min: null, tz_mode: 'fixed' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ display_name: 'Grandpa Ravi', lockscreen_detail: 'generic', missed_delay_min: null, tz_mode: 'fixed', timezone: 'Asia/Kolkata' });

    const [row] = await db.select().from(patients).where(eq(patients.id, p.id));
    expect(row!.displayName.toString('utf8')).not.toContain('Ravi');
    const updated = (await audit(p.id)).find((e) => e.action === 'patient.updated');
    expect(updated!.meta).toEqual({ fields: ['display_name', 'lockscreen_detail', 'missed_delay_min', 'tz_mode'] });
    expect(JSON.stringify(await audit(p.id))).not.toMatch(/Ravi|Asha/);
  });

  it('records a time zone change', async () => {
    const me = await caregiver();
    const p = (await create(me)).body;
    await call(me, 'patch', `/v1/patients/${p.id}`, { timezone: 'Europe/London' });
    expect((await audit(p.id)).map((e) => e.action)).toContain('patient.timezone_changed');
    await call(me, 'patch', `/v1/patients/${p.id}`, { timezone: 'Europe/London' });
    expect((await audit(p.id)).filter((e) => e.action === 'patient.timezone_changed')).toHaveLength(1);
  });

  it('rejects an empty body, unknown fields (type, status, owner) and bad values', async () => {
    const me = await caregiver();
    const p = (await create(me)).body;
    for (const body of [{}, { type: 'self' }, { status: 'archived' }, { owner_user_id: randomUUID() }, { timezone: 'EST' }, { display_name: '' }]) {
      const res = await call(me, 'patch', `/v1/patients/${p.id}`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await call(me, 'get', `/v1/patients/${p.id}`)).body.type).toBe('managed');
  });

  it('refuses edits to suspended and archived patients', async () => {
    const me = await caregiver();
    const p = (await create(me)).body;
    await db.update(patients).set({ status: 'suspended', suspendedAt: new Date() }).where(eq(patients.id, p.id));
    const suspended = await call(me, 'patch', `/v1/patients/${p.id}`, { display_name: 'X' });
    expect(suspended.status).toBe(403);
    expect(suspended.body.error.code).toBe('PATIENT_SUSPENDED');

    const q = (await create(me)).body;
    await call(me, 'post', `/v1/patients/${q.id}/archive`);
    const archived = await call(me, 'patch', `/v1/patients/${q.id}`, { display_name: 'X' });
    expect(archived.status).toBe(409);
    expect(archived.body.error.code).toBe('PATIENT_ARCHIVED');
  });
});

describe('archive and reactivate', () => {
  async function patientWithHistory(me: Caregiver) {
    const p = (await create(me)).body;
    const [med] = await db.insert(medicines).values({ patientId: p.id, name: Buffer.from('m') }).returning();
    const [version] = await db.insert(scheduleVersions).values({ medicineId: med!.id, effectiveFrom: new Date(), pattern: 'daily', startDate: '2026-11-01' }).returning();
    const dose = (hoursFromNow: number, status: 'pending' | 'taken') => ({
      patientId: p.id,
      medicineId: med!.id,
      scheduleVersionId: version!.id,
      scheduledAt: new Date(Date.now() + hoursFromNow * 3_600_000),
      localTime: '08:00',
      nameSnapshot: Buffer.from('m'),
      amountSnapshot: '1',
      alertDueAt: new Date(Date.now() + hoursFromNow * 3_600_000 + 1_800_000),
      status,
    });
    await db.insert(doseInstances).values([dose(24, 'pending'), dose(48, 'pending'), dose(-24, 'taken'), dose(-48, 'pending')]);
    await db.insert(devices).values({ patientId: p.id, platform: 'android', tokenHash: randomUUID() });
    await db.insert(pairingCodes).values({ patientId: p.id, kind: 'pair', createdByUserId: me.id, lookupHash: 'l', codeHash: 'c', expiresAt: new Date(Date.now() + 600_000) });
    return p;
  }

  it('ends everything live but keeps history', async () => {
    const me = await caregiver();
    const p = await patientWithHistory(me);
    const res = await call(me, 'post', `/v1/patients/${p.id}/archive`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'archived', devices: [] });

    expect(await db.$count(devices, and(eq(devices.patientId, p.id), isNull(devices.revokedAt)))).toBe(0);
    expect(await db.$count(devices, eq(devices.patientId, p.id))).toBe(1); // revoked, not deleted
    const doses = await db.select().from(doseInstances).where(eq(doseInstances.patientId, p.id));
    expect(doses).toHaveLength(2); // future pending deleted; the answered and the past ones stay
    expect(doses.map((d) => d.status).sort()).toEqual(['pending', 'taken']);
    expect(await db.$count(pairingCodes, and(eq(pairingCodes.patientId, p.id), isNull(pairingCodes.invalidatedAt)))).toBe(0);
    expect(await db.$count(medicines, eq(medicines.patientId, p.id))).toBe(1);

    const actions = (await audit(p.id)).map((e) => e.action);
    expect(actions).toContain('patient.archived');
    expect(actions).toContain('device.revoked');
  });

  it('is repeatable, and frees the slot', async () => {
    const me = await caregiver();
    const ps = [(await create(me)).body, (await create(me)).body, (await create(me)).body];
    expect((await create(me)).status).toBe(409);
    expect((await call(me, 'post', `/v1/patients/${ps[0].id}/archive`)).status).toBe(200);
    expect((await call(me, 'post', `/v1/patients/${ps[0].id}/archive`)).status).toBe(200);
    expect((await audit(ps[0].id)).filter((e) => e.action === 'patient.archived')).toHaveLength(1);
    expect((await create(me)).status).toBe(201);
  });

  it('reactivation is subject to the quota', async () => {
    const me = await caregiver();
    const first = (await create(me)).body;
    await call(me, 'post', `/v1/patients/${first.id}/archive`);
    for (let i = 0; i < 3; i++) await create(me);
    const blocked = await call(me, 'post', `/v1/patients/${first.id}/reactivate`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('PATIENT_LIMIT_REACHED');
    expect((await call(me, 'get', `/v1/patients/${first.id}`)).body.status).toBe('archived');
  });

  it('reactivates when there is room, and an active patient is left alone', async () => {
    const me = await caregiver();
    const p = (await create(me)).body;
    await call(me, 'post', `/v1/patients/${p.id}/archive`);
    const res = await call(me, 'post', `/v1/patients/${p.id}/reactivate`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
    const [row] = await db.select().from(patients).where(eq(patients.id, p.id));
    expect(row!.archivedAt).toBeNull();
    expect((await call(me, 'post', `/v1/patients/${p.id}/reactivate`)).status).toBe(200);
    expect((await audit(p.id)).filter((e) => e.action === 'patient.reactivated')).toHaveLength(1);
  });

  it('needs an active subscription to reactivate, and renewal (not the caregiver) to un-suspend', async () => {
    const me = await caregiver();
    const p = (await create(me)).body;
    await call(me, 'post', `/v1/patients/${p.id}/archive`);
    await db.update(subscriptions).set({ status: 'expired' }).where(eq(subscriptions.userId, me.id));
    expect((await call(me, 'post', `/v1/patients/${p.id}/reactivate`)).body.error.code).toBe('SUBSCRIPTION_INACTIVE');

    await db.update(subscriptions).set({ status: 'active' }).where(eq(subscriptions.userId, me.id));
    const s = (await create(me)).body;
    await db.update(patients).set({ status: 'suspended', suspendedAt: new Date() }).where(eq(patients.id, s.id));
    const res = await call(me, 'post', `/v1/patients/${s.id}/reactivate`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PATIENT_SUSPENDED');
  });

  it('will not bring back a second self profile', async () => {
    const me = await caregiver();
    const first = (await create(me, { type: 'self', display_name: 'Me' })).body;
    await call(me, 'post', `/v1/patients/${first.id}/archive`);
    expect((await create(me, { type: 'self', display_name: 'Me v2' })).status).toBe(201);
    const res = await call(me, 'post', `/v1/patients/${first.id}/reactivate`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SELF_PROFILE_EXISTS');
  });
});
