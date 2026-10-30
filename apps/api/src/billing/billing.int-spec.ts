import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PLAN_PATIENT_LIMIT, type SubscriptionStatus } from '@med/shared';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import request from 'supertest';
import { AppModule } from '../app.module.js';
import { ApiException } from '../common/api-exception.js';
import type { Db } from '../db/client.js';
import { DB } from '../db/database.module.js';
import { patients, subscriptions, users } from '../db/schema.js';
import { resetTestDb, testDatabaseUrl } from '../db/test-db.js';
import { EntitlementsService } from './entitlements.service.js';

let app: INestApplication;
let db: Db;
let redis: Redis;
let entitlements: EntitlementsService;
let n = 0;

const bytes = (s: string) => Buffer.from(s);
async function caregiver(sub: { status: SubscriptionStatus; patientLimit?: number } | null) {
  const [u] = await db.insert(users).values({ email: `bill${++n}-${Date.now()}@example.test`, passwordHash: 'x' }).returning();
  if (sub) {
    await db.insert(subscriptions).values({ userId: u!.id, plan: 'starter', patientLimit: sub.patientLimit ?? 3, status: sub.status, providerRef: u!.id });
  }
  return u!.id;
}
const addPatient = (ownerUserId: string, over: Partial<typeof patients.$inferInsert> = {}) =>
  db.insert(patients).values({ ownerUserId, displayName: bytes('p'), timezone: 'Asia/Kolkata', ...over });
// What POST /v1/patients will do: check the quota and insert in one transaction.
const createManaged = (ownerUserId: string) =>
  db.transaction(async (tx) => {
    await entitlements.assertManagedQuota(tx, ownerUserId);
    await tx.insert(patients).values({ ownerUserId, displayName: bytes('p'), timezone: 'Asia/Kolkata' });
  });
const codeOf = (e: unknown) => (e instanceof ApiException ? e.code : String(e));
const rejection = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => codeOf(e));

beforeAll(async () => {
  const made = await resetTestDb();
  await made.pool.end();
  process.env.DATABASE_URL = testDatabaseUrl();
  process.env.REDIS_URL = process.env.REDIS_URL_TEST!;
  redis = new Redis(process.env.REDIS_URL_TEST!);
  app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
  await app.listen(0);
  db = app.get<Db>(DB);
  entitlements = app.get(EntitlementsService);
});
beforeEach(() => redis.flushdb());
afterAll(async () => {
  await app.close();
  await redis.quit();
});

describe('managed patient quota (D-053)', () => {
  it('allows creates up to the plan limit, then PATIENT_LIMIT_REACHED', async () => {
    const owner = await caregiver({ status: 'active' });
    for (let i = 0; i < PLAN_PATIENT_LIMIT.starter; i++) await createManaged(owner);
    const err = await createManaged(owner).catch((e: unknown) => e as ApiException);
    expect(err).toBeInstanceOf(ApiException);
    expect((err as ApiException).code).toBe('PATIENT_LIMIT_REACHED');
    expect((err as ApiException).details).toEqual({ limit: 3 });
    expect(await db.$count(patients, eq(patients.ownerUserId, owner))).toBe(3);
  });

  it('cannot be raced past the limit by concurrent creates', async () => {
    const owner = await caregiver({ status: 'active' });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => createManaged(owner)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    for (const r of results) if (r.status === 'rejected') expect(codeOf(r.reason)).toBe('PATIENT_LIMIT_REACHED');
    expect(await db.$count(patients, eq(patients.ownerUserId, owner))).toBe(3);
  });

  it('counts only active managed patients: archived, suspended and the self profile do not use a slot', async () => {
    const owner = await caregiver({ status: 'active' });
    await addPatient(owner, { type: 'self' });
    await addPatient(owner, { status: 'archived' });
    await addPatient(owner, { status: 'suspended' });
    await createManaged(owner);
    await createManaged(owner);
    await createManaged(owner);
    expect(await rejection(createManaged(owner))).toBe('PATIENT_LIMIT_REACHED');
  });

  it("is per caregiver: another caregiver's patients never count", async () => {
    const a = await caregiver({ status: 'active' });
    const b = await caregiver({ status: 'active' });
    for (let i = 0; i < 3; i++) await createManaged(a);
    await createManaged(b);
  });

  it('keeps existing patients when the limit drops below the count, but refuses new ones', async () => {
    const owner = await caregiver({ status: 'active' });
    for (let i = 0; i < 3; i++) await createManaged(owner);
    await db.update(subscriptions).set({ patientLimit: 1 }).where(eq(subscriptions.userId, owner));
    expect(await rejection(createManaged(owner))).toBe('PATIENT_LIMIT_REACHED');
    expect(await db.$count(patients, eq(patients.ownerUserId, owner))).toBe(3);
  });
});

