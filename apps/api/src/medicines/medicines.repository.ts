import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.js';
import { DB } from '../db/database.module.js';
import { medicines, patients, scheduleTimes, scheduleVersions } from '../db/schema.js';
import { patientNotFound } from '../patients/patients.repository.js';

export type MedicineRow = typeof medicines.$inferSelect;
export type VersionRow = typeof scheduleVersions.$inferSelect;
export type TimeRow = typeof scheduleTimes.$inferSelect;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Like PatientsRepository: every lookup goes medicine → patient → owner, so a medicine of someone else's
// patient is a 404 (docs/10-security-privacy.md#isolation).
@Injectable()
export class MedicinesRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async findOwned(ownerUserId: string, medicineId: string): Promise<MedicineRow> {
    if (!UUID.test(medicineId)) throw patientNotFound();
    const [row] = await this.db
      .select({ medicine: medicines })
      .from(medicines)
      .innerJoin(patients, eq(patients.id, medicines.patientId))
      .where(and(eq(medicines.id, medicineId), eq(patients.ownerUserId, ownerUserId)));
    if (!row) throw patientNotFound();
    return row.medicine;
  }

  // Call after locking the patient (patient, then medicine: the lock order everywhere).
  async lock(tx: Tx, medicineId: string): Promise<MedicineRow> {
    const [row] = await tx.select().from(medicines).where(eq(medicines.id, medicineId)).for('update');
    if (!row) throw patientNotFound();
    return row;
  }

  listForPatient(patientId: string, includeArchived: boolean): Promise<MedicineRow[]> {
    const where = includeArchived ? eq(medicines.patientId, patientId) : and(eq(medicines.patientId, patientId), isNull(medicines.archivedAt));
    return this.db.select().from(medicines).where(where).orderBy(asc(medicines.createdAt));
  }

  // The current schedule: the open version, or for an archived medicine the last one.
  async schedules(medicineIds: string[], executor: Db | Tx = this.db): Promise<Map<string, { version: VersionRow; times: TimeRow[] }>> {
    const out = new Map<string, { version: VersionRow; times: TimeRow[] }>();
    if (!medicineIds.length) return out;
    const versions = await executor.select().from(scheduleVersions).where(inArray(scheduleVersions.medicineId, medicineIds)).orderBy(desc(scheduleVersions.effectiveFrom));
    for (const v of versions) if (!out.has(v.medicineId)) out.set(v.medicineId, { version: v, times: [] });
    const times = await executor.select().from(scheduleTimes).where(inArray(scheduleTimes.scheduleVersionId, [...out.values()].map((s) => s.version.id))).orderBy(asc(scheduleTimes.localTime));
    for (const t of times) for (const s of out.values()) if (s.version.id === t.scheduleVersionId) s.times.push(t);
    return out;
  }
}
