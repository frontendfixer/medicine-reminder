import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.js';
import { DB } from '../db/database.module.js';
import { devices, doseInstances, notificationLog, patients } from '../db/schema.js';
import type { Principal } from '../common/principal.js';
import type { DoseResponseItem } from './device-sync.dto.js';

export const SNOOZE_MINUTES = 10;
const EARLY_CLAMP_MS = 3_600_000; // responded_at may not precede scheduled_at by more than 1 h (D-085)

type Dose = typeof doseInstances.$inferSelect;
export type Outcome = 'applied' | 'duplicate' | 'superseded' | 'rejected';

export const doseState = (d: Dose) => ({ id: d.id, status: d.status, snooze_until: d.snoozeUntil, responded_at: d.respondedAt, alert_due_at: d.alertDueAt });

// docs/05-reminder-engine.md#answers-and-sync, D-029 to D-032, D-085.
@Injectable()
export class DoseResponsesService {
  private readonly log = new Logger(DoseResponsesService.name);

  constructor(@Inject(DB) private readonly db: Db) {}

  async apply(principal: Principal, items: DoseResponseItem[]) {
    const results: { client_event_id: string; outcome: Outcome; dose: ReturnType<typeof doseState> | null }[] = [];
    for (const item of items) {
      try {
        results.push({ client_event_id: item.client_event_id, ...(await this.applyOne(principal, item)) });
      } catch (e) {
        // A bad item must not sink the batch: the phone keeps the rest and retries only what failed.
        if (!isUniqueViolation(e)) throw e;
        results.push({ client_event_id: item.client_event_id, outcome: 'rejected', dose: null });
      }
    }
    return { results };
  }

  private applyOne(principal: Principal, item: DoseResponseItem): Promise<{ outcome: Outcome; dose: ReturnType<typeof doseState> | null }> {
    return this.db.transaction(async (tx) => {
      // Scoped by the device's own patient: a dose of any other patient simply does not exist for this phone.
      const [dose] = await tx
        .select()
        .from(doseInstances)
        .where(and(eq(doseInstances.id, item.dose_id), eq(doseInstances.patientId, principal.patientId!)))
        .for('update');
      if (!dose) return { outcome: 'rejected', dose: null };
      if (dose.clientEventId === item.client_event_id) return { outcome: 'duplicate', dose: doseState(dose) };

      const [patient] = await tx.select().from(patients).where(eq(patients.id, dose.patientId));
      if (!patient || patient.status !== 'active') return { outcome: 'rejected', dose: doseState(dose) };

      const receivedAt = new Date();
      const respondedAt = new Date(Math.min(Math.max(Date.parse(item.responded_at), dose.scheduledAt.getTime() - EARLY_CLAMP_MS), receivedAt.getTime()));
      if (item.network_restored_at) this.log.log(`offline_delivery_ms=${receivedAt.getTime() - Date.parse(item.network_restored_at)}`); // SLO input (12)

      if (item.action === 'snooze') {
        // Hidden on the phone and refused here when it would run past the deadline; never moves alert_due_at (D-030, D-085).
        const open = dose.status === 'pending' || dose.status === 'snoozed';
        if (!open || receivedAt.getTime() + SNOOZE_MINUTES * 60_000 >= dose.alertDueAt.getTime()) return { outcome: 'rejected', dose: doseState(dose) };
        const [row] = await tx
          .update(doseInstances)
          .set({ status: 'snoozed', snoozeUntil: new Date(respondedAt.getTime() + SNOOZE_MINUTES * 60_000), clientEventId: item.client_event_id, updatedAt: sql`now()` })
          .where(eq(doseInstances.id, dose.id))
          .returning();
        return { outcome: 'applied', dose: doseState(row!) };
      }

      const answered = dose.status === 'taken' || dose.status === 'not_taken';
      // Earliest answer wins; a tie goes to whichever reached the server first (D-085).
      if (answered && !(respondedAt.getTime() < dose.respondedAt!.getTime())) return { outcome: 'superseded', dose: doseState(dose) };

      const wasMissed = dose.status === 'missed';
      const [row] = await tx
        .update(doseInstances)
        .set({
          status: item.action,
          respondedAt,
          receivedAt,
          snoozeUntil: null,
          clientEventId: item.client_event_id,
          // A Not taken answer is the alert, so the sweeper must not also send a missed alert (09).
          ...(item.action === 'not_taken' && !dose.alertSentAt ? { alertSentAt: receivedAt } : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(doseInstances.id, dose.id))
        .returning();

      // Self profile: the owner just answered on their own phone, so no push to themselves (09).
      if (patient.type === 'managed') {
        if (wasMissed) await this.queue(tx, patient.ownerUserId, patient.id, 'correction', dose.id); // one correction per dose
        else if (item.action === 'not_taken') await this.queue(tx, patient.ownerUserId, patient.id, 'not_taken', dose.id); // D-045
      }
      // The patient's other phones clear this dose (D-018, best effort: the next sync converges).
      const others = await tx.select({ id: devices.id }).from(devices).where(and(eq(devices.patientId, patient.id), isNull(devices.revokedAt), ne(devices.id, principal.id)));
      if (others.length) await tx.insert(notificationLog).values(others.map((o) => ({ kind: 'sync' as const, patientId: patient.id, deviceId: o.id, doseInstanceId: dose.id, data: { command: 'dose_cleared' } })));
      return { outcome: 'applied', dose: doseState(row!) };
    });
  }

  private async queue(tx: Tx, ownerUserId: string, patientId: string, kind: 'correction' | 'not_taken', doseId: string): Promise<void> {
    const targets = await tx.select({ id: devices.id }).from(devices).where(and(eq(devices.userId, ownerUserId), isNull(devices.revokedAt)));
    if (targets.length) await tx.insert(notificationLog).values(targets.map((t) => ({ kind, patientId, deviceId: t.id, doseInstanceId: doseId })));
  }
}

function isUniqueViolation(e: unknown): boolean {
  return (e as { cause?: { code?: string } }).cause?.code === '23505';
}
