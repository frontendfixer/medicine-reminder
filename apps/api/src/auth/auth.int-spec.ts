import { Controller, Get, Req, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { and, eq, isNull } from 'drizzle-orm';
import { Redis } from 'ioredis';
import request from 'supertest';
import { AppModule } from '../app.module.js';
import type { AuthedRequest } from '../common/principal.js';
import type { Db } from '../db/client.js';
import { DB } from '../db/database.module.js';
import { authSessions, caregiverSettings, consents, devices, users } from '../db/schema.js';
import { resetTestDb, testDatabaseUrl } from '../db/test-db.js';
import { PasswordService } from './password.service.js';
import { FREE_ATTEMPTS } from './login-throttle.js';

@Controller('v1/test')
class WhoAmIController {
  @Get('whoami')
  whoami(@Req() req: AuthedRequest) {
    return req.principal;
  }
}

const PASSWORD = 'correct horse battery';
const phone = (label: string) => ({ platform: 'android', app_version: '1.0.0', label, tz: 'Asia/Kolkata' });

let app: INestApplication;
let db: Db;
let redis: Redis;
let n = 0;
const nextEmail = () => `caregiver${++n}-${Date.now()}@example.test`;

const http = () => request(app.getHttpServer());
const register = (email = nextEmail(), over: object = {}) =>
  http().post('/v1/auth/register').send({ email, password: PASSWORD, device: phone('Pixel 8'), consent: { notice_version: '2026-10' }, ...over });
const login = (email: string, password = PASSWORD, label = 'Galaxy S24') =>
  http().post('/v1/auth/login').send({ email, password, device: phone(label) });
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  const made = await resetTestDb();
  await made.pool.end();
  process.env.DATABASE_URL = testDatabaseUrl();
  process.env.REDIS_URL = process.env.REDIS_URL_TEST!;
  redis = new Redis(process.env.REDIS_URL_TEST!);
  const module = await Test.createTestingModule({ imports: [AppModule], controllers: [WhoAmIController] }).compile();
  app = module.createNestApplication();
  await app.listen(0); // bind once so supertest doesn't rebind per request
  db = app.get<Db>(DB);
});
beforeEach(() => redis.flushdb());
afterAll(async () => {
  await app.close();
  await redis.quit();
});

