import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { auditLog, devices, doseInstances, medicines, notificationLog, patients, subscriptions } from '../db/schema.js';
import { JobsCoreModule } from '../jobs/jobs.module.js';
import { SweeperService } from '../jobs/sweeper.service.js';
import { PushModule } from '../push/push.module.js';
import { startApp } from '../testing/harness.js';

let t: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  t = await startApp({ imports: [PushModule, JobsCoreModule] });
});
beforeEach(() => t.redis.flushdb());
afterAll(() => t.close());

const schedule = { pattern: 'daily', start_date: '2026-01-01', times: [{ local_time: '08:00', amount_text: '1' }] };
const codeFor = async (owner: Awaited<ReturnType<typeof t.caregiver>>, patientId: string) => (await t.call(owner, 'post', `/v1/patients/${patientId}/transfer-code`)).body.code as string;
const redeem = (who: Awaited<ReturnType<typeof t.caregiver>>, code: string, as_self = false) => t.http().post('/v1/transfers/redeem').set('Authorization', `Bearer ${who.token}`).send({ code, as_self });

async function setup() {
  const from = await t.caregiver();
  const to = await t.caregiver();
  const p = await t.patientOf(from);
  const med = (await t.call(from, 'post', `/v1/patients/${p.id}/medicines`, { name: 'Metformin', schedule })).body;
  const phone = await t.pair(from, p.id);
  return { from, to, p, med, phone };
}

describe('transfer code', () => {
  it('is made by the owner only, in the pairing format, for an active patient', async () => {
    const { from, to, p } = await setup();
    const res = await t.call(from, 'post', `/v1/patients/${p.id}/transfer-code`);
    expect(res.status).toBe(201);
    expect(res.body.code).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    expect(res.body.qr_payload).toBe(`medremind://transfer?c=${res.body.code.replace('-', '')}`);
    expect((await t.call(to, 'post', `/v1/patients/${p.id}/transfer-code`)).status).toBe(404);
    await t.db.update(patients).set({ status: 'suspended' }).where(eq(patients.id, p.id));
    expect((await t.call(from, 'post', `/v1/patients/${p.id}/transfer-code`)).body.error.code).toBe('PATIENT_SUSPENDED');
  });

  it('a new code replaces the old one, and a pairing code is not a transfer code', async () => {
    const { from, to, p } = await setup();
    const first = await codeFor(from, p.id);
    const second = await codeFor(from, p.id);
    expect((await redeem(to, first)).body.error.code).toBe('CODE_EXPIRED_OR_USED');
    const pairing = (await t.call(from, 'post', `/v1/patients/${p.id}/pairing-code`)).body.code as string;
    expect((await redeem(to, pairing)).body.error.code).toBe('CODE_INVALID'); // different kind
    expect((await redeem(to, second)).status).toBe(200);
  });
});

describe('redeem: everything moves intact (D-049)', () => {
  it('hands over medicines, doses, phones and tokens; the old owner loses access at once', async () => {
    const { from, to, p, med, phone } = await setup();
    const doseBefore = (await t.db.select().from(doseInstances).where(eq(doseInstances.patientId, p.id)).orderBy(asc(doseInstances.scheduledAt)))[0]!;
    const res = await redeem(to, await codeFor(from, p.id));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: p.id, display_name: 'Grandma Asha', type: 'managed', status: 'active' });
    expect(res.body.devices).toHaveLength(1);

    for (const path of [`/v1/patients/${p.id}`, `/v1/patients/${p.id}/medicines`, `/v1/medicines/${med.id}`, `/v1/patients/${p.id}/doses`, `/v1/patients/${p.id}/devices`, `/v1/patients/${p.id}/audit-log`]) {
      expect((await t.call(from, 'get', path)).status, path).toBe(404);
      expect((await t.call(to, 'get', path)).status, path).toBe(200);
    }
    expect((await t.call(from, 'patch', `/v1/patients/${p.id}`, { display_name: 'x' })).status).toBe(404);
    expect((await t.call(to, 'get', '/v1/patients')).body.items.map((x: { id: string }) => x.id)).toContain(p.id);
    expect((await t.call(from, 'get', '/v1/patients')).body.items).toHaveLength(0);

    // The patient's phone keeps working, with the same token and the same dose IDs.
    const sync = await t.asDevice(phone.token, 'get', '/v1/device/sync');
    expect(sync.status).toBe(200);
    expect(sync.body.doses.map((d: { id: string }) => d.id)).toContain(doseBefore.id);
    const [dev] = await t.db.select().from(devices).where(eq(devices.id, phone.deviceId));
    expect(dev!.revokedAt).toBeNull();
    expect(await t.db.$count(medicines, eq(medicines.patientId, p.id))).toBe(1);
  });

  it('audits both sides, and the new owner can read it', async () => {
    const { from, to, p } = await setup();
    await redeem(to, await codeFor(from, p.id));
    const rows = await t.db.select().from(auditLog).where(and(eq(auditLog.patientId, p.id), eq(auditLog.action, 'transfer.redeemed')));
    expect(rows.map((r) => (r.meta as { role: string }).role).sort((a, b) => (a < b ? -1 : 1))).toEqual(['receiver', 'sender']);
    expect(rows.find((r) => (r.meta as { role: string }).role === 'sender')!.actorId).toBe(from.id);
    const seen = await t.call(to, 'get', `/v1/patients/${p.id}/audit-log`);
    expect(seen.body.items.map((a: { action: string }) => a.action)).toEqual(expect.arrayContaining(['transfer.code_created', 'transfer.redeemed']));
  });

  it('missed alerts go to the new owner, and existing doses keep their frozen deadlines', async () => {
    const { from, to, p, phone } = await setup();
    await t.call(to, 'patch', '/v1/settings', { default_missed_delay_min: 90 });
    const doses = await t.db.select().from(doseInstances).where(eq(doseInstances.patientId, p.id)).orderBy(asc(doseInstances.scheduledAt));
    const frozen = doses[1]!.alertDueAt.getTime() - doses[1]!.scheduledAt.getTime();
    await t.db.update(doseInstances).set({ scheduledAt: new Date(Date.now() - 60 * 60_000), alertDueAt: new Date(Date.now() - 30 * 60_000) }).where(eq(doseInstances.id, doses[0]!.id));
    await redeem(to, await codeFor(from, p.id));
    await t.app.get(SweeperService).passB(new Date());
    const alerts = await t.db.select().from(notificationLog).where(and(eq(notificationLog.patientId, p.id), eq(notificationLog.kind, 'missed')));
    const toDevice = (await t.db.select().from(devices).where(eq(devices.userId, to.id)))[0]!;
    expect(alerts.map((a) => a.deviceId)).toEqual([toDevice.id]);
    expect((await t.db.select().from(doseInstances).where(eq(doseInstances.id, doses[1]!.id)))[0]!.alertDueAt.getTime() - doses[1]!.scheduledAt.getTime()).toBe(frozen);
    void phone;
  });

  it('cancels a pairing code the old owner made earlier', async () => {
    const { from, to, p } = await setup();
    const pairing = (await t.call(from, 'post', `/v1/patients/${p.id}/pairing-code`)).body.code as string;
    await redeem(to, await codeFor(from, p.id));
    const res = await t.http().post('/v1/pairing/redeem').send({ code: pairing, device: { platform: 'android', app_version: '1', install_id: randomUUID() }, consent: { notice_version: '1' } });
    expect(res.body.error.code).toBe('CODE_EXPIRED_OR_USED');
  });
});

