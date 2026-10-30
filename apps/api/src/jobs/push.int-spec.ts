import { and, asc, eq } from 'drizzle-orm';
import { devices, doseInstances, notificationLog, patients, subscriptions } from '../db/schema.js';
import { FakePushTransport } from '../push/fake-push-transport.js';
import { OutboxSender } from '../push/outbox-sender.js';
import { PushTransport } from '../push/push-transport.js';
import { PushModule } from '../push/push.module.js';
import { staggerMs, startApp } from '../testing/harness.js';
import { DoseGeneratorService } from './dose-generator.service.js';
import { HealthService } from './health.service.js';
import { JobsCoreModule } from './jobs.module.js';
import { JobsService, QUEUE_NAME, SCHEDULERS } from './jobs.service.js';
import { SweeperService } from './sweeper.service.js';

let t: Awaited<ReturnType<typeof startApp>>;
let transport: FakePushTransport;
let sender: OutboxSender;
let sweeper: SweeperService;
let health: HealthService;
beforeAll(async () => {
  t = await startApp({ imports: [PushModule, JobsCoreModule] });
  transport = t.app.get(PushTransport) as FakePushTransport;
  sender = t.app.get(OutboxSender);
  sweeper = t.app.get(SweeperService);
  health = t.app.get(HealthService);
});
beforeEach(async () => {
  await t.redis.flushdb();
  await t.db.delete(notificationLog);
  await t.db.delete(doseInstances);
  transport.sent.length = 0;
  transport.failNext = 0;
  transport.ticketFor = (_m, i) => ({ status: 'ok', id: `ticket-${randomId()}-${i}` });
  transport.receiptFor = () => ({ status: 'ok' });
});
afterAll(() => t.close());

const randomId = () => Math.random().toString(36).slice(2);
const ago = (min: number) => new Date(Date.now() - min * 60_000);
const ahead = (min: number) => new Date(Date.now() + min * 60_000);
const schedule = { pattern: 'daily', start_date: '2026-01-01', times: [{ local_time: '08:00', amount_text: '2 tablets' }] };
const beat = { permissions: { notifications: true, exact_alarm: true, battery_unrestricted: true }, app_version: '1.0.0', tz: 'Asia/Kolkata', scheduled_through: ahead(60 * 72).toISOString() };

async function setup(medType = 'alarm') {
  const me = await t.caregiver();
  const p = await t.patientOf(me, { display_name: 'Asha' });
  await t.call(me, 'post', `/v1/patients/${p.id}/medicines`, { name: 'Metformin SECRETNAME', notes: 'SECRETNOTE', notification_type: medType, schedule });
  const phone = await t.pair(me, p.id, { label: 'Pixel 8' });
  await t.asDevice(phone.token, 'post', '/v1/devices/heartbeat').send({ ...beat, push_token: `ExponentPushToken[patient-${randomId()}]` });
  await t.call(me, 'post', '/v1/devices/heartbeat', { ...beat, push_token: `ExponentPushToken[carer-${randomId()}]` }).catch(() => null);
  await t.http().post('/v1/devices/heartbeat').set('Authorization', `Bearer ${me.token}`).send({ ...beat, push_token: `ExponentPushToken[carer-${randomId()}]` });
  const doses = await t.db.select().from(doseInstances).where(eq(doseInstances.patientId, p.id)).orderBy(asc(doseInstances.scheduledAt));
  const place = (id: string, due: number, deadline = 30) => {
    const at = new Date(ago(due).getTime() - staggerMs());
    return t.db.update(doseInstances).set({ scheduledAt: at, alertDueAt: new Date(at.getTime() + deadline * 60_000), pushSentAt: null, alertSentAt: null }).where(eq(doseInstances.id, id));
  };
  const log = () => t.db.select().from(notificationLog).where(eq(notificationLog.patientId, p.id)).orderBy(asc(notificationLog.createdAt));
  const phoneRow = async () => (await t.db.select().from(devices).where(eq(devices.id, phone.deviceId)))[0]!;
  await t.db.delete(notificationLog).where(eq(notificationLog.patientId, p.id)); // setup's own "patient connected" noise
  return { me, p, phone, doses, place, log, phoneRow };
}

