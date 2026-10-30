import { and, eq } from 'drizzle-orm';
import { auditLog, devices, doseInstances, notificationLog, patients, rcWebhookEvents, subscriptions } from '../db/schema.js';
import { JobsCoreModule } from '../jobs/jobs.module.js';
import { SweeperService } from '../jobs/sweeper.service.js';
import { PushModule } from '../push/push.module.js';
import { startApp } from '../testing/harness.js';
import { FakeRevenueCatClient, RevenueCatClient } from './revenuecat/revenuecat-client.js';
import { SubscriptionSyncService } from './revenuecat/subscription-sync.service.js';

const rc = new FakeRevenueCatClient(true);
const AUTH = 'webhook-secret-for-tests';
let t: Awaited<ReturnType<typeof startApp>>;
let sync: SubscriptionSyncService;
beforeAll(async () => {
  process.env.REVENUECAT_WEBHOOK_AUTH = AUTH;
  t = await startApp({ imports: [PushModule, JobsCoreModule], overrides: [[RevenueCatClient, rc]] });
  sync = t.app.get(SubscriptionSyncService);
});
beforeEach(async () => {
  await t.redis.flushdb();
  rc.byUser.clear();
  rc.calls = 0;
});
afterAll(() => t.close());

const entitlement = (expiresInDays = 30) => [{ entitlementId: 'starter', expiresAt: new Date(Date.now() + expiresInDays * 86_400_000) }];
let n = 0;
const event = (userId: string, type: string, over: object = {}) => ({ api_version: '1.0', event: { id: `evt-${++n}-${Date.now()}`, type, app_user_id: userId, environment: 'PRODUCTION', event_timestamp_ms: Date.now(), ...over } });
const post = (body: object, auth: string | null = AUTH) => {
  let r = t.http().post('/v1/webhooks/revenuecat');
  if (auth) r = r.set('Authorization', auth);
  return r.send(body);
};
const sub = async (userId: string) => (await t.db.select().from(subscriptions).where(eq(subscriptions.userId, userId)))[0];
const noSubscription = async () => {
  const me = await t.caregiver();
  await t.db.delete(subscriptions).where(eq(subscriptions.userId, me.id)); // the dev stub gave one; billing decides now
  return me;
};

describe('webhook endpoint', () => {
  it('rejects a missing or wrong Authorization header and records nothing', async () => {
    const me = await t.caregiver();
    for (const auth of [null, 'wrong', AUTH + 'x', '']) expect((await post(event(me.id, 'RENEWAL'), auth)).status).toBe(401);
    expect(await t.db.$count(rcWebhookEvents)).toBe(0);
  });

  it('accepts without an Idempotency-Key, answers 200 at once and records the event once', async () => {
    const me = await t.caregiver();
    const body = event(me.id, 'RENEWAL');
    expect((await post(body)).status).toBe(200);
    expect((await post(body)).status).toBe(200); // RevenueCat retries reuse the event ID
    expect(await t.db.$count(rcWebhookEvents, eq(rcWebhookEvents.eventId, body.event.id))).toBe(1);
    expect(rc.calls).toBe(0); // nothing is fetched on the request path
  });

  it('rejects a malformed body', async () => {
    expect((await post({ event: { type: 'RENEWAL' } })).status).toBe(400);
    expect((await post({})).status).toBe(400);
  });

  it('is closed when no secret is configured', async () => {
    const was = process.env.REVENUECAT_WEBHOOK_AUTH;
    delete process.env.REVENUECAT_WEBHOOK_AUTH;
    try {
      expect((await post(event('x', 'RENEWAL'), '')).status).toBe(401);
      expect((await post(event('x', 'RENEWAL'), 'anything')).status).toBe(401);
    } finally {
      process.env.REVENUECAT_WEBHOOK_AUTH = was;
    }
  });
});

