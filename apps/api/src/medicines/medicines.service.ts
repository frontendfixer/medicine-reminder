import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import { ApiException } from '../common/api-exception.js';
import { FieldEncryption } from '../crypto/field-encryption.js';
import type { Db, Tx } from '../db/client.js';
import { DB } from '../db/database.module.js';
import { medicines, scheduleTimes, scheduleVersions } from '../db/schema.js';
import { DosesService } from '../doses/doses.service.js';
import { assertPatientWritable, PatientsRepository } from '../patients/patients.repository.js';
import { medicineView } from './medicine-view.js';
import type { CreateMedicineBody, ScheduleBody, UpdateMedicineBody } from './medicines.dto.js';
import { MedicinesRepository, type MedicineRow } from './medicines.repository.js';

// docs/04-api.md#medicines, D-023, D-034. Editing never rewrites history: the open schedule version is closed,
// a new one opens now, and only future pending doses are rebuilt (05).
@Injectable()
export class MedicinesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly repo: MedicinesRepository,
    private readonly patients: PatientsRepository,
    private readonly doses: DosesService,
    private readonly encryption: FieldEncryption,
    private readonly audit: AuditService,
  ) {}

  async list(userId: string, patientId: string, includeArchived: boolean) {
    const patient = await this.patients.findOwned(userId, patientId);
    const rows = await this.repo.listForPatient(patient.id, includeArchived);
    const schedules = await this.repo.schedules(rows.map((r) => r.id));
    return { items: rows.map((r) => medicineView(r, schedules.get(r.id), this.encryption)) };
  }

  async get(userId: string, medicineId: string) {
    const row = await this.repo.findOwned(userId, medicineId);
    return medicineView(row, (await this.repo.schedules([row.id])).get(row.id), this.encryption);
  }

  async create(userId: string, patientId: string, body: CreateMedicineBody) {
    return this.db.transaction(async (tx) => {
      const patient = await this.patients.lockOwned(tx, userId, patientId);
      assertPatientWritable(patient);
      this.checkPhotoKey(patient.id, body.photo_object_key);

      const [row] = await tx
        .insert(medicines)
        .values({
          patientId: patient.id,
          name: this.encryption.encrypt('medicines.name', body.name),
          notes: body.notes ? this.encryption.encrypt('medicines.notes', body.notes) : null,
          photoObjectKey: body.photo_object_key ?? null,
          notificationType: body.notification_type,
          missedDelayMin: body.missed_delay_min ?? null,
        })
        .returning();
      await this.openVersion(tx, row!.id, body.schedule, new Date());
      await this.doses.generateForPatient(tx, patient.id);
      await this.audit.record(tx, { actorType: 'caregiver', actorId: userId, patientId: patient.id, action: 'medicine.created', targetType: 'medicine', targetId: row!.id });
      return this.viewIn(tx, row!);
    });
  }

  async update(userId: string, medicineId: string, body: UpdateMedicineBody) {
    return this.db.transaction(async (tx) => {
      const found = await this.repo.findOwned(userId, medicineId);
      const patient = await this.patients.lockOwned(tx, userId, found.patientId); // patient first, then medicine
      assertPatientWritable(patient);
      const current = await this.repo.lock(tx, medicineId);
      if (current.archivedAt) throw new ApiException('MEDICINE_ARCHIVED', 'This medicine is archived.');
      if (body.photo_object_key !== undefined) this.checkPhotoKey(patient.id, body.photo_object_key);

      const set: Partial<typeof medicines.$inferInsert> = { updatedAt: new Date() };
      if (body.name !== undefined) set.name = this.encryption.encrypt('medicines.name', body.name);
      if (body.notes !== undefined) set.notes = body.notes ? this.encryption.encrypt('medicines.notes', body.notes) : null;
      if (body.photo_object_key !== undefined) set.photoObjectKey = body.photo_object_key;
      if (body.notification_type !== undefined) set.notificationType = body.notification_type;
      if (body.missed_delay_min !== undefined) set.missedDelayMin = body.missed_delay_min;
      const [row] = await tx.update(medicines).set(set).where(eq(medicines.id, medicineId)).returning();

      // Any edit starts a new schedule version effective now, copying the old schedule if it did not change,
      // so every future dose is rebuilt from current data (new name snapshot, delay, schedule).
      const now = new Date();
      const old = (await this.repo.schedules([medicineId], tx)).get(medicineId)!;
      await tx.update(scheduleVersions).set({ effectiveUntil: now }).where(eq(scheduleVersions.id, old.version.id));
      const schedule: ScheduleBody =
        body.schedule ?? {
          pattern: old.version.pattern,
          days_of_week: old.version.daysOfWeek,
          interval_days: old.version.intervalDays,
          start_date: old.version.startDate, // the every_n_days anchor carries forward, so an edit doesn't shift the cycle
          end_date: old.version.endDate,
          times: old.times.map((t) => ({ local_time: t.localTime.slice(0, 5), amount_text: t.amountText })),
        };
      await this.openVersion(tx, medicineId, schedule, now);
      await this.doses.deleteFuturePending(tx, { medicineId });
      await this.doses.generateForPatient(tx, patient.id, now);
      await this.audit.record(tx, {
        actorType: 'caregiver',
        actorId: userId,
        patientId: patient.id,
        action: 'medicine.updated',
        targetType: 'medicine',
        targetId: medicineId,
        meta: { fields: Object.keys(body).sort((a, b) => (a < b ? -1 : 1)) },
      });
      return this.viewIn(tx, row!);
    });
  }

  // Never a delete (D-023): the medicine and its history stay; reminders stop.
  async archive(userId: string, medicineId: string) {
    return this.db.transaction(async (tx) => {
      const found = await this.repo.findOwned(userId, medicineId);
      const patient = await this.patients.lockOwned(tx, userId, found.patientId);
      assertPatientWritable(patient);
      const current = await this.repo.lock(tx, medicineId);
      if (current.archivedAt) return this.viewIn(tx, current);
      const [row] = await tx.update(medicines).set({ archivedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(medicines.id, medicineId)).returning();
      await tx.update(scheduleVersions).set({ effectiveUntil: sql`now()` }).where(sql`${scheduleVersions.medicineId} = ${medicineId} and ${scheduleVersions.effectiveUntil} is null`);
      await this.doses.deleteFuturePending(tx, { medicineId });
      await this.audit.record(tx, { actorType: 'caregiver', actorId: userId, patientId: patient.id, action: 'medicine.archived', targetType: 'medicine', targetId: medicineId });
      return this.viewIn(tx, row!);
    });
  }

  private async openVersion(tx: Tx, medicineId: string, s: ScheduleBody, effectiveFrom: Date): Promise<void> {
    const [version] = await tx
      .insert(scheduleVersions)
      .values({
        medicineId,
        effectiveFrom,
        pattern: s.pattern,
        daysOfWeek: s.pattern === 'weekdays' ? s.days_of_week : null,
        intervalDays: s.pattern === 'every_n_days' ? s.interval_days : null,
        startDate: s.start_date,
        endDate: s.end_date ?? null,
      })
      .returning({ id: scheduleVersions.id });
    await tx.insert(scheduleTimes).values(s.times.map((t) => ({ scheduleVersionId: version!.id, localTime: t.local_time, amountText: t.amount_text })));
  }

  // Keys are issued by uploads/presign as p/{patientId}/m/{id}.jpg. A key for another patient is refused, so a
  // caregiver can't attach someone else's photo. Size and type are verified against storage when photos arrive.
  private checkPhotoKey(patientId: string, key: string | null | undefined): void {
    if (!key) return;
    if (!new RegExp(`^p/${patientId}/m/[0-9a-f-]{36}\\.jpg$`).test(key)) throw ApiException.validation({ photo_object_key: 'is not a valid upload for this patient' });
  }

  private async viewIn(tx: Tx, row: MedicineRow) {
    return medicineView(row, (await this.repo.schedules([row.id], tx)).get(row.id), this.encryption);
  }
}
