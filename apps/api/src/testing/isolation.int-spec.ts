// The isolation test harness (docs/12-testing-and-slos.md#isolation-tests, docs/10-security-privacy.md#isolation).
// Two caregivers, A and B, each with a patient, a medicine, a paired phone and an export. Every route the app exposes
// must be classified below; the test fails if one is missing (or stale), so a new endpoint cannot ship unchecked.
import { randomUUID } from 'node:crypto';
import { discoverRoutes } from './routes.js';
import { startApp } from './harness.js';

let t: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  t = await startApp();
});
beforeEach(() => t.redis.flushdb());
afterAll(() => t.close());

const SECRET_NAME = 'Bravo-Patient-XYZ';
const SECRET_MED = 'Bravo-Medicine-XYZ';
type Ids = Record<'patientId' | 'medicineId' | 'deviceId' | 'requestId', string>;

// How each route is protected:
//   public     no credentials needed
//   device     a paired-device token; scoped to that phone's one patient
//   self       a caregiver token; every row comes from the caller's own account (no IDs in the path)
//   scoped     a caregiver token and an ID in the path or body; someone else's ID must be a 404
type Kind = 'public' | 'device' | 'self' | 'scoped';
const medicine = { name: 'Intruder', schedule: { pattern: 'daily', start_date: '2026-01-01', times: [{ local_time: '08:00', amount_text: '1' }] } };
const REGISTRY: Record<string, { kind: Kind; body?: (ids: Ids) => object }> = {
  'GET /v1/app/config': { kind: 'public' },
  'POST /v1/auth/login': { kind: 'public' },
  'POST /v1/auth/refresh': { kind: 'public' },
  'POST /v1/auth/register': { kind: 'public' },
  'POST /v1/pairing/challenge': { kind: 'public' },
  'POST /v1/pairing/redeem': { kind: 'public' },
  'POST /v1/webhooks/revenuecat': { kind: 'public' },

  'GET /v1/device/sync': { kind: 'device' },
  'POST /v1/device/dose-responses': { kind: 'device' },
  'POST /v1/devices/heartbeat': { kind: 'device' },

  'GET /v1/patients': { kind: 'self' },
  'POST /v1/patients': { kind: 'self', body: () => ({ display_name: 'Mine', type: 'managed', timezone: 'UTC' }) },
  'GET /v1/settings': { kind: 'self' },
  'PATCH /v1/settings': { kind: 'self', body: () => ({ default_missed_delay_min: 31 }) },
  'GET /v1/subscription': { kind: 'self' },
  'POST /v1/subscription/refresh': { kind: 'self' },
  'POST /v1/me/export': { kind: 'self' },
  'POST /v1/me/delete': { kind: 'self', body: () => ({ confirm: 'DELETE', password: 'definitely not the password' }) },
  'POST /v1/auth/logout': { kind: 'self' },
  'POST /v1/transfers/redeem': { kind: 'self', body: () => ({ code: 'ZZZZ-ZZZZ', as_self: false }) },

  'GET /v1/me/export/:requestId': { kind: 'scoped' },
  'POST /v1/uploads/presign': { kind: 'scoped', body: (ids) => ({ patient_id: ids.patientId, content_type: 'image/jpeg', byte_size: 100 }) },
  'GET /v1/medicines/:medicineId': { kind: 'scoped' },
  'PATCH /v1/medicines/:medicineId': { kind: 'scoped', body: () => ({ name: 'Hijacked' }) },
  'PATCH /v1/medicines/:medicineId/stock': { kind: 'scoped', body: () => ({ stock_count: 1, low_stock_at: 1 }) },
  'POST /v1/medicines/:medicineId/archive': { kind: 'scoped' },
  'GET /v1/patients/:patientId': { kind: 'scoped' },
  'PATCH /v1/patients/:patientId': { kind: 'scoped', body: () => ({ display_name: 'Hijacked' }) },
  'GET /v1/patients/:patientId/adherence': { kind: 'scoped' },
  'GET /v1/patients/:patientId/audit-log': { kind: 'scoped' },
  'GET /v1/patients/:patientId/devices': { kind: 'scoped' },
  'GET /v1/patients/:patientId/doses': { kind: 'scoped' },
  'GET /v1/patients/:patientId/medicines': { kind: 'scoped' },
  'POST /v1/patients/:patientId/archive': { kind: 'scoped' },
  'POST /v1/patients/:patientId/medicines': { kind: 'scoped', body: () => medicine },
  'POST /v1/patients/:patientId/pairing-code': { kind: 'scoped' },
  'POST /v1/patients/:patientId/reactivate': { kind: 'scoped' },
  'POST /v1/patients/:patientId/transfer-code': { kind: 'scoped' },
  'POST /v1/devices/:deviceId/revoke': { kind: 'scoped' },
};

