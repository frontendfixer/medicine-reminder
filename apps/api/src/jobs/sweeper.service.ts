import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import { FieldEncryption } from '../crypto/field-encryption.js';
import type { Db, Tx } from '../db/client.js';
import { DB } from '../db/database.module.js';
import { devices, doseInstances, notificationLog, patients, subscriptions } from '../db/schema.js';
import { formatTime } from '../push/composer.js';
import { needsBackup } from './device-health.js';

const BATCH = 500;
const GROUP_MS = 15 * 60_000; // D-046
const WARN_BEFORE_CUTOFF_MS = 6 * 3_600_000; // D-054

// The minute sweeper (docs/05-reminder-engine.md#minute-sweeper). Each pass selects due rows with FOR UPDATE SKIP LOCKED
// and marks them in the same transaction that queues the notifications, so every row is handled exactly once, however
// many workers run and however late a tick is. Selection is by time, not by tick, so a skipped tick just catches up.
@Injectable()
export class SweeperService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly encryption: FieldEncryption,
    private readonly audit: AuditService,
  ) {}

  async run(now = new Date(), budgetMs = 50_000): Promise<{ backup: number; missed: number; suspended: number }> {
    const deadline = Date.now() + budgetMs;
    const total = { backup: 0, missed: 0, suspended: 0 };
    const passes = [
      ['backup', (at: Date) => this.passA(at)],
      ['missed', (at: Date) => this.passB(at)],
    ] as const;
    for (const [key, pass] of passes) {
      while (Date.now() < deadline) {
        const n = await pass(now);
        total[key] += n;
        if (n < BATCH) break;
      }
    }
    total.suspended = await this.passC(now);
    return total;
  }

  // Pass A: decide, per due dose and per phone, whether a backup push is needed. Healthy phones get none.
  async passA(now: Date): Promise<number> {
    return this.db.transaction(async (tx) => {
      const due = await tx
        .select({ dose: doseInstances })
        .from(doseInstances)
        .innerJoin(patients, and(eq(patients.id, doseInstances.patientId), eq(patients.status, 'active')))
        .where(and(isNull(doseInstances.pushSentAt), inArray(doseInstances.status, ['pending', 'snoozed']), lte(doseInstances.scheduledAt, now), gt(doseInstances.alertDueAt, now))) // past the deadline, Pass B takes it
        .orderBy(asc(doseInstances.scheduledAt))
        .limit(BATCH)
        .for('update', { of: doseInstances, skipLocked: true });
      if (!due.length) return 0;

      const patientIds = [...new Set(due.map((r) => r.dose.patientId))];
      const phones = await tx.select().from(devices).where(and(inArray(devices.patientId, patientIds), isNull(devices.revokedAt)));
      const rows: (typeof notificationLog.$inferInsert)[] = [];
      for (const { dose } of due) {
        for (const phone of phones.filter((p) => p.patientId === dose.patientId)) {
          if (needsBackup(phone, dose.scheduledAt, now)) rows.push({ kind: 'backup', patientId: dose.patientId, deviceId: phone.id, doseInstanceId: dose.id });
        }
      }
      if (rows.length) await tx.insert(notificationLog).values(rows);
      await tx.update(doseInstances).set({ pushSentAt: now }).where(inArray(doseInstances.id, due.map((r) => r.dose.id)));
      return due.length;
    });
  }

  // Pass B: no answer by alert_due_at → missed, once, and alert the owner (09).
  async passB(now: Date): Promise<number> {
    return this.db.transaction(async (tx) => {
      const due = await tx
        .select({ dose: doseInstances, patient: patients })
        .from(doseInstances)
        .innerJoin(patients, and(eq(patients.id, doseInstances.patientId), eq(patients.status, 'active')))
        .where(and(isNull(doseInstances.alertSentAt), inArray(doseInstances.status, ['pending', 'snoozed']), lte(doseInstances.alertDueAt, now)))
        .orderBy(asc(doseInstances.alertDueAt))
        .limit(BATCH)
        .for('update', { of: doseInstances, skipLocked: true });
      if (!due.length) return 0;

      await tx.update(doseInstances).set({ status: 'missed', alertSentAt: now, updatedAt: sql`now()` }).where(inArray(doseInstances.id, due.map((r) => r.dose.id)));

      const byPatient = new Map<string, typeof due>();
      for (const row of due) byPatient.set(row.patient.id, [...(byPatient.get(row.patient.id) ?? []), row]);
      for (const [patientId, misses] of byPatient) {
        const patient = misses[0]!.patient;
        const targets = await tx.select({ id: devices.id }).from(devices).where(and(eq(devices.userId, patient.ownerUserId), isNull(devices.revokedAt)));
        if (!targets.length) continue;
        const first = misses[0]!.dose;

        // Misses within 15 minutes of the group's first alert join it: same group key, so the new alert replaces the
        // old one on the phone, and the count grows (D-046).
        const [prev] = await tx
          .select({ groupKey: notificationLog.groupKey, data: notificationLog.data })
          .from(notificationLog)
          .where(and(eq(notificationLog.kind, 'missed'), eq(notificationLog.patientId, patientId), gt(notificationLog.createdAt, new Date(now.getTime() - GROUP_MS))))
          .orderBy(desc(notificationLog.createdAt))
          .limit(1);
        const prevData = (prev?.data ?? {}) as { count?: number; group_started_at?: string; first_time?: string };
        const startedAt = prevData.group_started_at ? new Date(prevData.group_started_at) : null;
        const joins = prev?.groupKey && startedAt && now.getTime() - startedAt.getTime() < GROUP_MS;
        const groupKey = joins ? prev.groupKey! : `missed:${patientId}:${now.getTime()}`;
        const data = {
          count: (joins ? Number(prevData.count ?? 0) : 0) + misses.length,
          group_started_at: joins ? prevData.group_started_at! : now.toISOString(),
          first_time: joins && prevData.first_time ? prevData.first_time : formatTime(first.scheduledAt, patient.timezone),
        };
        await tx.insert(notificationLog).values(targets.map((d) => ({ kind: 'missed' as const, patientId, deviceId: d.id, doseInstanceId: first.id, groupKey, data })));
      }
      return due.length;
    });
  }

  // Pass C: billing cutoff and the 6-hour warning (07).
  async passC(now: Date): Promise<number> {
    await this.warnBeforeCutoff(now);
    return this.db.transaction(async (tx) => {
      const expiring = await tx
        .select()
        .from(subscriptions)
        .where(and(eq(subscriptions.status, 'grace'), lte(subscriptions.cutoffAt, now)))
        .limit(100)
        .for('update', { skipLocked: true });
      if (!expiring.length) return 0;
      for (const sub of expiring) await this.suspend(tx, sub.userId);
      return expiring.length;
    });
  }

  private async suspend(tx: Tx, userId: string): Promise<void> {
    await tx.update(subscriptions).set({ status: 'expired', updatedAt: sql`now()` }).where(eq(subscriptions.userId, userId));
    const suspended = await tx
      .update(patients)
      .set({ status: 'suspended', suspendedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(patients.ownerUserId, userId), eq(patients.status, 'active'))) // managed and self
      .returning({ id: patients.id });
    if (suspended.length) {
      // Every patient phone cancels its alarms and shows "Reminders paused" (data push, best effort; sync says it too).
      const phones = await tx.select({ id: devices.id, patientId: devices.patientId }).from(devices).where(and(inArray(devices.patientId, suspended.map((p) => p.id)), isNull(devices.revokedAt)));
      if (phones.length) await tx.insert(notificationLog).values(phones.map((p) => ({ kind: 'sync' as const, patientId: p.patientId, deviceId: p.id, data: { command: 'cancel_all' } })));
    }
    const carers = await tx.select({ id: devices.id }).from(devices).where(and(eq(devices.userId, userId), isNull(devices.revokedAt)));
    if (carers.length) await tx.insert(notificationLog).values(carers.map((c) => ({ kind: 'billing' as const, deviceId: c.id, data: { event: 'suspended' } })));
    await this.audit.record(tx, { actorType: 'system', actorId: userId, action: 'billing.suspended', targetType: 'user', targetId: userId, meta: { patients: suspended.length } });
  }

  // One warning per grace period, 6 hours before cutoff.
  private async warnBeforeCutoff(now: Date): Promise<void> {
    await this.db.transaction(async (tx) => {
      const soon = await tx
        .select()
        .from(subscriptions)
        .where(and(eq(subscriptions.status, 'grace'), gt(subscriptions.cutoffAt, now), lte(subscriptions.cutoffAt, new Date(now.getTime() + WARN_BEFORE_CUTOFF_MS))))
        .limit(100)
        .for('update', { skipLocked: true });
      for (const sub of soon) {
        const carers = await tx.select({ id: devices.id }).from(devices).where(and(eq(devices.userId, sub.userId), isNull(devices.revokedAt)));
        const already = carers.length
          ? await tx.$count(notificationLog, and(inArray(notificationLog.deviceId, carers.map((c) => c.id)), eq(notificationLog.kind, 'billing'), sql`${notificationLog.data}->>'event' = 'cutoff_soon'`, gt(notificationLog.createdAt, sub.expiredAt ?? new Date(0))))
          : 1;
        if (!already) await tx.insert(notificationLog).values(carers.map((c) => ({ kind: 'billing' as const, deviceId: c.id, data: { event: 'cutoff_soon' } })));
      }
    });
  }
}
