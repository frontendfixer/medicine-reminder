import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { DosesService } from '../doses/doses.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AppConfigService } from '../app-config/app-config.service.js';
import type { Principal } from '../common/principal.js';
import type { Db } from '../db/client.js';
import { DB } from '../db/database.module.js';
import { authSessions, devices, patients } from '../db/schema.js';
import { deviceSummary } from '../patients/patient-view.js';
import { PatientsRepository, patientNotFound } from '../patients/patients.repository.js';
import type { HeartbeatBody } from './devices.dto.js';

const SYNC_WINDOW_HOURS = 48; // ask a phone to sync when its scheduled window ends sooner than this (05)

@Injectable()
export class DevicesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly patients: PatientsRepository,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    private readonly doses: DosesService,
  ) {}

  async listForPatient(userId: string, patientId: string) {
    const patient = await this.patients.findOwned(userId, patientId);
    const rows = await this.db.select().from(devices).where(eq(devices.patientId, patient.id)).orderBy(asc(devices.createdAt));
    return { items: rows.map(deviceSummary) };
  }

  async revoke(userId: string, deviceId: string) {
    return this.db.transaction(async (tx) => {
      // Only a patient device of a patient this caregiver owns. Anything else is a 404.
      const [row] = await tx
        .select({ device: devices, patientId: patients.id })
        .from(devices)
        .innerJoin(patients, eq(patients.id, devices.patientId))
        .where(and(eq(devices.id, deviceId), eq(patients.ownerUserId, userId)))
        .for('update', { of: devices });
      if (!row) throw patientNotFound();
      let device = row.device;
      if (!device.revokedAt) {
        [device] = await tx.update(devices).set({ revokedAt: sql`now()` }).where(eq(devices.id, device.id)).returning() as [typeof device];
        await this.audit.record(tx, { actorType: 'caregiver', actorId: userId, patientId: row.patientId, action: 'device.revoked', targetType: 'device', targetId: device.id, meta: { reason: 'caregiver' } });
      }
      return deviceSummary(device);
    });
  }

  // D-041. Works for a patient device and for the caregiver's own phone.
  async heartbeat(principal: Principal, body: HeartbeatBody) {
    const deviceId = principal.type === 'device' ? principal.id : await this.caregiverDeviceId(principal.sessionId!);
    const scheduledThrough = body.scheduled_through ? new Date(body.scheduled_through) : null;
    const [device] = await this.db
      .update(devices)
      .set({
        ...(body.push_token ? { pushToken: body.push_token, pushInvalidAt: null } : {}),
        appVersion: body.app_version,
        tz: body.tz,
        permNotifications: body.permissions.notifications,
        permExactAlarm: body.permissions.exact_alarm ?? null,
        permBatteryUnrestricted: body.permissions.battery_unrestricted ?? null,
        permTimeSensitive: body.permissions.time_sensitive ?? null,
        scheduledThrough,
        lastSeenAt: sql`now()`,
      })
      .where(and(eq(devices.id, deviceId), isNull(devices.revokedAt)))
      .returning();

    if (device && principal.type === 'device') await this.followDeviceTimezone(device.patientId!, body.tz);

    const platform = device?.platform ?? 'android';
    return {
      server_time: new Date(),
      // The phone's scheduled window runs out soon, or it never reported one.
      sync_needed: !scheduledThrough || scheduledThrough.getTime() < Date.now() + SYNC_WINDOW_HOURS * 3_600_000,
      min_app_version: this.config.minVersion(platform),
    };
  }

  private async caregiverDeviceId(sessionId: string): Promise<string> {
    const [s] = await this.db.select({ deviceId: authSessions.deviceId }).from(authSessions).where(eq(authSessions.id, sessionId));
    return s?.deviceId ?? '00000000-0000-0000-0000-000000000000';
  }

  // D-086: with follow_device the patient's timezone is the one reported by the most recently seen device,
  // which is the one that just checked in. Future pending doses are rebuilt in the new zone.
  private async followDeviceTimezone(patientId: string, tz: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [p] = await tx.select().from(patients).where(eq(patients.id, patientId)).for('update');
      if (!p || p.tzMode !== 'follow_device' || p.timezone === tz || p.status !== 'active') return;
      await tx.update(patients).set({ timezone: tz, updatedAt: sql`now()` }).where(eq(patients.id, patientId));
      await this.doses.regeneratePatient(tx, patientId);
      await this.audit.record(tx, { actorType: 'system', patientId, action: 'patient.timezone_changed', targetType: 'patient', targetId: patientId, meta: { source: 'device' } });
    });
  }
}