const fill = (route: string, ids: Ids) => route.replace(/:(\w+)/g, (_, k: keyof Ids) => ids[k]);
const split = (route: string) => ({ method: route.split(' ')[0]!.toLowerCase() as 'get' | 'post' | 'patch', path: route.split(' ')[1]! });

async function world() {
  const a = await t.caregiver();
  const b = await t.caregiver();
  const pa = await t.patientOf(a, { display_name: 'Alpha-Patient' });
  const pb = await t.patientOf(b, { display_name: SECRET_NAME });
  const med = (await t.call(b, 'post', `/v1/patients/${pb.id}/medicines`, { ...medicine, name: SECRET_MED })).body;
  const phoneA = await t.pair(a, pa.id);
  const phoneB = await t.pair(b, pb.id);
  const exp = (await t.call(b, 'post', '/v1/me/export')).body.request_id as string;
  const idsOfB: Ids = { patientId: pb.id, medicineId: med.id, deviceId: phoneB.deviceId, requestId: exp };
  return { a, b, pa, pb, med, phoneA, phoneB, idsOfB };
}

describe('the route table', () => {
  it('classifies every route the app exposes, and nothing that is gone', () => {
    const found = discoverRoutes(t.app);
    expect(found.filter((r) => !(r in REGISTRY)), 'routes missing from the isolation matrix: add them').toEqual([]);
    expect(Object.keys(REGISTRY).filter((r) => !found.includes(r)), 'matrix entries for routes that no longer exist').toEqual([]);
  });
});

describe('deny by default', () => {
  it('every route except the public ones refuses a call with no credentials', async () => {
    const w = await world();
    for (const [route, { kind, body }] of Object.entries(REGISTRY)) {
      if (kind === 'public') continue;
      const { method, path } = split(route);
      const res = await t.http()[method](fill(path, w.idsOfB)).send(body?.(w.idsOfB) ?? {});
      expect(res.status, route).toBe(401);
    }
  });

  it('a caregiver token cannot use device routes, and a device token cannot use caregiver routes', async () => {
    const w = await world();
    for (const [route, { kind, body }] of Object.entries(REGISTRY)) {
      const { method, path } = split(route);
      const target = fill(path, w.idsOfB);
      if (kind === 'device') {
        if (route === 'POST /v1/devices/heartbeat') continue; // takes either
        const res = await t.http()[method](target).set('Authorization', `Bearer ${w.a.token}`).send({});
        expect(res.status, `caregiver token on ${route}`).toBe(401);
      } else if (kind === 'self' || kind === 'scoped') {
        const res = await t.http()[method](target).set('Authorization', `Device ${w.phoneA.token}`).send(body?.(w.idsOfB) ?? {});
        expect(res.status, `device token on ${route}`).toBe(401);
      }
    }
  });
});

