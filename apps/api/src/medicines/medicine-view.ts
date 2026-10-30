import { FieldEncryption } from '../crypto/field-encryption.js';
import type { MedicineRow, TimeRow, VersionRow } from './medicines.repository.js';

export function medicineView(m: MedicineRow, schedule: { version: VersionRow; times: TimeRow[] } | undefined, encryption: FieldEncryption) {
  return {
    id: m.id,
    patient_id: m.patientId,
    name: encryption.decrypt('medicines.name', m.name),
    notes: m.notes ? encryption.decrypt('medicines.notes', m.notes) : null,
    photo_object_key: m.photoObjectKey,
    notification_type: m.notificationType,
    missed_delay_min: m.missedDelayMin,
    archived_at: m.archivedAt,
    created_at: m.createdAt,
    updated_at: m.updatedAt,
    schedule: schedule && {
      version_id: schedule.version.id,
      pattern: schedule.version.pattern,
      days_of_week: schedule.version.daysOfWeek,
      interval_days: schedule.version.intervalDays,
      start_date: schedule.version.startDate,
      end_date: schedule.version.endDate,
      effective_from: schedule.version.effectiveFrom,
      times: schedule.times.map((t) => ({ id: t.id, local_time: t.localTime.slice(0, 5), amount_text: t.amountText })),
    },
  };
}
