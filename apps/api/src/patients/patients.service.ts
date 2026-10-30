import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import { DosesService } from '../doses/doses.service.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { ApiException } from '../common/api-exception.js';
import type { Db, Tx } from '../db/client.js';
import { DB } from '../db/database.module.js';
import { FieldEncryption } from '../crypto/field-encryption.js';
import { devices, doseInstances, pairingCodes, patients } from '../db/schema.js';
import type { CreatePatientBody, UpdatePatientBody } from './patients.dto.js';
import { patientView } from './patient-view.js';
import { assertPatientWritable, PatientsRepository, type PatientRow } from './patients.repository.js';

// docs/04-api.md#patients. `userId` is always the signed-in caregiver; nothing here trusts an owner from the client.
@Injectable()
export class PatientsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly repo: PatientsRepository,
    private readonly entitlements: EntitlementsService,
    private readonly encryption: FieldEncryption,
    private readonly audit: AuditService,
    private readonly doses: DosesService,
  ) {}

  async create(userId: string, body: CreatePatientBody) {
    const displayName = this.encryption.encrypt('patients.display_name', body.display_name);
    try {
      return await this.db.transaction(async (tx) => {
        // Both checks lock the caregiver's subscription row, so concurrent creates take turns (D-053).
        if (body.type === 'managed') {
          await this.entitlements.assertManagedQuota(tx, userId);
        } else {
          await this.entitlements.assertSelfProfileAllowed(tx, userId);
          await this.assertNoSelfProfile(tx, userId);
        }
        const [row] = await tx
          .insert(patients)
          .values({
            ownerUserId: userId,
            displayName,
            type: body.type,
            timezone: body.timezone,
            tzMode: body.tz_mode,
            missedDelayMin: body.missed_delay_min,
          })
          .returning();
        await this.audit.record(tx, { actorType: 'caregiver', actorId: userId, patientId: row!.id, action: 'patient.created', targetType: 'patient', targetId: row!.id, meta: { type: body.type } });
        return patientView(row!, [], this.encryption);
      });
    } catch (e) {
      if (violates(e, 'patients_one_self_uq')) throw selfProfileExists();
      throw e;
    }
  }

  async list(userId: string, status?: PatientRow['status']) {
    const rows = await this.repo.listOwned(userId, status);
    const devicesByPatient = await this.repo.activeDevices(rows.map((r) => r.id));
    return { items: rows.map((r) => patientView(r, devicesByPatient.get(r.id) ?? [], this.encryption)) };
  }

  async get(userId: string, patientId: string) {
    const row = await this.repo.findOwned(userId, patientId);
    return patientView(row, (await this.repo.activeDevices([row.id])).get(row.id) ?? [], this.encryption);
  }

  async update(userId: string, patientId: string, body: UpdatePatientBody) {
    return this.db.transaction(async (tx) => {
      const current = await this.repo.lockOwned(tx, userId, patientId);
      assertPatientWritable(current);

      const changes: Partial<typeof patients.$inferInsert> = {};
      if (body.display_name !== undefined) changes.displayName = this.encryption.encrypt('patients.display_name', body.display_name);
      if (body.timezone !== undefined) changes.timezone = body.timezone;
      if (body.tz_mode !== undefined) changes.tzMode = body.tz_mode;
      if (body.missed_delay_min !== undefined) changes.missedDelayMin = body.missed_delay_min;
      if (body.lockscreen_detail !== undefined) changes.lockscreenDetail = body.lockscreen_detail;

      const [row] = await tx.update(patients).set({ ...changes, updatedAt: sql`now()` }).where(eq(patients.id, current.id)).returning();
      const fields = Object.keys(body).sort((a, b) => (a < b ? -1 : 1));
      await this.audit.record(tx, { actorType: 'caregiver', actorId: userId, patientId: current.id, action: 'patient.updated', targetType: 'patient', targetId: current.id, meta: { fields } });
      if (body.missed_delay_min !== undefined) await this.doses.recomputeAlertDue(tx, { patientId: current.id }); // D-086
      if (body.timezone !== undefined && body.timezone !== current.timezone) {
        await this.doses.regeneratePatient(tx, current.id); // D-040: future pending doses follow the new timezone
        await this.audit.record(tx, { actorType: 'caregiver', actorId: userId, patientId: current.id, action: 'patient.timezone_changed', targetType: 'patient', targetId: current.id });
      }
      return this.viewIn(tx, row!);
    });
  }

  // Archive keeps all history (D-023) but ends everything live: devices are revoked, unanswered future doses
  // are deleted, and any open pairing code stops working.
  async archive(userId: string, patientId: string) {
    return this.db.transaction(async (tx) => {
      const current = await this.repo.lockOwned(tx, userId, patientId);
      if (current.status === 'archived') return this.viewIn(tx, current);

      const [row] = await tx.update(patients).set({ status: 'archived', archivedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(patients.id, current.id)).returning();
      const revoked = await tx
        .update(devices)
        .set({ revokedAt: sql`now()` })
        .where(and(eq(devices.patientId, current.id), isNull(devices.revokedAt)))
        .returning({ id: devices.id });
      await tx.delete(doseInstances).where(and(eq(doseInstances.patientId, current.id), eq(doseInstances.status, 'pending'), gt(doseInstances.scheduledAt, sql`now()`)));
      await tx
        .update(pairingCodes)
        .set({ invalidatedAt: sql`now()` })
        .where(and(eq(pairingCodes.patientId, current.id), isNull(pairingCodes.usedAt), isNull(pairingCodes.invalidatedAt)));

      await this.audit.record(tx, { actorType: 'caregiver', actorId: userId, patientId: current.id, action: 'patient.archived', targetType: 'patient', targetId: current.id });
      for (const device of revoked) {
        await this.audit.record(tx, { actorType: 'caregiver', actorId: userId, patientId: current.id, action: 'device.revoked', targetType: 'device', targetId: device.id, meta: { reason: 'patient_archived' } });
      }
      return this.viewIn(tx, row!);
    });
  }

  async reactivate(userId: string, patientId: string) {
    return this.db.transaction(async (tx) => {
      // Same lock order as create (subscription, then patient), so the two can't deadlock.
      const peek = await this.repo.findOwned(userId, patientId);
      if (peek.status === 'archived') {
        if (peek.type === 'managed') await this.entitlements.assertManagedQuota(tx, userId);
        else {
          await this.entitlements.assertSelfProfileAllowed(tx, userId);
          await this.assertNoSelfProfile(tx, userId);
        }
      }
      const current = await this.repo.lockOwned(tx, userId, patientId);
      if (current.status === 'active') return this.viewIn(tx, current);
      if (current.status === 'suspended') throw new ApiException('PATIENT_SUSPENDED', 'Reminders are paused until the subscription is renewed.');

      const [row] = await tx.update(patients).set({ status: 'active', archivedAt: null, updatedAt: sql`now()` }).where(eq(patients.id, current.id)).returning();
      await this.doses.regeneratePatient(tx, current.id);
      await this.audit.record(tx, { actorType: 'caregiver', actorId: userId, patientId: current.id, action: 'patient.reactivated', targetType: 'patient', targetId: current.id });
      return this.viewIn(tx, row!);
    });
  }

  private async viewIn(tx: Tx, row: PatientRow) {
    const rows = await tx.select().from(devices).where(and(eq(devices.patientId, row.id), isNull(devices.revokedAt)));
    return patientView(row, rows, this.encryption);
  }

  // One self profile per caregiver (D-092). The partial unique index is the backstop.
  private async assertNoSelfProfile(tx: Tx, userId: string): Promise<void> {
    const [existing] = await tx
      .select({ id: patients.id })
      .from(patients)
      .where(and(eq(patients.ownerUserId, userId), eq(patients.type, 'self'), sql`${patients.status} <> 'archived'`));
    if (existing) throw selfProfileExists();
  }
}

const selfProfileExists = () => new ApiException('SELF_PROFILE_EXISTS', 'You already have a self profile.');

function violates(e: unknown, constraint: string): boolean {
  const cause = (e as { cause?: { code?: string; constraint?: string } }).cause;
  return cause?.code === '23505' && cause.constraint === constraint;
}