describe('register', () => {
  it('creates the account with defaults, consent, one device and one session', async () => {
    const email = nextEmail();
    const res = await register(email);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ user: { email }, session_replaced_previous: false });
    expect(res.body.access_token).toBeTruthy();
    expect(res.body.refresh_token).toBeTruthy();

    const [user] = await db.select().from(users).where(eq(users.email, email));
    expect(user!.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user!.passwordHash).not.toContain(PASSWORD);
    const [settings] = await db.select().from(caregiverSettings).where(eq(caregiverSettings.userId, user!.id));
    expect(settings).toMatchObject({ defaultMissedDelayMin: 30, lockscreenDetail: 'full', dailySummary: false });
    const [consent] = await db.select().from(consents).where(eq(consents.userId, user!.id));
    expect(consent).toMatchObject({ subjectType: 'caregiver', kind: 'signup', noticeVersion: '2026-10' });
    const activeDevices = await db.select().from(devices).where(and(eq(devices.userId, user!.id), isNull(devices.revokedAt)));
    expect(activeDevices).toHaveLength(1);
    expect(activeDevices[0]).toMatchObject({ platform: 'android', label: 'Pixel 8' });
  });

  it('works without an Idempotency-Key (auth/* is exempt)', async () => {
    expect((await register()).status).toBe(201);
  });

  it('stores only a hash of the refresh token', async () => {
    const res = await register();
    const rows = await db.select({ refreshHash: authSessions.refreshHash }).from(authSessions);
    expect(rows.map((r) => r.refreshHash)).not.toContain(res.body.refresh_token);
  });

  it('normalises the email and refuses a duplicate with EMAIL_TAKEN', async () => {
    const email = nextEmail();
    await register(`  ${email.toUpperCase()}  `);
    const again = await register(email);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('EMAIL_TAKEN');
    expect(await db.$count(users, eq(users.email, email))).toBe(1);
  });

  it('only one of two simultaneous registrations for an email wins', async () => {
    const email = nextEmail();
    const [a, b] = await Promise.all([register(email), register(email)]);
    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([201, 409]);
  });

  it('rejects a bad body with field names but never echoes the password', async () => {
    const res = await register('not-an-email', { password: 'short', consent: undefined });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(Object.keys(res.body.error.details.fields).sort()).toEqual(['consent', 'email', 'password']);
    expect(JSON.stringify(res.body)).not.toContain('short');
  });

  it('limits registrations per IP', async () => {
    for (let i = 0; i < 10; i++) expect((await register()).status).toBe(201);
    const res = await register();
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('login', () => {
  it('signs in with the right password', async () => {
    const email = nextEmail();
    await register(email);
    const res = await login(email);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(email);
  });

  it('gives an identical answer for a wrong password and an unknown email, doing the same work', async () => {
    const email = nextEmail();
    await register(email);
    const passwords = app.get(PasswordService);
    const verify = vi.spyOn(passwords, 'verify');
    const verifyUnknown = vi.spyOn(passwords, 'verifyUnknown');

    const wrong = await login(email, 'not the password');
    const unknown = await login(nextEmail(), 'not the password');

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    // Both requests ran one Argon2 verification; the unknown email ran it against a dummy hash.
    expect(verifyUnknown).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it('delays after repeated failures, even for the right password, and the same for unknown emails', async () => {
    const real = nextEmail();
    const ghost = nextEmail();
    await register(real);
    for (const email of [real, ghost]) {
      for (let i = 0; i < FREE_ATTEMPTS; i++) expect((await login(email, 'wrong password')).status).toBe(401);
      const blocked = await login(email, email === real ? PASSWORD : 'wrong password');
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('RATE_LIMITED');
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    }
  });

  it('resets the count after a successful sign-in', async () => {
    const email = nextEmail();
    await register(email);
    for (let i = 0; i < FREE_ATTEMPTS - 2; i++) await login(email, 'wrong password');
    expect((await login(email)).status).toBe(200);
    for (let i = 0; i < FREE_ATTEMPTS - 1; i++) expect((await login(email, 'wrong password')).status).toBe(401);
    expect((await login(email)).status).toBe(200);
  });

  it('lets only a few of many parallel guesses through', async () => {
    const email = nextEmail();
    await register(email);
    const results = await Promise.all(Array.from({ length: 12 }, () => login(email, 'wrong password')));
    expect(results.filter((r) => r.status === 401).length).toBeLessThanOrEqual(FREE_ATTEMPTS);
    expect(results.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(12 - FREE_ATTEMPTS);
  });

  it('limits sign-in attempts per IP across accounts', async () => {
    let limited = 0;
    for (let i = 0; i < 32; i++) if ((await login(nextEmail(), 'x')).status === 429) limited++;
    expect(limited).toBeGreaterThanOrEqual(2);
  });
});

describe('one active login (D-019)', () => {
  it('signing in on a second phone replaces the first everywhere', async () => {
    const email = nextEmail();
    const first = (await register(email)).body;
    const second = await login(email);
    expect(second.body.session_replaced_previous).toBe(true);

    const oldAccess = await http().get('/v1/test/whoami').set(bearer(first.access_token));
    expect(oldAccess.status).toBe(401);
    expect(oldAccess.body.error.code).toBe('SESSION_REPLACED');
    const oldRefresh = await http().post('/v1/auth/refresh').send({ refresh_token: first.refresh_token });
    expect(oldRefresh.status).toBe(401);
    expect(oldRefresh.body.error.code).toBe('SESSION_REPLACED');

    expect((await http().get('/v1/test/whoami').set(bearer(second.body.access_token))).status).toBe(200);
    const user = (await db.select().from(users).where(eq(users.email, email)))[0]!;
    expect(await db.$count(authSessions, and(eq(authSessions.userId, user.id), isNull(authSessions.revokedAt)))).toBe(1);
    expect(await db.$count(devices, and(eq(devices.userId, user.id), isNull(devices.revokedAt)))).toBe(1);
  });

  it('keeps exactly one active session when two phones sign in at the same moment', async () => {
    const email = nextEmail();
    await register(email);
    const results = await Promise.all([login(email, PASSWORD, 'A'), login(email, PASSWORD, 'B'), login(email, PASSWORD, 'C')]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    const user = (await db.select().from(users).where(eq(users.email, email)))[0]!;
    expect(await db.$count(authSessions, and(eq(authSessions.userId, user.id), isNull(authSessions.revokedAt)))).toBe(1);
    expect(await db.$count(devices, and(eq(devices.userId, user.id), isNull(devices.revokedAt)))).toBe(1);
  });
});

describe('access tokens', () => {
  it('rejects missing, malformed, forged, wrong-algorithm and expired tokens', async () => {
    const me = (await register()).body;
    const jwt = app.get(JwtService);
    const claims = { sub: me.user.id, sid: (await db.select().from(authSessions))[0]!.id };
    const forged = await jwt.signAsync(claims, { secret: 'x'.repeat(44), algorithm: 'HS256', issuer: 'medicine-reminder-api', audience: 'medicine-reminder-app' });
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.`;
    const expired = await jwt.signAsync(claims, {
      secret: process.env.JWT_ACCESS_SECRET!,
      algorithm: 'HS256',
      issuer: 'medicine-reminder-api',
      audience: 'medicine-reminder-app',
      expiresIn: -10,
    });
    const wrongAudience = await jwt.signAsync(claims, { secret: process.env.JWT_ACCESS_SECRET!, algorithm: 'HS256', expiresIn: 60 });

    const attempts: Array<Record<string, string>> = [{}, { Authorization: 'Bearer' }, { Authorization: 'Basic abc' }, bearer('garbage'), bearer(forged), bearer(none), bearer(expired), bearer(wrongAudience)];
    for (const headers of attempts) {
      const res = await http().get('/v1/test/whoami').set(headers);
      expect(res.status, JSON.stringify(headers)).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    }
    expect((await http().get('/v1/test/whoami').set(bearer(me.access_token))).body).toMatchObject({ type: 'caregiver', id: me.user.id });
  });

  it('refuses a token for another user\'s session', async () => {
    const a = (await register()).body;
    const b = (await register()).body;
    const jwt = app.get(JwtService);
    const sessionOfA = (await db.select().from(authSessions).where(eq(authSessions.userId, a.user.id)))[0]!.id;
    const mixed = await jwt.signAsync({ sub: b.user.id, sid: sessionOfA }, { secret: process.env.JWT_ACCESS_SECRET!, algorithm: 'HS256', issuer: 'medicine-reminder-api', audience: 'medicine-reminder-app', expiresIn: 60 });
    expect((await http().get('/v1/test/whoami').set(bearer(mixed))).status).toBe(401);
  });

  it('is deny-by-default: only the hello route and auth entry points are public', async () => {
    expect((await http().get('/')).status).toBe(200);
    expect((await http().post('/v1/auth/logout')).status).toBe(401);
  });
});

describe('refresh', () => {
  it('rotates the refresh token: the old one stops working', async () => {
    const first = (await register()).body;
    const rotated = await http().post('/v1/auth/refresh').send({ refresh_token: first.refresh_token });
    expect(rotated.status).toBe(200);
    expect(rotated.body.refresh_token).not.toBe(first.refresh_token);
    expect((await http().get('/v1/test/whoami').set(bearer(rotated.body.access_token))).status).toBe(200);

    const reused = await http().post('/v1/auth/refresh').send({ refresh_token: first.refresh_token });
    expect(reused.status).toBe(401);
    expect(reused.body.error.code).toBe('UNAUTHENTICATED');
    expect((await http().post('/v1/auth/refresh').send({ refresh_token: rotated.body.refresh_token })).status).toBe(200);
  });

  it('only one of two simultaneous refreshes with the same token wins', async () => {
    const first = (await register()).body;
    const results = await Promise.all([1, 2, 3].map(() => http().post('/v1/auth/refresh').send({ refresh_token: first.refresh_token })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });

  it('rejects unknown tokens, an unused session after 90 days, and a bad body', async () => {
    expect((await http().post('/v1/auth/refresh').send({ refresh_token: 'nope' })).status).toBe(401);
    expect((await http().post('/v1/auth/refresh').send({})).status).toBe(400);
    const first = (await register()).body;
    await db.update(authSessions).set({ lastUsedAt: new Date(Date.now() - 91 * 86_400_000) });
    expect((await http().post('/v1/auth/refresh').send({ refresh_token: first.refresh_token })).status).toBe(401);
  });
});

describe('logout', () => {
  it('ends the session and revokes the phone, without claiming it was replaced', async () => {
    const me = (await register()).body;
    expect((await http().post('/v1/auth/logout').set(bearer(me.access_token))).status).toBe(204);

    const access = await http().get('/v1/test/whoami').set(bearer(me.access_token));
    expect(access.status).toBe(401);
    expect(access.body.error.code).toBe('UNAUTHENTICATED');
    const refresh = await http().post('/v1/auth/refresh').send({ refresh_token: me.refresh_token });
    expect(refresh.body.error.code).toBe('UNAUTHENTICATED');
    expect(await db.$count(devices, and(eq(devices.userId, me.user.id), isNull(devices.revokedAt)))).toBe(0);
    expect((await login((await db.select().from(users).where(eq(users.id, me.user.id)))[0]!.email)).status).toBe(200);
  });
});
