import { sql } from 'drizzle-orm';
import type { Db } from './client.js';
import * as s from './schema.js';
import { resetTestDb } from './test-db.js';

let db: Db;
let pool: { end(): Promise<void> };

const bytes = (text: string) => Buffer.from(text);
const ago = (min: number) => new Date(Date.now() - min * 60_000);

// Drizzle wraps the driver error; the constraint name sits on `cause`.
async function expectViolation(run: Promise<unknown>, constraint: string) {
  const err = (await run.then(
    () => null,
    (e: unknown) => e,
  )) as { cause?: { constraint?: string }; constraint?: string } | null;
  expect(err, `expected a violation of ${constraint}`).not.toBeNull();
  expect(err?.cause?.constraint ?? err?.constraint).toBe(constraint);
}

let n = 0;
async function user() {
  const [u] = await db
    .insert(s.users)
    .values({ email: `user${++n}@example.test`, passwordHash: 'x' })
    .returning();
  return u!;
}
async function patient(ownerUserId: string, over: Partial<typeof s.patients.$inferInsert> = {}) {
  const [p] = await db
    .insert(s.patients)
    .values({ ownerUserId, displayName: bytes('p'), timezone: 'Asia/Kolkata', ...over })
    .returning();
  return p!;
}
async function medicine(patientId: string) {
  const [m] = await db.insert(s.medicines).values({ patientId, name: bytes('m') }).returning();
  return m!;
}
async function version(medicineId: string, over: Partial<typeof s.scheduleVersions.$inferInsert> = {}) {
  const [v] = await db
    .insert(s.scheduleVersions)
    .values({ medicineId, effectiveFrom: new Date(), pattern: 'daily', startDate: '2026-11-01', ...over })
    .returning();
  return v!;
}

beforeAll(async () => {
  ({ db, pool } = await resetTestDb());
});
afterAll(() => pool.end());

