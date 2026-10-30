import { randomBytes, randomUUID } from 'node:crypto';
import { Body, Controller, Delete, Get, HttpCode, Module, Post, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { ApiException } from '../common/api-exception.js';
import { ApiExceptionFilter } from '../common/api-exception.filter.js';
import { CryptoModule } from '../crypto/crypto.module.js';
import { DatabaseModule } from '../db/database.module.js';
import type { Db } from '../db/client.js';
import { DB } from '../db/database.module.js';
import { idempotencyKeys } from '../db/schema.js';
import { resetTestDb, testDatabaseUrl } from '../db/test-db.js';
import { IdempotencyModule } from './idempotency.module.js';
import { SkipIdempotency } from './skip-idempotency.decorator.js';

const calls = { n: 0 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Controller('v1/test')
class TestController {
  @Post('echo')
  echo(@Body() body: unknown) {
    return { call: ++calls.n, name: (body as { name?: string }).name };
  }
  @Post('slow')
  async slow() {
    await sleep(400);
    return { call: ++calls.n };
  }
  @Post('limit')
  limit() {
    ++calls.n;
    throw new ApiException('PATIENT_LIMIT_REACHED', 'Your plan allows 3 patients.', { limit: 3 });
  }
  @Post('boom')
  boom() {
    ++calls.n;
    throw new Error('database exploded');
  }
  @Post('rate')
  rate() {
    ++calls.n;
    throw new ApiException('RATE_LIMITED', 'Slow down.', {}, 5);
  }
  @Post('open')
  @SkipIdempotency()
  open() {
    return { call: ++calls.n };
  }
  @Delete('item')
  @HttpCode(204)
  remove() {
    ++calls.n;
  }
  @Get('read')
  read() {
    return { call: ++calls.n };
  }
}

@Module({ imports: [DatabaseModule, CryptoModule, IdempotencyModule], controllers: [TestController] })
class TestAppModule {}

let app: INestApplication;
let db: Db;
const A = randomUUID();
const B = randomUUID();

beforeAll(async () => {
  const made = await resetTestDb();
  await made.pool.end();
  process.env.DATABASE_URL = testDatabaseUrl();
  process.env.HMAC_PEPPER ??= randomBytes(32).toString('base64');
  const module = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
  app = module.createNestApplication();
  app.useGlobalFilters(new ApiExceptionFilter());
  // Stand-in for the auth guards: the caller's ID arrives in a header.
  app.use((req: { headers: Record<string, string>; principal?: unknown }, _res: unknown, next: () => void) => {
    const id = req.headers['x-principal'];
    if (id) req.principal = { type: 'caregiver', id };
    next();
  });
  await app.init();
  db = app.get<Db>(DB);
});
beforeEach(async () => {
  calls.n = 0;
  await db.delete(idempotencyKeys);
});
afterAll(() => app.close());

const post = (path: string, key: string | null, body: object = {}, principal: string | null = A) => {
  let r = request(app.getHttpServer()).post(`/v1/test/${path}`).send(body);
  if (key) r = r.set('Idempotency-Key', key);
  if (principal) r = r.set('X-Principal', principal);
  return r;
};

describe('Idempotency-Key', () => {
  it('requires a UUID key on writes', async () => {
    for (const key of [null, 'not-a-uuid']) {
      const res = await post('echo', key);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.details.fields).toHaveProperty('Idempotency-Key');
    }
    expect(calls.n).toBe(0);
  });

  it('runs the handler once and replays the same response for an identical retry', async () => {
    const key = randomUUID();
    const first = await post('echo', key, { name: 'Metformin' });
    const second = await post('echo', key, { name: 'Metformin' });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(calls.n).toBe(1);
  });

  it('treats reordered JSON keys as the same request', async () => {
    const key = randomUUID();
    await post('echo', key, { a: 1, b: { c: 2, d: 3 } });
    const again = await post('echo', key, { b: { d: 3, c: 2 }, a: 1 });
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(calls.n).toBe(1);
  });

  it('refuses the same key with a different body or route (409 IDEMPOTENCY_KEY_REUSED)', async () => {
    const key = randomUUID();
    await post('echo', key, { name: 'a' });
    const changed = await post('echo', key, { name: 'b' });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const otherRoute = await post('slow', key, { name: 'a' });
    expect(otherRoute.status).toBe(409);
    expect(calls.n).toBe(1);
  });

  it('keeps keys separate per principal', async () => {
    const key = randomUUID();
    const a = await post('echo', key, { name: 'x' }, A);
    const b = await post('echo', key, { name: 'x' }, B);
    expect(a.body.call).toBe(1);
    expect(b.body.call).toBe(2);
    expect(b.headers['idempotent-replayed']).toBeUndefined();
  });

  it('runs the handler once when identical requests arrive together', async () => {
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 6 }, () => post('slow', key)));
    expect(calls.n).toBe(1);
    const ok = results.filter((r) => r.status === 201);
    const busy = results.filter((r) => r.status === 409);
    expect(ok.length).toBe(1);
    expect(busy.length).toBe(5);
    for (const r of busy) {
      expect(r.body.error.code).toBe('REQUEST_IN_PROGRESS');
      expect(r.headers['retry-after']).toBe('1');
    }
    // After it finished, a retry gets the stored response.
    const replay = await post('slow', key);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(ok[0]!.body);
    expect(calls.n).toBe(1);
  });

  it('stores expected client errors and replays them', async () => {
    const key = randomUUID();
    const first = await post('limit', key);
    const second = await post('limit', key);
    expect(first.status).toBe(409);
    expect(second.status).toBe(409);
    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(calls.n).toBe(1);
  });

  it('does not store server errors or rate limits: the same key can retry', async () => {
    for (const path of ['boom', 'rate']) {
      const key = randomUUID();
      await post(path, key);
      await post(path, key);
    }
    expect(calls.n).toBe(4);
    expect(await db.$count(idempotencyKeys)).toBe(0);
  });

  it('keeps response bodies out of the database in plaintext', async () => {
    const key = randomUUID();
    await post('echo', key, { name: 'Metformin-SECRET' });
    const rows = await db.select().from(idempotencyKeys);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.statusCode).toBe(201);
    expect(JSON.stringify(rows[0])).not.toContain('Metformin-SECRET');
  });

  it('handles 204 responses and leaves reads alone', async () => {
    const key = randomUUID();
    const del = () => request(app.getHttpServer()).delete('/v1/test/item').set('Idempotency-Key', key).set('X-Principal', A);
    expect((await del()).status).toBe(204);
    const again = await del();
    expect(again.status).toBe(204);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(calls.n).toBe(1);
    expect((await request(app.getHttpServer()).get('/v1/test/read')).status).toBe(200);
  });

  it('lets @SkipIdempotency routes through with no key and no principal', async () => {
    const res = await post('open', null, {}, null);
    expect(res.status).toBe(201);
  });

  it('fails closed when a write has no principal', async () => {
    const res = await post('echo', randomUUID(), {}, null);
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL');
    expect(calls.n).toBe(0);
  });

  it('forgets keys after 24 hours and re-runs the request', async () => {
    const key = randomUUID();
    await post('echo', key);
    await db.update(idempotencyKeys).set({ createdAt: sql`now() - interval '25 hours'` });
    const res = await post('echo', key);
    expect(res.headers['idempotent-replayed']).toBeUndefined();
    expect(calls.n).toBe(2);
  });

  it('takes over a claim abandoned by a crashed request', async () => {
    const key = randomUUID();
    await post('slow', key); // completes; now fake a crash: result missing and claim old
    await db.update(idempotencyKeys).set({ statusCode: null, responseBody: null, createdAt: sql`now() - interval '2 minutes'` });
    const res = await post('slow', key);
    expect(res.status).toBe(201);
    expect(calls.n).toBe(2);
  });
});