describe('subscription lifecycle from RevenueCat (07)', () => {
  it('a purchase creates the subscription from RevenueCat’s answer, not the event', async () => {
    const me = await noSubscription();
    expect((await t.call(me, 'post', '/v1/patients', { display_name: 'A', type: 'managed', timezone: 'UTC' })).body.error.code).toBe('SUBSCRIPTION_INACTIVE');
    rc.byUser.set(me.id, entitlement());
    await post(event(me.id, 'INITIAL_PURCHASE', { entitlement_ids: ['platinum'], product_id: 'whatever' })); // the body claims otherwise; it is ignored
    await sync.processPending();
    expect(await sub(me.id)).toMatchObject({ plan: 'starter', patientLimit: 3, status: 'active', providerRef: me.id, expiredAt: null, cutoffAt: null });
    expect((await t.call(me, 'post', '/v1/patients', { display_name: 'A', type: 'managed', timezone: 'UTC' })).status).toBe(201);
    expect((await t.db.select().from(rcWebhookEvents))[0]!.processedAt).toBeTruthy();
  });

  it('a billing issue with access still granted is the store’s own grace: reminders and new patients keep working', async () => {
    const me = await noSubscription();
    rc.byUser.set(me.id, entitlement());
    await post(event(me.id, 'BILLING_ISSUE'));
    await sync.processPending();
    expect((await sub(me.id))!.status).toBe('store_grace');
    expect((await t.call(me, 'post', '/v1/patients', { display_name: 'A', type: 'managed', timezone: 'UTC' })).status).toBe(201);
    await post(event(me.id, 'RENEWAL'));
    await sync.processPending();
    expect((await sub(me.id))!.status).toBe('active');
  });

  it('losing access starts the 1-day grace and warns the caregiver once (D-054, D-087)', async () => {
    const me = await noSubscription();
    rc.byUser.set(me.id, entitlement());
    await sync.sync(me.id);
    rc.byUser.set(me.id, []);
    await post(event(me.id, 'EXPIRATION'));
    await sync.processPending();
    const row = (await sub(me.id))!;
    expect(row.status).toBe('grace');
    expect(row.cutoffAt!.getTime() - row.expiredAt!.getTime()).toBe(24 * 3_600_000);
    const carer = (await t.db.select().from(devices).where(eq(devices.userId, me.id)))[0]!;
    const warnings = await t.db.select().from(notificationLog).where(and(eq(notificationLog.deviceId, carer.id), eq(notificationLog.kind, 'billing')));
    expect(warnings.map((w) => w.data)).toEqual([{ event: 'expired' }]);
    await post(event(me.id, 'EXPIRATION'));
    await sync.processPending();
    expect((await sub(me.id))!.cutoffAt).toEqual(row.cutoffAt); // not restarted
    expect(await t.db.$count(notificationLog, and(eq(notificationLog.deviceId, carer.id), eq(notificationLog.kind, 'billing')))).toBe(1);
    expect((await t.call(me, 'post', '/v1/patients', { display_name: 'B', type: 'managed', timezone: 'UTC' })).body.error.code).toBe('SUBSCRIPTION_INACTIVE');
  });

  it('a renewal in grace ends it', async () => {
    const me = await noSubscription();
    rc.byUser.set(me.id, entitlement());
    await sync.sync(me.id);
    rc.byUser.set(me.id, []);
    await sync.sync(me.id);
    rc.byUser.set(me.id, entitlement());
    await post(event(me.id, 'RENEWAL'));
    await sync.processPending();
    expect(await sub(me.id)).toMatchObject({ status: 'active', expiredAt: null, cutoffAt: null });
  });

  it('a renewal after the cutoff restores patients, rebuilds doses and tells their phones to re-sync', async () => {
    const me = await t.caregiver();
    rc.byUser.set(me.id, entitlement());
    await sync.sync(me.id);
    const p = await t.patientOf(me);
    await t.call(me, 'post', `/v1/patients/${p.id}/medicines`, { name: 'Metformin', schedule: { pattern: 'daily', start_date: '2026-01-01', times: [{ local_time: '08:00', amount_text: '1' }] } });
    const phone = await t.pair(me, p.id);
    rc.byUser.set(me.id, []);
    await sync.sync(me.id);
    await t.db.update(subscriptions).set({ cutoffAt: new Date(Date.now() - 1000) }).where(eq(subscriptions.userId, me.id));
    await t.app.get(SweeperService).passC(new Date());
    expect((await t.db.select().from(patients).where(eq(patients.id, p.id)))[0]!.status).toBe('suspended');
    await t.db.delete(doseInstances).where(eq(doseInstances.patientId, p.id)); // nothing was issued while suspended
    await t.db.delete(notificationLog);

    rc.byUser.set(me.id, entitlement());
    await post(event(me.id, 'RENEWAL'));
    await sync.processPending();
    expect((await t.db.select().from(patients).where(eq(patients.id, p.id)))[0]!.status).toBe('active');
    expect(await t.db.$count(doseInstances, eq(doseInstances.patientId, p.id))).toBeGreaterThanOrEqual(13);
    const syncs = await t.db.select().from(notificationLog).where(and(eq(notificationLog.deviceId, phone.deviceId), eq(notificationLog.kind, 'sync')));
    expect(syncs.map((s) => s.data)).toContainEqual({ command: 'sync' });
    expect((await t.db.select().from(auditLog).where(eq(auditLog.action, 'billing.restored'))).length).toBeGreaterThanOrEqual(1);
    expect((await t.asDevice(phone.token, 'get', '/v1/device/sync')).body.account_state).toBe('active');
  });

  it('converges whatever order duplicate and stale events arrive in', async () => {
    const me = await noSubscription();
    rc.byUser.set(me.id, entitlement());
    // RevenueCat's current truth is "active". Stale-looking events arrive afterwards, in a jumble, twice.
    const events = [event(me.id, 'EXPIRATION'), event(me.id, 'RENEWAL'), event(me.id, 'CANCELLATION'), event(me.id, 'INITIAL_PURCHASE')];
    for (const e of [...events.reverse(), ...events]) await post(e);
    await sync.processPending();
    expect(await sub(me.id)).toMatchObject({ status: 'active', plan: 'starter' });
  });

  it('matches the user by alias, ignores unknown users and events it does not handle', async () => {
    const me = await noSubscription();
    rc.byUser.set(me.id, entitlement());
    await post(event('$RCAnonymousID:abc', 'RENEWAL', { aliases: ['$RCAnonymousID:abc', me.id] }));
    await post(event('11111111-1111-4111-8111-111111111111', 'RENEWAL'));
    await post(event(me.id, 'TEST'));
    await sync.processPending();
    expect((await sub(me.id))!.status).toBe('active');
    expect(await t.db.$count(rcWebhookEvents, eq(rcWebhookEvents.processedAt, rcWebhookEvents.processedAt))).toBeGreaterThanOrEqual(3);
  });

  it('treats a temporary entitlement grant like access, and ignores sandbox purchases in production', async () => {
    const me = await noSubscription();
    rc.byUser.set(me.id, entitlement(1));
    await post(event(me.id, 'TEMPORARY_ENTITLEMENT_GRANT'));
    await sync.processPending();
    expect((await sub(me.id))!.status).toBe('active');

    const other = await noSubscription();
    rc.byUser.set(other.id, entitlement());
    const was = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await post(event(other.id, 'INITIAL_PURCHASE', { environment: 'SANDBOX' }));
      await sync.processPending();
    } finally {
      process.env.NODE_ENV = was;
    }
    expect(await sub(other.id)).toBeUndefined();
  });

  it('an entitlement it does not know changes nothing', async () => {
    const me = await noSubscription();
    rc.byUser.set(me.id, [{ entitlementId: 'platinum-unknown', expiresAt: null }]);
    await sync.sync(me.id);
    expect(await sub(me.id)).toBeUndefined();
  });

  it('a failing RevenueCat call leaves the event unprocessed for the next run', async () => {
    const me = await noSubscription();
    const failing = vi.spyOn(rc, 'activeEntitlements').mockRejectedValueOnce(new Error('RevenueCat 503'));
    await post(event(me.id, 'RENEWAL'));
    await sync.processPending();
    expect((await t.db.select().from(rcWebhookEvents).where(eq(rcWebhookEvents.appUserId, me.id)))[0]!.processedAt).toBeNull();
    failing.mockRestore();
    rc.byUser.set(me.id, entitlement());
    await sync.processPending();
    expect((await sub(me.id))!.status).toBe('active');
  });
});