describe('OutboxSender', () => {
  it('sends a missed alert with generic text and records the ticket', async () => {
    const s = await setup();
    await s.place(s.doses[0]!.id, 40);
    await sweeper.passB(new Date());
    expect(await sender.sendQueued()).toBe(1);
    expect(transport.sent).toHaveLength(1);
    const m = transport.sent[0]!;
    expect(m.to).toMatch(/^ExponentPushToken\[carer-/);
    expect(m.body).toBe('A dose for Asha at ' + m.body!.match(/\d\d:\d\d/)![0] + ' has no answer recorded');
    expect(m).toMatchObject({ priority: 'high', channelId: 'caregiver_alerts_v1', data: { type: 'missed', patient_id: s.p.id } });
    const [row] = await s.log();
    expect(row).toMatchObject({ status: 'sent', ticketStatus: 'ok' });
    expect(row!.expoTicketId).toBeTruthy();
    expect(row!.sentAt).toBeTruthy();
  });

  it('never puts a medicine name, amount or note in any push (D-077)', async () => {
    const s = await setup();
    await s.place(s.doses[0]!.id, 5, 30);
    await t.db.update(devices).set({ scheduledThrough: null }).where(eq(devices.id, s.phone.deviceId));
    await sweeper.passA(new Date()); // backup to the patient's phone
    await s.place(s.doses[1]!.id, 40, 30);
    await sweeper.passB(new Date()); // missed alert to the caregiver
    await t.http().post('/v1/device/dose-responses').set('Authorization', `Device ${s.phone.token}`).send({ responses: [{ client_event_id: crypto.randomUUID(), dose_id: s.doses[2]!.id, action: 'not_taken', responded_at: new Date().toISOString() }] });
    await sender.sendQueued();
    expect(transport.sent.length).toBeGreaterThanOrEqual(3);
    const everything = JSON.stringify(transport.sent);
    for (const secret of ['Metformin', 'SECRETNAME', 'SECRETNOTE', '2 tablets']) expect(everything).not.toContain(secret);
  });

  it('a backup push to the patient carries the dose ID, the actions category and the right channel', async () => {
    const s = await setup('gentle');
    await t.db.update(devices).set({ scheduledThrough: null }).where(eq(devices.id, s.phone.deviceId));
    await s.place(s.doses[0]!.id, 5, 30);
    await sweeper.passA(new Date());
    await sender.sendQueued();
    const m = transport.sent.find((x) => x.to.includes('patient'))!;
    expect(m).toMatchObject({ channelId: 'dose_gentle_v1', categoryId: 'dose_v1', interruptionLevel: 'active', priority: 'high', data: { type: 'dose', dose_id: s.doses[0]!.id }, collapseId: s.doses[0]!.id });
    expect(m.ttl).toBeLessThanOrEqual(30 * 60); // useless after the deadline
    expect(m.body).toMatch(/^Time for your \d\d:\d\d medicine$/);
  });

  it('Alarm and Standard use time-sensitive on iOS (D-027, D-094)', async () => {
    const s = await setup('alarm');
    await t.db.update(devices).set({ scheduledThrough: null }).where(eq(devices.id, s.phone.deviceId));
    await s.place(s.doses[0]!.id, 5, 30);
    await sweeper.passA(new Date());
    await sender.sendQueued();
    expect(transport.sent.find((x) => x.to.includes('patient'))).toMatchObject({ channelId: 'dose_alarm_v1', interruptionLevel: 'time-sensitive' });
  });

  it('Not taken and correction alerts name the patient and the times, nothing else', async () => {
    const s = await setup();
    await s.place(s.doses[0]!.id, 5);
    await t.http().post('/v1/device/dose-responses').set('Authorization', `Device ${s.phone.token}`).send({ responses: [{ client_event_id: crypto.randomUUID(), dose_id: s.doses[0]!.id, action: 'not_taken', responded_at: new Date().toISOString() }] });
    await sender.sendQueued();
    expect(transport.sent.map((m) => m.body)).toEqual(expect.arrayContaining([expect.stringMatching(/^Asha answered Not taken for a dose at \d\d:\d\d$/)]));
  });

  it('data pushes carry no text, are high priority and wake the app (D-075)', async () => {
    const s = await setup();
    const second = await t.pair(s.me, s.p.id);
    await t.asDevice(second.token, 'post', '/v1/devices/heartbeat').send({ ...beat, push_token: 'ExponentPushToken[second]' });
    await t.http().post('/v1/device/dose-responses').set('Authorization', `Device ${s.phone.token}`).send({ responses: [{ client_event_id: crypto.randomUUID(), dose_id: s.doses[0]!.id, action: 'taken', responded_at: new Date().toISOString() }] });
    await sender.sendQueued();
    const data = transport.sent.find((m) => m.to === 'ExponentPushToken[second]')!;
    expect(data).toMatchObject({ data: { type: 'dose_cleared', dose_id: s.doses[0]!.id }, priority: 'high', contentAvailable: true });
    expect(data.title).toBeUndefined();
    expect(data.body).toBeUndefined();
  });

  it('drops a token that Expo says is no longer registered, and flags the phone', async () => {
    const s = await setup();
    transport.ticketFor = () => ({ status: 'error', message: 'gone', error: 'DeviceNotRegistered' });
    await t.db.update(devices).set({ scheduledThrough: null }).where(eq(devices.id, s.phone.deviceId));
    await s.place(s.doses[0]!.id, 5);
    await sweeper.passA(new Date());
    await sender.sendQueued();
    const phone = await s.phoneRow();
    expect(phone.pushToken).toBeNull();
    expect(phone.pushInvalidAt).toBeTruthy();
    expect((await s.log()).find((r) => r.kind === 'backup')).toMatchObject({ status: 'failed', ticketError: 'DeviceNotRegistered' });
    // The next heartbeat re-registers a token and clears the flag.
    await t.asDevice(s.phone.token, 'post', '/v1/devices/heartbeat').send({ ...beat, push_token: 'ExponentPushToken[fresh]' });
    expect((await s.phoneRow()).pushInvalidAt).toBeNull();
  });

  it('leaves rows queued when the provider is down, and sends them on a later run', async () => {
    const s = await setup();
    await s.place(s.doses[0]!.id, 40);
    await sweeper.passB(new Date());
    transport.failNext = 10;
    expect(await sender.sendQueued(2_000)).toBe(0);
    expect((await s.log()).every((r) => r.status === 'queued')).toBe(true);
    transport.failNext = 0;
    expect(await sender.sendQueued()).toBe(1);
    expect((await s.log())[0]!.status).toBe('sent');
  });

  it('keeps a rate-limited message queued, and fails one that cannot be delivered', async () => {
    const s = await setup();
    await s.place(s.doses[0]!.id, 40);
    await sweeper.passB(new Date());
    transport.ticketFor = () => ({ status: 'error', message: 'slow down', error: 'MessageRateExceeded' });
    await sender.sendQueued(1_000);
    expect((await s.log())[0]!.status).toBe('queued');
    transport.ticketFor = () => ({ status: 'error', message: 'too big', error: 'MessageTooBig' });
    await sender.sendQueued(1_000);
    expect((await s.log())[0]).toMatchObject({ status: 'failed', ticketError: 'MessageTooBig' });
  });

  it('marks rows for phones without a usable token as not sendable instead of retrying forever', async () => {
    const s = await setup();
    await t.db.update(devices).set({ pushToken: null }).where(eq(devices.userId, s.me.id));
    await s.place(s.doses[0]!.id, 40);
    await sweeper.passB(new Date());
    await sender.sendQueued();
    expect((await s.log())[0]).toMatchObject({ status: 'failed', ticketError: 'not_sendable' });
    expect(transport.sent).toHaveLength(0);
  });

  it('two senders at once never send a row twice', async () => {
    const s = await setup();
    for (let i = 0; i < 3; i++) await s.place(s.doses[i]!.id, 40 + i);
    await sweeper.passB(new Date());
    await t.db.insert(notificationLog).values(Array.from({ length: 30 }, () => ({ kind: 'missed' as const, patientId: s.p.id, deviceId: s.phone.deviceId, doseInstanceId: s.doses[0]!.id, data: { count: 1 } })));
    await Promise.all([sender.sendQueued(), sender.sendQueued(), sender.sendQueued()]);
    const sent = (await s.log()).filter((r) => r.status === 'sent');
    expect(new Set(sent.map((r) => r.expoTicketId)).size).toBe(sent.length);
    expect(transport.sent.length).toBe(sent.length);
  });
});

describe('receipts (05)', () => {
  async function sentRow(minutesAgo: number) {
    const s = await setup();
    await s.place(s.doses[0]!.id, 40);
    await sweeper.passB(new Date());
    await sender.sendQueued();
    await t.db.update(notificationLog).set({ sentAt: ago(minutesAgo) }).where(eq(notificationLog.patientId, s.p.id));
    return s;
  }

  it('does not look at receipts before they are ready (15 minutes)', async () => {
    const s = await sentRow(5);
    expect(await sender.processReceipts()).toBe(0);
    expect((await s.log())[0]!.receiptCheckedAt).toBeNull();
  });

  it('records an ok receipt', async () => {
    const s = await sentRow(20);
    expect(await sender.processReceipts()).toBe(1);
    expect((await s.log())[0]).toMatchObject({ receiptStatus: 'ok', receiptError: null });
    expect((await s.log())[0]!.receiptCheckedAt).toBeTruthy();
    expect(await sender.processReceipts()).toBe(0);
  });

  it('a DeviceNotRegistered receipt drops the token', async () => {
    const s = await sentRow(20);
    transport.receiptFor = () => ({ status: 'error', message: 'gone', error: 'DeviceNotRegistered' });
    await sender.processReceipts();
    expect((await s.log())[0]).toMatchObject({ receiptStatus: 'error', receiptError: 'DeviceNotRegistered' });
    const carer = (await t.db.select().from(devices).where(eq(devices.userId, s.me.id)))[0]!;
    expect(carer.pushToken).toBeNull();
    expect(carer.pushInvalidAt).toBeTruthy();
  });

  it('keeps asking until the receipt exists, then gives up after 24 hours', async () => {
    const s = await sentRow(20);
    transport.receiptFor = () => undefined;
    await sender.processReceipts();
    expect((await s.log())[0]!.receiptCheckedAt).toBeNull();
    await t.db.update(notificationLog).set({ sentAt: ago(25 * 60) }).where(eq(notificationLog.patientId, s.p.id));
    await sender.processReceipts();
    expect((await s.log())[0]).toMatchObject({ receiptStatus: 'expired' });
  });
});

describe('device health (09)', () => {
  const carerRows = async (s: Awaited<ReturnType<typeof setup>>, kind: string) => (await s.log()).filter((r) => r.kind === kind);

  it('alerts the owner once per 12 hours with every problem combined', async () => {
    const s = await setup();
    await t.db.update(devices).set({ lastSeenAt: ago(8 * 60), permExactAlarm: false, scheduledThrough: ago(1) }).where(eq(devices.id, s.phone.deviceId));
    await health.alertUnhealthy(new Date());
    const alerts = await carerRows(s, 'device_health');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.data).toMatchObject({ problems: ['no_heartbeat', 'permission_off', 'window_low'], device_label: 'Pixel 8', device_id: s.phone.deviceId });
    await health.alertUnhealthy(new Date()); // throttled
    expect(await carerRows(s, 'device_health')).toHaveLength(1);
    await t.db.update(notificationLog).set({ createdAt: ago(13 * 60) }).where(and(eq(notificationLog.patientId, s.p.id), eq(notificationLog.kind, 'device_health')));
    await health.alertUnhealthy(new Date()); // 12 hours later
    expect(await carerRows(s, 'device_health')).toHaveLength(2);
  });

  it('a low window also asks the patient’s phone to open the app, at most once per 12 hours (D-093)', async () => {
    const s = await setup();
    await t.db.update(devices).set({ scheduledThrough: ahead(60) }).where(eq(devices.id, s.phone.deviceId));
    await health.alertUnhealthy(new Date());
    await health.alertUnhealthy(new Date());
    const asks = await carerRows(s, 'window_low');
    expect(asks).toHaveLength(1);
    expect(asks[0]!.deviceId).toBe(s.phone.deviceId);
    await sender.sendQueued();
    expect(transport.sent.find((m) => m.data.type === 'window_low')).toMatchObject({ body: 'Open the app to keep reminders on schedule' });
  });

  it('says nothing about healthy phones, suspended patients or revoked phones', async () => {
    const s = await setup();
    await health.alertUnhealthy(new Date());
    expect(await s.log()).toHaveLength(0);
    await t.db.update(devices).set({ permExactAlarm: false }).where(eq(devices.id, s.phone.deviceId));
    await t.db.update(patients).set({ status: 'suspended' }).where(eq(patients.id, s.p.id));
    await health.alertUnhealthy(new Date());
    expect(await s.log()).toHaveLength(0);
    await t.db.update(patients).set({ status: 'active' }).where(eq(patients.id, s.p.id));
    await t.db.update(devices).set({ revokedAt: new Date() }).where(eq(devices.id, s.phone.deviceId));
    await health.alertUnhealthy(new Date());
    expect(await s.log()).toHaveLength(0);
  });

  it('the caregiver’s device list shows the same problems', async () => {
    const s = await setup();
    await t.db.update(devices).set({ permBatteryUnrestricted: false }).where(eq(devices.id, s.phone.deviceId));
    const res = await t.call(s.me, 'get', `/v1/patients/${s.p.id}/devices`);
    expect(res.body.items[0]).toMatchObject({ healthy: false, problems: ['permission_off'] });
    await t.db.update(devices).set({ permBatteryUnrestricted: true }).where(eq(devices.id, s.phone.deviceId));
    expect((await t.call(s.me, 'get', `/v1/patients/${s.p.id}/devices`)).body.items[0]).toMatchObject({ healthy: true, problems: [] });
    expect((await t.call(s.me, 'get', `/v1/patients/${s.p.id}`)).body.devices[0]).toMatchObject({ healthy: true });
  });
});