describe('caregiver A against caregiver B’s IDs', () => {
  it('every scoped route answers 404 with the one uniform body, and leaks nothing about B', async () => {
    const w = await world();
    const checked: string[] = [];
    for (const [route, { kind, body }] of Object.entries(REGISTRY)) {
      if (kind !== 'scoped') continue;
      const { method, path } = split(route);
      let req = t.http()[method](fill(path, w.idsOfB)).set('Authorization', `Bearer ${w.a.token}`);
      if (method !== 'get') req = req.set('Idempotency-Key', randomUUID());
      const res = await req.send(body?.(w.idsOfB) ?? {});
      expect(res.status, route).toBe(404);
      expect(res.body, route).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found.', details: {} } });
      checked.push(route);
    }
    expect(checked.length).toBe(Object.values(REGISTRY).filter((r) => r.kind === 'scoped').length);
    // And B's data is exactly as B left it.
    expect((await t.call(w.b, 'get', `/v1/patients/${w.pb.id}`)).body).toMatchObject({ display_name: SECRET_NAME, status: 'active' });
    expect((await t.call(w.b, 'get', `/v1/medicines/${w.med.id}`)).body).toMatchObject({ name: SECRET_MED, archived_at: null });
    expect((await t.call(w.b, 'get', `/v1/patients/${w.pb.id}/devices`)).body.items[0].revoked_at).toBeNull();
  });

  it('a malformed or random ID looks exactly like someone else’s', async () => {
    const w = await world();
    for (const bogus of ['not-a-uuid', randomUUID(), '0'.repeat(36)]) {
      for (const [route, { kind, body }] of Object.entries(REGISTRY)) {
        if (kind !== 'scoped' || route.includes('requestId') || route.includes('/stock')) continue;
        const { method, path } = split(route);
        const ids: Ids = { patientId: bogus, medicineId: bogus, deviceId: bogus, requestId: bogus };
        let req = t.http()[method](fill(path, ids)).set('Authorization', `Bearer ${w.a.token}`);
        if (method !== 'get') req = req.set('Idempotency-Key', randomUUID());
        const res = await req.send(body?.(ids) ?? {});
        expect(res.status, `${route} ${bogus}`).toBe(404);
      }
    }
  });

  it('routes with no ID in them only ever return the caller’s own data', async () => {
    const w = await world();
    for (const [route, { kind, body }] of Object.entries(REGISTRY)) {
      if (kind !== 'self' || route === 'POST /v1/me/delete' || route === 'POST /v1/auth/logout') continue;
      const { method, path } = split(route);
      let req = t.http()[method](path).set('Authorization', `Bearer ${w.a.token}`);
      if (method !== 'get') req = req.set('Idempotency-Key', randomUUID());
      const res = await req.send(body?.(w.idsOfB) ?? {});
      const text = JSON.stringify(res.body);
      for (const marker of [SECRET_NAME, SECRET_MED, w.pb.id, w.med.id, w.phoneB.deviceId, w.b.id, w.b.email]) expect(text, `${route} leaked ${marker}`).not.toContain(marker);
    }
    const list = await t.call(w.a, 'get', '/v1/patients');
    const ids = list.body.items.map((p: { id: string }) => p.id);
    expect(ids).toContain(w.pa.id);
    expect(ids).not.toContain(w.pb.id);
  });
});

describe('a patient’s phone against another patient', () => {
  it('sync shows only its own patient and dose-responses cannot touch anyone else’s dose', async () => {
    const w = await world();
    const sync = await t.asDevice(w.phoneA.token, 'get', '/v1/device/sync');
    const text = JSON.stringify(sync.body);
    for (const marker of [SECRET_NAME, SECRET_MED, w.pb.id, w.med.id]) expect(text).not.toContain(marker);

    const { doseInstances } = await import('../db/schema.js');
    const { eq } = await import('drizzle-orm');
    const theirDose = (await t.db.select().from(doseInstances).where(eq(doseInstances.patientId, w.pb.id)))[0]!;
    const res = await t.asDevice(w.phoneA.token, 'post', '/v1/device/dose-responses').send({ responses: [{ client_event_id: randomUUID(), dose_id: theirDose.id, action: 'taken', responded_at: new Date().toISOString() }] });
    expect(res.body.results[0]).toMatchObject({ outcome: 'rejected', dose: null });
    expect((await t.db.select().from(doseInstances).where(eq(doseInstances.id, theirDose.id)))[0]!.status).toBe('pending');
  });

  it('a heartbeat only ever changes the phone that sent it', async () => {
    const w = await world();
    const { devices } = await import('../db/schema.js');
    const { eq } = await import('drizzle-orm');
    const before = (await t.db.select().from(devices).where(eq(devices.id, w.phoneB.deviceId)))[0]!;
    await t.asDevice(w.phoneA.token, 'post', '/v1/devices/heartbeat').send({ permissions: { notifications: false }, app_version: '9.9.9', tz: 'UTC', scheduled_through: null, push_token: 'ExponentPushToken[a]' });
    const after = (await t.db.select().from(devices).where(eq(devices.id, w.phoneB.deviceId)))[0]!;
    expect(after).toEqual(before);
  });
});
