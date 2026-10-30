import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { ApiException } from '../common/api-exception.js';
import type { Db, Tx } from '../db/client.js';
import { DB } from '../db/database.module.js';
import { devices, patients } from '../db/schema.js';

export type PatientRow = typeof patients.$inferSelect;
export type DeviceRow = typeof devices.$inferSelect;

export const patientNotFound = () => new ApiException('NOT_FOUND', 'Not found.');

// Writes to a patient's data need an active patient: suspended is paused by billing (D-056), archived is closed.
export function assertPatientWritable(patient: PatientRow): void {
  if (patient.status === 'suspended') throw new ApiException('PATIENT_SUSPENDED', 'Reminders are paused until the subscription is renewed.');
  if (patient.status === 'archived') throw new ApiException('PATIENT_ARCHIVED', 'This patient is archived. Reactivate them first.');
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Every method takes the owner's user ID and puts it in the WHERE clause. There is no way to read a patient
// without naming the caregiver it must belong to (docs/10-security-privacy.md#isolation). A patient that
// exists but belongs to someone else is indistinguishable from one that doesn't exist: 404.
@Injectable()
export class PatientsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async findOwned(ownerUserId: string, patientId: string): Promise<PatientRow> {
    if (!UUID.test(patientId)) throw patientNotFound();
    const [row] = await this.db.select().from(patients).where(and(eq(patients.id, patientId), eq(patients.ownerUserId, ownerUserId)));
    if (!row) throw patientNotFound();
    return row;
  }

  // Same, inside a transaction, holding the row lock until it ends.
  async lockOwned(tx: Tx, ownerUserId: string, patientId: string): Promise<PatientRow> {
    if (!UUID.test(patientId)) throw patientNotFound();
    const [row] = await tx
      .select()
      .from(patients)
      .where(and(eq(patients.id, patientId), eq(patients.ownerUserId, ownerUserId)))
      .for('update');
    if (!row) throw patientNotFound();
    return row;
  }

  listOwned(ownerUserId: string, status?: PatientRow['status']): Promise<PatientRow[]> {
    const where = status ? and(eq(patients.ownerUserId, ownerUserId), eq(patients.status, status)) : eq(patients.ownerUserId, ownerUserId);
    return this.db.select().from(patients).where(where).orderBy(desc(patients.createdAt));
  }

  // Active (not revoked) devices of patients the caller already proved they own.
  async activeDevices(patientIds: string[]): Promise<Map<string, DeviceRow[]>> {
    const byPatient = new Map<string, DeviceRow[]>();
    if (!patientIds.length) return byPatient;
    const rows = await this.db.select().from(devices).where(and(inArray(devices.patientId, patientIds), isNull(devices.revokedAt)));
    for (const row of rows) byPatient.set(row.patientId!, [...(byPatient.get(row.patientId!) ?? []), row]);
    return byPatient;
  }
}
