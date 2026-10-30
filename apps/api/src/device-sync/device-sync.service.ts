import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import { FieldEncryption } from '../crypto/field-encryption.js';
import type { Db } from '../db/client.js';
import { DB } from '../db/database.module.js';
import { caregiverSettings, devices, doseInstances, medicines, patients, subscriptions } from '../db/schema.js';
import type { Principal } from '../common/principal.js';
import { MedicinesRepository } from '../medicines/medicines.repository.js';
import { PhotosService } from '../storage/photos.service.js';
import { MIN_WINDOW_DAYS, slotsPerDose, windowDays } from './window.js';

const LOOK_BACK_MS = 24 * 3_600_000; // recent doses stay visible on the Today screen

// docs/04-api.md#device-sync-and-answers. The phone replaces its whole scheduled set with what is issued here (05).
@Injectable()
export class DeviceSyncService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly medicineRepo: MedicinesRepository,
    private readonly encryption: FieldEncryption,
    private readonly photos: PhotosService,
    private readonly audit: AuditService,
  ) {}

  async sync(principal: Principal) {
    const now = new Date();
    const [device] = await this.db.update(devices).set({ lastSeenAt: sql`now()` }).where(and(eq(devices.id, principal.id), isNull(devices.revokedAt))).returning();
    const [patient] = await this.db.select().from(patients).where(eq(patients.id, principal.patientId!));
    const patientView = (lockscreen: string) => ({
      id: patient!.id,
      display_name: this.encryption.decrypt('patients.display_name', patient!.displayName),
      timezone: patient!.timezone,
      status: patient!.status,
      lockscreen_detail: lockscreen,
    });
    const [settings] = await this.db.select().from(caregiverSettings).where(eq(caregiverSettings.userId, patient!.ownerUserId));
    const [sub] = await this.db.select().from(subscriptions).where(eq(subscriptions.userId, patient!.ownerUserId));
    const lockscreen = patient!.lockscreenDetail ?? settings?.lockscreenDetail ?? 'full';

    // Suspended (07): cancel everything, issue nothing.
    if (patient!.status === 'suspended') {
      return { cursor: this.cursor(now, patient!.updatedAt), patient: patientView(lockscreen), account_state: 'suspended', medicines: [], doses: [], window: { from: now, through: now }, commands: ['cancel_all'] };
    }

    const meds = await this.db.select().from(medicines).where(and(eq(medicines.patientId, patient!.id), isNull(medicines.archivedAt))).orderBy(asc(medicines.createdAt));
    const schedules = await this.medicineRepo.schedules(meds.map((m) => m.id));
    const defaultDelay = settings?.defaultMissedDelayMin ?? 30;
    let slotsPerDay = 0;
    for (const m of meds) {
      const times = schedules.get(m.id)?.times.length ?? 0;
      slotsPerDay += times * slotsPerDose(m.notificationType, m.missedDelayMin ?? patient!.missedDelayMin ?? defaultDelay);
    }
    let days = Math.max(windowDays(device?.platform ?? 'android', slotsPerDay), MIN_WINDOW_DAYS);
    let through = new Date(now.getTime() + days * 86_400_000);
    // During the 1-day grace the window ends at cutoff, so a phone holds no alarms past it (D-087).
    const grace = sub?.status === 'grace';
    if (grace && sub?.cutoffAt && sub.cutoffAt < through) through = sub.cutoffAt;

    const rows = await this.db
      .select()
      .from(doseInstances)
      .where(and(eq(doseInstances.patientId, patient!.id), gte(doseInstances.scheduledAt, new Date(now.getTime() - LOOK_BACK_MS)), lte(doseInstances.scheduledAt, through)))
      .orderBy(asc(doseInstances.scheduledAt));
    const typeOf = new Map(meds.map((m) => [m.id, m.notificationType]));

    const medicineViews = [];
    const issued: string[] = [];
    for (const m of meds) {
      const photo = await this.photos.readUrl(m.photoObjectKey);
      if (photo) issued.push(m.id);
      medicineViews.push({
        id: m.id,
        name: this.encryption.decrypt('medicines.name', m.name),
        notes: m.notes ? this.encryption.decrypt('medicines.notes', m.notes) : null,
        notification_type: m.notificationType,
        photo,
      });
    }
    if (issued.length) {
      await this.db.transaction((tx) => this.audit.record(tx, { actorType: 'device', actorId: principal.id, patientId: patient!.id, action: 'photo.read_url_issued', meta: { medicines: issued } }));
    }

    const newest = rows.reduce((t, r) => Math.max(t, r.updatedAt.getTime()), patient!.updatedAt.getTime());
    return {
      cursor: this.cursor(now, new Date(newest)),
      patient: patientView(lockscreen),
      account_state: grace ? 'grace' : 'active',
      medicines: medicineViews,
      doses: rows.map((d) => ({
        id: d.id,
        medicine_id: d.medicineId,
        scheduled_at: d.scheduledAt,
        local_time: d.localTime.slice(0, 5),
        name: this.encryption.decrypt('dose_instances.name_snapshot', d.nameSnapshot),
        amount: d.amountSnapshot,
        status: d.status,
        snooze_until: d.snoozeUntil,
        alert_due_at: d.alertDueAt,
        notification_type: typeOf.get(d.medicineId) ?? 'standard',
      })),
      window: { from: now, through },
      commands: [] as string[],
    };
  }

  // Opaque. The phone stores it and may send it back; every sync returns the full issued window regardless.
  private cursor(now: Date, newest: Date): string {
    return Buffer.from(JSON.stringify({ n: newest.getTime(), s: now.getTime() })).toString('base64url');
  }
}
