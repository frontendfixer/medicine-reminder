import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { DB } from '../db/database.module.js';
import { devices, doseInstances, notificationLog, patients } from '../db/schema.js';
import { ALERT_THROTTLE_MS, deviceProblems, type PatientDoseContext, type Problem } from './device-health.js';

type DeviceRow = typeof devices.$inferSelect;

@Injectable()
export class HealthService {
  constructor(@Inject(DB) private readonly db: Db) {}

  // Problems per device, for the alert job and for the caregiver's device list (same rules, same answer).
  async problemsFor(rows: DeviceRow[], now = new Date()): Promise<Map<string, Problem[]>> {
    const out = new Map<string, Problem[]>();
    const active = rows.filter((d) => !d.revokedAt && d.patientId);
    if (!active.length) return out;
    const patientIds = [...new Set(active.map((d) => d.patientId!))];
    const stats = await this.db
      .select({
        patientId: doseInstances.patientId,
        soon: sql<boolean>`bool_or(${doseInstances.scheduledAt} <= ${new Date(now.getTime() + 24 * 3_600_000)})`,
        last: sql<Date | null>`max(${doseInstances.scheduledAt})`,
      })
      .from(doseInstances)
      .where(and(inArray(doseInstances.patientId, patientIds), inArray(doseInstances.status, ['pending', 'snoozed']), gt(doseInstances.scheduledAt, now)))
      .groupBy(doseInstances.patientId);
    const ctx = new Map<string, PatientDoseContext>(stats.map((s) => [s.patientId, { hasDoseWithin24h: s.soon, lastPendingDoseAt: s.last ? new Date(s.last) : null }]));
    for (const d of active) out.set(d.id, deviceProblems(d, ctx.get(d.patientId!) ?? { hasDoseWithin24h: false, lastPendingDoseAt: null }, now));
    return out;
  }

  // Every 15 minutes (09): tell the owner about unhealthy phones, at most once per 12 hours per phone, and ask a phone
  // with a low window to open the app (D-039, D-093).
  async alertUnhealthy(now = new Date()): Promise<number> {
    const phones = await this.db
      .select({ device: devices, patient: patients })
      .from(devices)
      .innerJoin(patients, and(eq(patients.id, devices.patientId), eq(patients.status, 'active')))
      .where(isNull(devices.revokedAt));
    const problems = await this.problemsFor(phones.map((p) => p.device), now);
    const since = new Date(now.getTime() - ALERT_THROTTLE_MS);
    let alerted = 0;

    for (const { device, patient } of phones) {
      const found = problems.get(device.id) ?? [];
      if (!found.length) continue;
      await this.db.transaction(async (tx) => {
        await tx.execute(sql`select 1 from devices where id = ${device.id} for update`); // serialises two workers on one phone
        const recent = (kind: 'device_health' | 'window_low') =>
          tx.$count(notificationLog, and(eq(notificationLog.kind, kind), gt(notificationLog.createdAt, since), kind === 'device_health' ? sql`${notificationLog.data}->>'device_id' = ${device.id}` : eq(notificationLog.deviceId, device.id)));
        if (!(await recent('device_health'))) {
          const carers = await tx.select({ id: devices.id }).from(devices).where(and(eq(devices.userId, patient.ownerUserId), isNull(devices.revokedAt)));
          if (carers.length) {
            await tx.insert(notificationLog).values(carers.map((c) => ({ kind: 'device_health' as const, patientId: patient.id, deviceId: c.id, data: { problems: found, device_id: device.id, device_label: device.label } })));
            alerted++;
          }
        }
        if (found.includes('window_low') && !(await recent('window_low'))) await tx.insert(notificationLog).values({ kind: 'window_low', patientId: patient.id, deviceId: device.id });
      });
    }
    return alerted;
  }
}