describe('POST /v1/subscription/refresh', () => {
  it('re-reads RevenueCat after a purchase and returns the subscription', async () => {
    const me = await noSubscription();
    rc.byUser.set(me.id, entitlement());
    const res = await t.call(me, 'post', '/v1/subscription/refresh');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ plan: 'starter', patient_limit: 3, status: 'active', managed_patients: 0 });
    expect(res.body.renews_at).toBeTruthy();
    expect((await t.http().post('/v1/subscription/refresh')).status).toBe(401);
  });

  it('only ever looks up the caller', async () => {
    const a = await noSubscription();
    const b = await noSubscription();
    rc.byUser.set(b.id, entitlement());
    await t.call(a, 'post', '/v1/subscription/refresh');
    expect(await sub(b.id)).toBeUndefined();
  });
});

describe('daily reconciliation (07)', () => {
  it('fixes drift the webhooks missed, and leaves correct accounts alone', async () => {
    const lapsed = await noSubscription();
    const fine = await noSubscription();
    for (const u of [lapsed, fine]) {
      rc.byUser.set(u.id, entitlement());
      await sync.sync(u.id);
    }
    rc.byUser.set(lapsed.id, []); // expired in RevenueCat; the webhook never arrived
    const out = await sync.reconcile(0);
    expect(out.fixed).toBeGreaterThanOrEqual(1);
    expect((await sub(lapsed.id))!.status).toBe('grace');
    expect((await sub(fine.id))!.status).toBe('active');
    expect(await sync.reconcile(0)).toMatchObject({ fixed: 0 });
  });

  it('does nothing without RevenueCat configured', async () => {
    const off = new SubscriptionSyncService(t.db, new FakeRevenueCatClient(false), t.app.get((await import('../doses/doses.service.js')).DosesService), t.app.get((await import('../audit/audit.service.js')).AuditService));
    expect(await off.reconcile(0)).toEqual({ checked: 0, fixed: 0 });
    const me = await t.caregiver();
    expect(await off.sync(me.id)).toBe(false);
    expect((await sub(me.id))!.status).toBe('active'); // the dev Starter stub survives
  });
});