describe('redeem: quota and self profile (D-053, D-092)', () => {
  it('counts against the receiver’s limit, and frees the sender’s slot', async () => {
    const { from, to, p } = await setup();
    for (let i = 0; i < 3; i++) await t.patientOf(to);
    const blocked = await redeem(to, await codeFor(from, p.id));
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('PATIENT_LIMIT_REACHED');
    expect((await t.db.select().from(patients).where(eq(patients.id, p.id)))[0]!.ownerUserId).toBe(from.id);

    await t.call(to, 'post', `/v1/patients/${(await t.call(to, 'get', '/v1/patients')).body.items[0].id}/archive`);
    expect((await redeem(to, await codeFor(from, p.id))).status).toBe(200);
    expect((await t.call(from, 'post', '/v1/patients', { display_name: 'New', type: 'managed', timezone: 'UTC' })).status).toBe(201);
  });

  it('as_self makes it the receiver’s self profile, outside the limit, once', async () => {
    const { from, to, p } = await setup();
    for (let i = 0; i < 3; i++) await t.patientOf(to);
    const res = await redeem(to, await codeFor(from, p.id), true);
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('self');
    const other = await t.patientOf(from);
    const second = await redeem(to, await codeFor(from, other.id), true);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('SELF_PROFILE_EXISTS');
  });

  it('needs an active subscription', async () => {
    const { from, to, p } = await setup();
    await t.db.update(subscriptions).set({ status: 'expired' }).where(eq(subscriptions.userId, to.id));
    expect((await redeem(to, await codeFor(from, p.id))).body.error.code).toBe('SUBSCRIPTION_INACTIVE');
    expect((await t.db.select().from(patients).where(eq(patients.id, p.id)))[0]!.ownerUserId).toBe(from.id);
  });
});

describe('redeem: abuse controls', () => {
  it('refuses your own patient, wrong codes (locking the real one after 5), and bad bodies', async () => {
    const { from, to, p } = await setup();
    const code = await codeFor(from, p.id);
    expect((await redeem(from, code)).body.error.code).toBe('CODE_INVALID');
    const wrong = code.slice(0, 4) + (code.endsWith('2345') ? '6789' : '2345');
    for (let i = 0; i < 5; i++) expect((await redeem(to, wrong)).body.error.code).toBe('CODE_INVALID');
    expect((await redeem(to, code)).body.error.code).toBe('CODE_EXPIRED_OR_USED');
    expect((await t.http().post('/v1/transfers/redeem').set('Authorization', `Bearer ${to.token}`).send({ code })).status).toBe(400); // as_self missing
    expect((await t.http().post('/v1/transfers/redeem').send({ code, as_self: false })).status).toBe(401);
  });

  it('only one of two receivers wins a code', async () => {
    const { from, to, p } = await setup();
    const other = await t.caregiver();
    const code = await codeFor(from, p.id);
    const results = await Promise.all([redeem(to, code), redeem(other, code)]);
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 410]);
  });

  it('rate limits a receiver', async () => {
    const { to } = await setup();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await redeem(to, 'ZZZZ-ZZZZ')).status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(2);
  });
});
