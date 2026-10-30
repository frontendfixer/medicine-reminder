import { Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { FieldEncryption } from '../crypto/field-encryption.js';
import type { Tx } from '../db/client.js';
import { caregiverSettings, doseInstances, medicines, patients, scheduleTimes, scheduleVersions } from '../db/schema.js';
import { occurrences, type ScheduleInput } from './schedule.js';

export const HORIZON_DAYS = 14; // D-034

// Writes dose_instances from schedule versions (docs/05-reminder-engine.md#dose-generation). Every method runs
// in the caller's transaction, so a medicine edit and its doses commit together.
@Injectable()
export class DosesService {
  constructor(private readonly encryption: FieldEncryption) {}

  // Fills now → +14 days for an active patient. Safe to repeat: existing (medicine, instant) pairs are kept.
  async generateForPatient(tx: Tx, patientId: string, now = new Date()): Promise<number> {
    const [patient] = await tx.select().from(patients).where(eq(patients.id, patientId));
    if (!patient || patient.status !== 'active') return 0; // never suspended or archived
    const [settings] = await tx.select().from(caregiverSettings).where(eq(caregiverSettings.userId, patient.ownerUserId));
    const defaultDelay = settings?.defaultMissedDelayMin ?? 30;
    const to = new Date(now.getTime() + HORIZON_DAYS * 86_400_000);

    const meds = await tx.select().from(medicines).where(and(eq(medicines.patientId, patientId), isNull(medicines.archivedAt)));
    let inserted = 0;
    for (const med of meds) {
      const versions = await tx
        .select()
        .from(scheduleVersions)
        .where(and(eq(scheduleVersions.medicineId, med.id), or(isNull(scheduleVersions.effectiveUntil), gt(scheduleVersions.effectiveUntil, sql`${now.toISOString()}::timestamptz`))));
      if (!versions.length) continue;
      const times = await tx.select().from(scheduleTimes).where(inArray(scheduleTimes.scheduleVersionId, versions.map((v) => v.id))).orderBy(asc(scheduleTimes.localTime));
      const name = this.encryption.decrypt('medicines.name', med.name);
      const delayMin = med.missedDelayMin ?? patient.missedDelayMin ?? defaultDelay; // medicine → patient → caregiver (D-043)

      const rows: (typeof doseInstances.$inferInsert)[] = [];
      for (const v of versions) {
        const input: ScheduleInput = {
          pattern: v.pattern,
          daysOfWeek: v.daysOfWeek,
          intervalDays: v.intervalDays,
          startDate: v.startDate,
          endDate: v.endDate,
          times: times.filter((t) => t.scheduleVersionId === v.id).map((t) => ({ localTime: t.localTime, amountText: t.amountText })),
          effectiveFrom: v.effectiveFrom,
          effectiveUntil: v.effectiveUntil,
        };
        for (const o of occurrences(input, patient.timezone, now, to)) {
          rows.push({
            patientId,
            medicineId: med.id,
            scheduleVersionId: v.id,
            scheduledAt: o.scheduledAt,
            localTime: o.localTime,
            nameSnapshot: this.encryption.encrypt('dose_instances.name_snapshot', name), // fresh IV per row
            amountSnapshot: o.amountText,
            alertDueAt: new Date(o.scheduledAt.getTime() + delayMin * 60_000), // frozen here (D-082)
          });
        }
      }
      for (let i = 0; i < rows.length; i += 500) {
        const done = await tx.insert(doseInstances).values(rows.slice(i, i + 500)).onConflictDoNothing().returning({ id: doseInstances.id });
        inserted += done.length;
      }
    }
    return inserted;
  }

  // Answered, snoozed, missed and past doses are never touched (05).
  async deleteFuturePending(tx: Tx, scope: { patientId: string } | { medicineId: string }): Promise<void> {
    const where = 'medicineId' in scope ? eq(doseInstances.medicineId, scope.medicineId) : eq(doseInstances.patientId, scope.patientId);
    await tx.delete(doseInstances).where(and(where, eq(doseInstances.status, 'pending'), gt(doseInstances.scheduledAt, sql`now()`)));
  }

  // After a timezone change or reactivation: future pending doses are rebuilt from the schedules.
  async regeneratePatient(tx: Tx, patientId: string): Promise<void> {
    await this.deleteFuturePending(tx, { patientId });
    await this.generateForPatient(tx, patientId);
  }

  // D-086: a changed delay applies to doses scheduled after the change, i.e. pending doses still in the future.
  async recomputeAlertDue(tx: Tx, scope: { patientId: string } | { ownerUserId: string }): Promise<void> {
    const scoped = 'patientId' in scope ? sql`p.id = ${scope.patientId}` : sql`p.owner_user_id = ${scope.ownerUserId}`;
    await tx.execute(sql`
      update dose_instances d
      set alert_due_at = d.scheduled_at + make_interval(mins => coalesce(m.missed_delay_min, p.missed_delay_min, cs.default_missed_delay_min)),
          updated_at = now()
      from medicines m, patients p, caregiver_settings cs
      where d.medicine_id = m.id and d.patient_id = p.id and cs.user_id = p.owner_user_id
        and d.status = 'pending' and d.scheduled_at > now() and ${scoped}`);
  }
}
