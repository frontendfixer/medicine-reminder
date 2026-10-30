import { and, eq, isNull } from 'drizzle-orm';
import { devices, notificationLog, patients } from '../db/schema.js';
import { FakePushTransport } from '../push/fake-push-transport.js';
import { OutboxSender } from '../push/outbox-sender.js';
import { PushTransport } from '../push/push-transport.js';
import { PushModule } from '../push/push.module.js';
import { startApp } from '../testing/harness.js';

let t: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  t = await startApp({ imports: [PushModule] });
});
beforeEach(async () => {
  await t.redis.flushdb();
  (t.app.get(PushTransport) as FakePushTransport).sent.length = 0;
});
afterAll(() => t.close());

const PASSWORD = 'correct horse battery';
const phone = (label: string, push_token?: string) => ({ platform: 'android', app_version: '1.0.0', label, ...(push_token ? { push_token } : {}) });
const login = (email: string, device: object) => t.http().post('/v1/auth/login').send({ email, password: PASSWORD, device });

async function caregiverWithSelfProfile() {
  const me = await t.caregiver();
  await t.patientOf(me, { type: 'self', display_name: 'Me' });
  const first = await login(me.email, phone('Old phone', 'ExponentPushToken[old]'));
  return { me, first };
}

describe('the self profile follows the login (06#caregiver-login)', () => {
  it('signing in on a new phone moves the self profile’s device: the old token dies, a new one works', async () => {
    const { me, first } = await caregiverWithSelfProfile();
    expect(first.body.self_profile_device_token).toBeTruthy();
    const old = first.body.self_profile_device_token as string;
    expect((await t.asDevice(old, 'get', '/v1/device/sync')).status).toBe(200);

    const second = await login(me.email, phone('New phone'));
    expect(second.status).toBe(200);
    const fresh = second.body.self_profile_device_token as string;
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(old);
    expect((await t.asDevice(old, 'get', '/v1/device/sync')).body.error.code).toBe('DEVICE_TOKEN_REJECTED');
    const sync = await t.asDevice(fresh, 'get', '/v1/device/sync');
    expect(sync.status).toBe(200);
    expect(sync.body.patient.display_name).toBe('Me');

    const [self] = await t.db.select().from(patients).where(and(eq(patients.ownerUserId, me.id), eq(patients.type, 'self')));
    expect(await t.db.$count(devices, and(eq(devices.patientId, self!.id), isNull(devices.revokedAt)))).toBe(1);
  });

  it('is absent when the caregiver has no self profile, and for a brand-new account', async () => {
    const me = await t.caregiver();
    const res = await login(me.email, phone('Phone'));
    expect(res.body).not.toHaveProperty('self_profile_device_token');
    const reg = await t.http().post('/v1/auth/register').send({ email: `fresh-${Date.now()}@example.test`, password: PASSWORD, device: phone('P'), consent: { notice_version: '1' } });
    expect(reg.body).not.toHaveProperty('self_profile_device_token');
  });

  it('logging out revokes it too (D-083)', async () => {
    const { first } = await caregiverWithSelfProfile();
    const token = first.body.self_profile_device_token as string;
    expect((await t.http().post('/v1/auth/logout').set('Authorization', `Bearer ${first.body.access_token}`).send()).status).toBe(204);
    expect((await t.asDevice(token, 'get', '/v1/device/sync')).body.error.code).toBe('DEVICE_TOKEN_REJECTED');
  });

  it('does not touch a patient the caregiver only manages, nor another caregiver’s self profile', async () => {
    const { me: base, first: signedIn } = await caregiverWithSelfProfile();
    const me = { ...base, token: signedIn.body.access_token as string }; // the sign-in above replaced the harness's session
    const managed = await t.patientOf(me, { display_name: 'Managed' });
    const managedPhone = await t.pair(me, managed.id);
    const other = await caregiverWithSelfProfile();
    await login(me.email, phone('Third phone'));
    expect((await t.asDevice(managedPhone.token, 'get', '/v1/device/sync')).status).toBe(200);
    expect((await t.asDevice(other.first.body.self_profile_device_token, 'get', '/v1/device/sync')).status).toBe(200);
  });
});

describe('"You were signed in on another phone" (D-019)', () => {
  it('is pushed to the phone that was signed out', async () => {
    const { me } = await caregiverWithSelfProfile();
    const transport = t.app.get(PushTransport) as FakePushTransport;
    const oldDevice = (await t.db.select().from(devices).where(and(eq(devices.userId, me.id), eq(devices.pushToken, 'ExponentPushToken[old]'))))[0]!;
    await login(me.email, phone('New phone', 'ExponentPushToken[new]'));
    const queued = await t.db.select().from(notificationLog).where(and(eq(notificationLog.deviceId, oldDevice.id), eq(notificationLog.kind, 'pairing')));
    expect(queued.map((q) => q.data)).toEqual([{ event: 'signed_in_elsewhere' }]);

    await t.app.get(OutboxSender).sendQueued();
    const message = transport.sent.find((m) => m.to === 'ExponentPushToken[old]')!;
    expect(message).toMatchObject({ body: 'You were signed in on another phone', data: { type: 'signed_in_elsewhere' }, priority: 'high' });
    expect(transport.sent.some((m) => m.to === 'ExponentPushToken[new]')).toBe(false); // not the new phone
  });

  it('is not sent for the first sign-in, or when it is the same phone signing in again', async () => {
    const me = await t.caregiver(); // registering is the first sign-in: there is no earlier phone to tell
    const before = await t.db.$count(notificationLog, eq(notificationLog.kind, 'pairing'));
    await login(me.email, phone('Phone', 'ExponentPushToken[same]'));
    await login(me.email, phone('Phone', 'ExponentPushToken[same]'));
    expect(await t.db.$count(notificationLog, eq(notificationLog.kind, 'pairing'))).toBe(before);
  });
});