describe('schema', () => {
  it('creates every table from docs/03-data-model.md (otp_challenges is v1.1)', async () => {
    const rows = await db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`,
    );
    expect(rows.rows.map((r) => r.table_name)).toEqual([
      'audit_log',
      'auth_sessions',
      'caregiver_settings',
      'consents',
      'devices',
      'dose_instances',
      'idempotency_keys',
      'medicines',
      'notification_log',
      'pairing_codes',
      'patients',
      'rc_webhook_events',
      'schedule_times',
      'schedule_versions',
      'subscriptions',
      'users',
    ]);
  });

  it('allows one active self profile per caregiver (D-092)', async () => {
    const u = await user();
    const self = await patient(u.id, { type: 'self' });
    await expectViolation(patient(u.id, { type: 'self' }), 'patients_one_self_uq');
    await db.update(s.patients).set({ status: 'archived' }).where(sql`${s.patients.id} = ${self.id}`);
    await patient(u.id, { type: 'self' });
  });

  it('keeps patient devices and caregiver logins apart (D-014, D-019)', async () => {
    const u = await user();
    const p = await patient(u.id);
    const base = { platform: 'android' } as const;
    await expectViolation(db.insert(s.devices).values({ ...base }), 'devices_one_owner');
    await expectViolation(
      db.insert(s.devices).values({ ...base, userId: u.id, patientId: p.id, tokenHash: 'a' }),
      'devices_one_owner',
    );
    await expectViolation(db.insert(s.devices).values({ ...base, patientId: p.id }), 'devices_patient_has_token');
    await db.insert(s.devices).values({ ...base, patientId: p.id, tokenHash: 'same' });
    await expectViolation(
      db.insert(s.devices).values({ ...base, patientId: p.id, tokenHash: 'same' }),
      'devices_token_hash_uq',
    );

    const login = await db.insert(s.devices).values({ ...base, userId: u.id }).returning();
    await expectViolation(db.insert(s.devices).values({ ...base, userId: u.id }), 'devices_one_caregiver_login_uq');
    await db.update(s.devices).set({ revokedAt: new Date() }).where(sql`${s.devices.id} = ${login[0]!.id}`);
    await db.insert(s.devices).values({ ...base, userId: u.id });
  });

  it('requires a reason whenever a session is revoked, and only known reasons', async () => {
    const u = await user();
    const [session] = await db.insert(s.authSessions).values({ userId: u.id, refreshHash: 'rr' }).returning();
    const revoke = (set: Partial<typeof s.authSessions.$inferInsert>) =>
      db.update(s.authSessions).set(set).where(sql`${s.authSessions.id} = ${session!.id}`);
    await expectViolation(revoke({ revokedAt: new Date() }), 'auth_sessions_revoked_reason');
    await expectViolation(revoke({ revokedReason: 'logout' }), 'auth_sessions_revoked_reason');
    await expectViolation(revoke({ revokedAt: new Date(), revokedReason: 'because' }), 'auth_sessions_revoked_reason');
    await revoke({ revokedAt: new Date(), revokedReason: 'replaced' });
  });

  it('allows one active session per caregiver (D-019)', async () => {
    const u = await user();
    const [first] = await db.insert(s.authSessions).values({ userId: u.id, refreshHash: 'r1' }).returning();
    await expectViolation(
      db.insert(s.authSessions).values({ userId: u.id, refreshHash: 'r2' }),
      'auth_sessions_one_active_uq',
    );
    await db.update(s.authSessions).set({ revokedAt: new Date(), revokedReason: 'logout' }).where(sql`${s.authSessions.id} = ${first!.id}`);
    await db.insert(s.authSessions).values({ userId: u.id, refreshHash: 'r2' });
  });

  it('allows one live pairing code per patient and kind (D-011)', async () => {
    const u = await user();
    const p = await patient(u.id);
    const code = (over: Partial<typeof s.pairingCodes.$inferInsert> = {}) => ({
      patientId: p.id,
      kind: 'pair' as const,
      createdByUserId: u.id,
      lookupHash: 'l',
      codeHash: 'c',
      expiresAt: new Date(Date.now() + 600_000),
      ...over,
    });
    const [first] = await db.insert(s.pairingCodes).values(code()).returning();
    await expectViolation(db.insert(s.pairingCodes).values(code()), 'pairing_codes_live_uq');
    await db.insert(s.pairingCodes).values(code({ kind: 'transfer' })); // other kind is independent
    await db.update(s.pairingCodes).set({ invalidatedAt: new Date() }).where(sql`${s.pairingCodes.id} = ${first!.id}`);
    await db.insert(s.pairingCodes).values(code());
  });

  it('validates schedule versions (D-021, D-023)', async () => {
    const u = await user();
    const m = await medicine((await patient(u.id)).id);
    await expectViolation(version(m.id, { pattern: 'weekdays' }), 'sv_weekdays'); // days missing
    await expectViolation(version(m.id, { pattern: 'weekdays', daysOfWeek: [] }), 'sv_weekdays');
    await expectViolation(version(m.id, { pattern: 'weekdays', daysOfWeek: [0, 8] }), 'sv_weekdays');
    await expectViolation(version(m.id, { pattern: 'every_n_days' }), 'sv_interval'); // interval missing
    await expectViolation(version(m.id, { pattern: 'every_n_days', intervalDays: 1 }), 'sv_interval');
    await expectViolation(version(m.id, { endDate: '2026-10-01' }), 'sv_dates');
    const v1 = await version(m.id, { pattern: 'weekdays', daysOfWeek: [1, 3, 5] });
    await expectViolation(version(m.id), 'schedule_versions_current_uq');
    await db.update(s.scheduleVersions).set({ effectiveUntil: new Date() }).where(sql`${s.scheduleVersions.id} = ${v1.id}`);
    await version(m.id);
  });

  describe('dose_instances', () => {
    async function setup() {
      const u = await user();
      const p = await patient(u.id);
      const m = await medicine(p.id);
      const v = await version(m.id);
      const dose = (over: Partial<typeof s.doseInstances.$inferInsert> = {}) => ({
        patientId: p.id,
        medicineId: m.id,
        scheduleVersionId: v.id,
        scheduledAt: new Date('2026-11-01T02:30:00Z'),
        localTime: '08:00',
        nameSnapshot: bytes('m'),
        amountSnapshot: '1 tablet',
        alertDueAt: new Date('2026-11-01T03:00:00Z'),
        ...over,
      });
      return { dose };
    }

    it('never creates a dose twice, nor applies an answer twice', async () => {
      const { dose } = await setup();
      await db.insert(s.doseInstances).values(dose());
      await expectViolation(db.insert(s.doseInstances).values(dose()), 'dose_medicine_time_uq');
      const event = crypto.randomUUID();
      await db.insert(s.doseInstances).values(dose({ scheduledAt: new Date('2026-11-02T02:30:00Z'), clientEventId: event }));
      await expectViolation(
        db.insert(s.doseInstances).values(dose({ scheduledAt: new Date('2026-11-03T02:30:00Z'), clientEventId: event })),
        'dose_client_event_uq',
      );
    });

    it('defaults to pending, and the sweeper queries use the partial indexes', async () => {
      const { dose } = await setup();
      const [d] = await db.insert(s.doseInstances).values(dose({ alertDueAt: ago(1) })).returning();
      expect(d!.status).toBe('pending');

      await db.transaction(async (tx) => {
        await tx.execute(sql`set local enable_seqscan = off`);
        const plan = async (query: ReturnType<typeof sql>) =>
          (await tx.execute<{ 'QUERY PLAN': string }>(sql`explain ${query}`)).rows.map((r) => r['QUERY PLAN']).join('\n');
        expect(
          await plan(sql`select id from dose_instances where alert_sent_at is null and status in ('pending','snoozed') and alert_due_at <= now() for update skip locked`),
        ).toContain('dose_alert_due_idx');
        expect(
          await plan(sql`select id from dose_instances where push_sent_at is null and status in ('pending','snoozed') and scheduled_at <= now()`),
        ).toContain('dose_push_due_idx');
      });
    });
  });

  it('keeps idempotency keys per principal (D-083)', async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    const row = (principal: string) => ({ principal, key: 'k1', methodPath: 'POST /v1/patients', requestHash: 'h' });
    await db.insert(s.idempotencyKeys).values(row(a));
    await db.insert(s.idempotencyKeys).values(row(b));
    await expectViolation(db.insert(s.idempotencyKeys).values(row(a)), 'idempotency_keys_principal_key_pk');
  });

  it('dedupes RevenueCat webhook events by event ID (D-051)', async () => {
    await db.insert(s.rcWebhookEvents).values({ eventId: 'evt1', type: 'RENEWAL' });
    await expectViolation(
      db.insert(s.rcWebhookEvents).values({ eventId: 'evt1', type: 'RENEWAL' }),
      'rc_webhook_events_pkey',
    );
  });
});