describe('daily dose generator', () => {
  it('tops up active patients, and skips suspended, archived and lapsed ones', async () => {
    const live = await setup();
    const lapsed = await setup();
    const suspended = await setup();
    await t.db.update(subscriptions).set({ status: 'expired' }).where(eq(subscriptions.userId, lapsed.me.id));
    await t.db.update(patients).set({ status: 'suspended' }).where(eq(patients.id, suspended.p.id));
    await t.db.delete(doseInstances);
    const created = await t.app.get(DoseGeneratorService).generateAll();
    expect(created).toBeGreaterThanOrEqual(13);
    const count = (id: string) => t.db.$count(doseInstances, eq(doseInstances.patientId, id));
    expect(await count(live.p.id)).toBeGreaterThanOrEqual(13);
    expect(await count(lapsed.p.id)).toBe(0);
    expect(await count(suspended.p.id)).toBe(0);
    expect(await t.app.get(DoseGeneratorService).generateAll()).toBe(0); // repeating changes nothing
  });
});

describe('BullMQ wiring (D-071)', () => {
  it('upserts every Job Scheduler idempotently and runs a job end to end', async () => {
    const { Test } = await import('@nestjs/testing');
    const { JobsModule } = await import('./jobs.module.js');
    const { AppModule } = await import('../app.module.js');
    const boot = async () => (await Test.createTestingModule({ imports: [AppModule, PushModule, JobsModule] }).compile()).createNestApplication().init();
    const first = await boot();
    const second = await boot(); // a second worker starting up must not duplicate the schedulers
    const queue = first.get(JobsService).getQueue()!;
    const schedulers = await queue.getJobSchedulers();
    expect(schedulers.map((s) => s.key).sort((a, b) => (a < b ? -1 : 1))).toEqual(SCHEDULERS.map((s) => s.id).sort((a, b) => (a < b ? -1 : 1)));

    const s = await setup();
    await s.place(s.doses[0]!.id, 40);
    await queue.add('sweeper', {});
    const deadline = Date.now() + 15_000;
    let status = 'pending';
    while (status !== 'missed' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      status = (await t.db.select().from(doseInstances).where(eq(doseInstances.id, s.doses[0]!.id)))[0]!.status;
    }
    expect(status).toBe('missed'); // the worker picked the job up and ran the sweeper
    expect(QUEUE_NAME).toBe('med-jobs');
    await first.close();
    await second.close();
    void and;
  }, 60_000);
});
