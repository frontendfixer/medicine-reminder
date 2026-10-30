// Shared setup for integration specs: the real AppModule against the test Postgres and Redis.
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Redis } from 'ioredis';
import request from 'supertest';
import { AppModule } from '../app.module.js';
import type { Db } from '../db/client.js';
import { DB } from '../db/database.module.js';
import { resetTestDb, testDatabaseUrl } from '../db/test-db.js';

export type Caregiver = { id: string; token: string; email: string };
type Method = 'get' | 'post' | 'patch' | 'delete';

export async function startApp(extra: { controllers?: unknown[] } = {}) {
  const made = await resetTestDb();
  await made.pool.end();
  process.env.DATABASE_URL = testDatabaseUrl();
  process.env.REDIS_URL = process.env.REDIS_URL_TEST!;
  const redis = new Redis(process.env.REDIS_URL_TEST!);
  const app: INestApplication = (await Test.createTestingModule({ imports: [AppModule], controllers: (extra.controllers ?? []) as never[] }).compile()).createNestApplication();
  await app.listen(0);
  const db = app.get<Db>(DB);
  const http = () => request(app.getHttpServer());
  let n = 0;

  const caregiver = async (): Promise<Caregiver> => {
    const email = `h${++n}-${Date.now()}@example.test`;
    const res = await http().post('/v1/auth/register').send({ email, password: 'correct horse battery', device: { platform: 'android', app_version: '1.0.0' }, consent: { notice_version: '1' } });
    return { id: res.body.user.id, token: res.body.access_token, email };
  };
  // A caregiver request with a fresh Idempotency-Key on writes.
  const call = (who: Caregiver, method: Method, path: string, body?: object, key: string | null = randomUUID()) => {
    let r = http()[method](path).set('Authorization', `Bearer ${who.token}`);
    if (method !== 'get' && key) r = r.set('Idempotency-Key', key);
    return body ? r.send(body) : r;
  };
  const patientOf = async (who: Caregiver, over: object = {}) =>
    (await call(who, 'post', '/v1/patients', { display_name: 'Grandma Asha', type: 'managed', timezone: 'Asia/Kolkata', ...over })).body as { id: string };
  const pair = async (who: Caregiver, patientId: string, over: object = {}) => {
    const code = (await call(who, 'post', `/v1/patients/${patientId}/pairing-code`)).body.code as string;
    const res = await http()
      .post('/v1/pairing/redeem')
      .send({ code, device: { platform: 'android', app_version: '1.0.0', label: 'Pixel 8', tz: 'Asia/Kolkata', install_id: randomUUID(), ...over }, consent: { notice_version: '1' } });
    return { token: res.body.device_token as string, deviceId: res.body.device_id as string };
  };
  const asDevice = (token: string, method: Method, path: string) => http()[method](path).set('Authorization', `Device ${token}`);
  const close = async () => {
    await app.close();
    await redis.quit();
  };
  return { app, db, redis, http, caregiver, call, patientOf, pair, asDevice, close };
}