describe('subscription status', () => {
  it.each<[SubscriptionStatus | null, boolean]>([
    ['active', true],
    ['store_grace', true],
    ['grace', false],
    ['expired', false],
    [null, false],
  ])('status %s may start a new patient: %s', async (status, allowed) => {
    const owner = await caregiver(status ? { status } : null);
    expect(await rejection(createManaged(owner))).toBe(allowed ? null : 'SUBSCRIPTION_INACTIVE');
  });

  it('the self profile needs an active subscription but ignores the patient limit', async () => {
    const full = await caregiver({ status: 'active' });
    for (let i = 0; i < 3; i++) await createManaged(full);
    await db.transaction((tx) => entitlements.assertSelfProfileAllowed(tx, full));

    const lapsed = await caregiver({ status: 'expired' });
    expect(await rejection(db.transaction((tx) => entitlements.assertSelfProfileAllowed(tx, lapsed)))).toBe('SUBSCRIPTION_INACTIVE');
    const none = await caregiver(null);
    expect(await rejection(db.transaction((tx) => entitlements.assertSelfProfileAllowed(tx, none)))).toBe('SUBSCRIPTION_INACTIVE');
  });
});

describe('GET /v1/subscription', () => {
  const register = () =>
    request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({ email: `sub${++n}-${Date.now()}@example.test`, password: 'correct horse battery', device: { platform: 'android', app_version: '1.0.0' }, consent: { notice_version: '1' } });

  it('needs a signed-in caregiver', async () => {
    expect((await request(app.getHttpServer()).get('/v1/subscription')).status).toBe(401);
  });

  it('returns the caller’s plan, limit and usage', async () => {
    const me = (await register()).body;
    await addPatient(me.user.id);
    await addPatient(me.user.id, { type: 'self' });
    const res = await request(app.getHttpServer()).get('/v1/subscription').set('Authorization', `Bearer ${me.access_token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ plan: 'starter', patient_limit: 3, managed_patients: 1, status: 'active', renews_at: null, expired_at: null, cutoff_at: null });
  });

  it('shows no plan for an account without a subscription', async () => {
    const me = (await register()).body;
    await db.delete(subscriptions).where(eq(subscriptions.userId, me.user.id));
    const res = await request(app.getHttpServer()).get('/v1/subscription').set('Authorization', `Bearer ${me.access_token}`);
    expect(res.body).toMatchObject({ plan: null, patient_limit: 0, status: null });
  });
});

describe('dev Starter stub', () => {
  it('grants Starter at register only when DEV_GRANT_STARTER=true', async () => {
    const was = process.env.DEV_GRANT_STARTER;
    try {
      process.env.DEV_GRANT_STARTER = 'false';
      const off = new EntitlementsService(db);
      const owner = await caregiver(null);
      await db.transaction((tx) => off.grantDevStarter(tx, owner));
      expect(await db.$count(subscriptions, eq(subscriptions.userId, owner))).toBe(0);

      process.env.DEV_GRANT_STARTER = 'true';
      const on = new EntitlementsService(db);
      await db.transaction((tx) => on.grantDevStarter(tx, owner));
      const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.userId, owner));
      expect(sub).toMatchObject({ plan: 'starter', patientLimit: 3, status: 'active' });
    } finally {
      process.env.DEV_GRANT_STARTER = was;
    }
  });

  it('refuses to start in production with the stub on', () => {
    const env = { flag: process.env.DEV_GRANT_STARTER, node: process.env.NODE_ENV };
    try {
      process.env.DEV_GRANT_STARTER = 'true';
      process.env.NODE_ENV = 'production';
      expect(() => new EntitlementsService(db)).toThrow(/must not be set in production/);
    } finally {
      process.env.DEV_GRANT_STARTER = env.flag;
      process.env.NODE_ENV = env.node;
    }
  });
});
