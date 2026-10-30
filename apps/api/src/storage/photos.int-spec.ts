import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { auditLog, medicines } from '../db/schema.js';
import { startApp } from '../testing/harness.js';
import { MemoryObjectStorage } from './memory-object-storage.js';
import { ObjectStorage } from './object-storage.js';
import { MAX_PHOTO_BYTES } from './photos.service.js';

let t: Awaited<ReturnType<typeof startApp>>;
let store: MemoryObjectStorage;
beforeAll(async () => {
  t = await startApp();
  store = t.app.get(ObjectStorage) as MemoryObjectStorage;
});
beforeEach(() => t.redis.flushdb());
afterAll(() => t.close());

const segment = (marker: number, payload: Buffer) => Buffer.concat([Buffer.from([0xff, marker]), Buffer.from([(payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
const cleanJpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8]), segment(0xe0, Buffer.concat([Buffer.from('JFIF\0'), Buffer.alloc(9)])), Buffer.from([0xff, 0xda, 0, 2]), Buffer.alloc(100)]);
const exifJpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8]), segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0'), Buffer.alloc(30)])), Buffer.from([0xff, 0xda, 0, 2]), Buffer.alloc(100)]);
const medicine = (photo_object_key?: string | null) => ({ name: 'Metformin', schedule: { pattern: 'daily', start_date: '2026-01-01', times: [{ local_time: '08:00', amount_text: '1' }] }, ...(photo_object_key !== undefined ? { photo_object_key } : {}) });
async function setup() {
  const me = await t.caregiver();
  const p = await t.patientOf(me);
  const presign = async (over: object = {}) => t.call(me, 'post', '/v1/uploads/presign', { patient_id: p.id, content_type: 'image/jpeg', byte_size: 50_000, ...over });
  return { me, p, presign };
}

describe('POST /v1/uploads/presign', () => {
  it('returns a key under the patient, a PUT URL and the signed Content-Type', async () => {
    const { p, presign } = await setup();
    const res = await presign();
    expect(res.status).toBe(200);
    expect(res.body.object_key).toMatch(new RegExp(`^p/${p.id}/m/[0-9a-f-]{36}\\.jpg$`));
    expect(res.body.upload_url).toContain(res.body.object_key);
    expect(res.body.headers).toEqual({ 'Content-Type': 'image/jpeg' });
    expect(new Date(res.body.expires_at).getTime()).toBeGreaterThan(Date.now());
    expect(Object.keys(res.body).sort()).toEqual(['expires_at', 'headers', 'object_key', 'upload_url']);
  });

  it('refuses other caregivers’ patients, archived patients and bad requests', async () => {
    const { me, p, presign } = await setup();
    const stranger = await t.caregiver();
    expect((await t.call(stranger, 'post', '/v1/uploads/presign', { patient_id: p.id, content_type: 'image/jpeg', byte_size: 10 })).status).toBe(404);
    expect((await presign({ patient_id: randomUUID() })).status).toBe(404);
    for (const over of [{ byte_size: MAX_PHOTO_BYTES + 1 }, { byte_size: 0 }, { content_type: 'image/png' }, { content_type: undefined }]) expect((await presign(over)).status).toBe(400);
    await t.call(me, 'post', `/v1/patients/${p.id}/archive`);
    expect((await presign()).body.error.code).toBe('PATIENT_ARCHIVED');
  });
});

describe('attaching a photo to a medicine (D-091)', () => {
  it('accepts a clean JPEG and returns a short-lived signed URL, audited', async () => {
    const { me, p, presign } = await setup();
    const { object_key } = (await presign()).body;
    store.put(object_key, cleanJpeg());
    const res = await t.call(me, 'post', `/v1/patients/${p.id}/medicines`, medicine(object_key));
    expect(res.status).toBe(201);
    expect(res.body.photo_object_key).toBe(object_key);
    expect(res.body.photo.url).toContain(object_key);
    expect(res.body.photo.etag).toMatch(/^[0-9a-f]{16}$/);
    const got = await t.call(me, 'get', `/v1/medicines/${res.body.id}`);
    expect(got.body.photo.etag).toBe(res.body.photo.etag);
    const audit = await t.db.select().from(auditLog).where(and(eq(auditLog.patientId, p.id), eq(auditLog.action, 'photo.read_url_issued')));
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0]!.meta).toEqual({ medicines: [res.body.id] });
  });

  it.each([
    ['not uploaded', () => undefined, 'has not been uploaded'],
    ['over 1 MB', () => Buffer.concat([cleanJpeg(), Buffer.alloc(MAX_PHOTO_BYTES)]), 'is larger than 1 MB'],
    ['with EXIF data', () => exifJpeg(), 'must not contain EXIF data'],
  ])('rejects a photo that is %s, and deletes it', async (_l, make, message) => {
    const { me, p, presign } = await setup();
    const { object_key } = (await presign()).body;
    const body = make();
    if (body) store.put(object_key, body);
    const res = await t.call(me, 'post', `/v1/patients/${p.id}/medicines`, medicine(object_key));
    expect(res.status).toBe(400);
    expect(res.body.error.details.fields.photo_object_key).toBe(message);
    expect(store.objects.has(object_key)).toBe(false);
    expect(await t.db.$count(medicines, eq(medicines.patientId, p.id))).toBe(0);
  });

  it('rejects a wrong content type', async () => {
    const { me, p, presign } = await setup();
    const { object_key } = (await presign()).body;
    store.put(object_key, cleanJpeg(), 'image/png');
    expect((await t.call(me, 'post', `/v1/patients/${p.id}/medicines`, medicine(object_key))).status).toBe(400);
  });

  it('rejects another patient’s key, and does not touch that patient’s object', async () => {
    const a = await setup();
    const b = await setup();
    const { object_key } = (await b.presign()).body;
    store.put(object_key, cleanJpeg());
    const res = await t.call(a.me, 'post', `/v1/patients/${a.p.id}/medicines`, medicine(object_key));
    expect(res.status).toBe(400);
    expect(store.objects.has(object_key)).toBe(true);
  });

  it('replacing or removing the photo deletes the old object', async () => {
    const { me, p, presign } = await setup();
    const first = (await presign()).body.object_key as string;
    store.put(first, cleanJpeg());
    const med = (await t.call(me, 'post', `/v1/patients/${p.id}/medicines`, medicine(first))).body;
    const second = (await presign()).body.object_key as string;
    store.put(second, cleanJpeg());
    expect((await t.call(me, 'patch', `/v1/medicines/${med.id}`, { photo_object_key: second })).body.photo_object_key).toBe(second);
    await new Promise((r) => setTimeout(r, 20));
    expect(store.objects.has(first)).toBe(false);
    expect((await t.call(me, 'patch', `/v1/medicines/${med.id}`, { photo_object_key: null })).body.photo).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(store.objects.has(second)).toBe(false);
  });

  it('another caregiver gets no URL for it (404 on the medicine)', async () => {
    const { me, p, presign } = await setup();
    const key = (await presign()).body.object_key as string;
    store.put(key, cleanJpeg());
    const med = (await t.call(me, 'post', `/v1/patients/${p.id}/medicines`, medicine(key))).body;
    const stranger = await t.caregiver();
    const res = await t.call(stranger, 'get', `/v1/medicines/${med.id}`);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(key);
  });
});
