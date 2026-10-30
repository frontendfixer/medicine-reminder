import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import { LoginThrottle } from '../auth/login-throttle.js';
import { PasswordService } from '../auth/password.service.js';
import { ApiException } from '../common/api-exception.js';
import { FieldEncryption } from '../crypto/field-encryption.js';
import type { Db } from '../db/client.js';
import { DB } from '../db/database.module.js';
import { auditLog, authSessions, caregiverSettings, consents, devices, doseInstances, idempotencyKeys, medicines, notificationLog, pairingCodes, patients, scheduleTimes, scheduleVersions, subscriptions, users } from '../db/schema.js';
import { RateLimiter } from '../redis/rate-limiter.js';
import { PhotosService } from '../storage/photos.service.js';

const EXPORTS_PER_DAY = 3;
const EXPORT_LINK_SECONDS = 15 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const exportKey = (userId: string, requestId: string) => `exports/${userId}/${requestId}.json`;

// docs/10-security-privacy.md#dpdp-mapping: access (export) and erasure (deletion), D-067, D-081.
@Injectable()
export class PrivacyService {
  private readonly log = new Logger(PrivacyService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly encryption: FieldEncryption,
    private readonly photos: PhotosService,
    private readonly passwords: PasswordService,
    private readonly throttle: LoginThrottle,
    private readonly limiter: RateLimiter,
    private readonly audit: AuditService,
  ) {}

  async requestExport(userId: string) {
    await this.limiter.hit(`export:${userId}`, EXPORTS_PER_DAY, 24 * 3_600_000);
    const requestId = randomUUID();
    const body = Buffer.from(JSON.stringify(await this.collect(userId), null, 2));
    await this.photos.putExport(exportKey(userId, requestId), body);
    await this.db.transaction((tx) => this.audit.record(tx, { actorType: 'caregiver', actorId: userId, action: 'account.export_requested', meta: { request_id: requestId } }));
    return { request_id: requestId };
  }

  // The in-app download link (D-067): short-lived, and only for the caller's own export.
  async getExport(userId: string, requestId: string) {
    const key = exportKey(userId, UUID.test(requestId) ? requestId : 'invalid');
    if (!UUID.test(requestId) || !(await this.photos.exists(key))) throw new ApiException('NOT_FOUND', 'Not found.');
    return { request_id: requestId, status: 'ready', download_url: await this.photos.signedGet(key, EXPORT_LINK_SECONDS), expires_at: new Date(Date.now() + EXPORT_LINK_SECONDS * 1000) };
  }

  // Everything the service holds about this caregiver and the patients they manage, decrypted. No password hash, token
  // hash or push token: those are credentials, not the person's data.
  private async collect(userId: string) {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId));
    const [settings] = await this.db.select().from(caregiverSettings).where(eq(caregiverSettings.userId, userId));
    const [sub] = await this.db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
    const ownPatients = await this.db.select().from(patients).where(eq(patients.ownerUserId, userId)).orderBy(asc(patients.createdAt));
    const ids = ownPatients.map((p) => p.id);
    const meds = ids.length ? await this.db.select().from(medicines).where(inArray(medicines.patientId, ids)).orderBy(asc(medicines.createdAt)) : [];
    const versions = meds.length ? await this.db.select().from(scheduleVersions).where(inArray(scheduleVersions.medicineId, meds.map((m) => m.id))).orderBy(asc(scheduleVersions.effectiveFrom)) : [];
    const times = versions.length ? await this.db.select().from(scheduleTimes).where(inArray(scheduleTimes.scheduleVersionId, versions.map((v) => v.id))) : [];
    const doses = ids.length ? await this.db.select().from(doseInstances).where(inArray(doseInstances.patientId, ids)).orderBy(asc(doseInstances.scheduledAt)) : [];
    const phones = ids.length ? await this.db.select().from(devices).where(inArray(devices.patientId, ids)) : [];
    const audits = await this.db.select().from(auditLog).where(or(eq(auditLog.actorId, userId), ids.length ? inArray(auditLog.patientId, ids) : undefined)).orderBy(asc(auditLog.createdAt));
    const consentRows = await this.db.select().from(consents).where(or(eq(consents.userId, userId), ids.length ? inArray(consents.patientId, ids) : undefined));

    return {
      exported_at: new Date(),
      account: { id: user!.id, email: user!.email, created_at: user!.createdAt },
      settings: settings && { default_missed_delay_min: settings.defaultMissedDelayMin, lockscreen_detail: settings.lockscreenDetail },
      subscription: sub && { plan: sub.plan, status: sub.status, renews_at: sub.renewsAt, expired_at: sub.expiredAt },
      consents: consentRows.map((c) => ({ subject_type: c.subjectType, kind: c.kind, notice_version: c.noticeVersion, given_at: c.givenAt, withdrawn_at: c.withdrawnAt })),
      patients: ownPatients.map((p) => ({
        id: p.id,
        display_name: this.encryption.decrypt('patients.display_name', p.displayName),
        type: p.type,
        status: p.status,
        timezone: p.timezone,
        tz_mode: p.tzMode,
        missed_delay_min: p.missedDelayMin,
        created_at: p.createdAt,
        devices: phones.filter((d) => d.patientId === p.id).map((d) => ({ platform: d.platform, label: d.label, app_version: d.appVersion, created_at: d.createdAt, revoked_at: d.revokedAt })),
        medicines: meds
          .filter((m) => m.patientId === p.id)
          .map((m) => ({
            id: m.id,
            name: this.encryption.decrypt('medicines.name', m.name),
            notes: m.notes ? this.encryption.decrypt('medicines.notes', m.notes) : null,
            notification_type: m.notificationType,
            missed_delay_min: m.missedDelayMin,
            has_photo: !!m.photoObjectKey,
            archived_at: m.archivedAt,
            schedules: versions
              .filter((v) => v.medicineId === m.id)
              .map((v) => ({ pattern: v.pattern, days_of_week: v.daysOfWeek, interval_days: v.intervalDays, start_date: v.startDate, end_date: v.endDate, effective_from: v.effectiveFrom, effective_until: v.effectiveUntil, times: times.filter((t) => t.scheduleVersionId === v.id).map((t) => ({ local_time: t.localTime.slice(0, 5), amount_text: t.amountText })) })),
          })),
        doses: doses
          .filter((d) => d.patientId === p.id)
          .map((d) => ({ scheduled_at: d.scheduledAt, medicine: this.encryption.decrypt('dose_instances.name_snapshot', d.nameSnapshot), amount: d.amountSnapshot, status: d.status, responded_at: d.respondedAt })),
      })),
      activity_log: audits.map((a) => ({ action: a.action, at: a.createdAt, patient_id: a.patientId })),
    };
  }

  // Erases the caregiver's data and their patients' data (D-081), keeping audit and notification logs for the
  // legal minimum with their links to people removed (Rule 8(3), C-10). The user row is anonymised in place, not
  // deleted, so those logs and the consent records stay valid.
  async deleteAccount(userId: string, password: string): Promise<{ status: 'deleted' }> {
    const [user] = await this.db.select().from(users).where(and(eq(users.id, userId), isNull(users.deletedAt)));
    if (!user) throw new ApiException('UNAUTHENTICATED', 'Sign in to continue.');
    await this.throttle.reserve(user.email); // a stolen session must not be able to guess the password here
    if (!(await this.passwords.verify(user.passwordHash, password))) throw new ApiException('INVALID_CREDENTIALS', 'The password is wrong.');
    await this.throttle.reset(user.email);

    const photoKeys = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select 1 from users where id = ${userId} for update`);
      const owned = await tx.select({ id: patients.id }).from(patients).where(eq(patients.ownerUserId, userId));
      const patientIds = owned.map((p) => p.id);
      const carerDevices = (await tx.select({ id: devices.id }).from(devices).where(eq(devices.userId, userId))).map((d) => d.id);
      const phoneIds = patientIds.length ? (await tx.select({ id: devices.id }).from(devices).where(inArray(devices.patientId, patientIds))).map((d) => d.id) : [];
      const allDevices = [...carerDevices, ...phoneIds];
      const meds = patientIds.length ? await tx.select({ id: medicines.id, photo: medicines.photoObjectKey }).from(medicines).where(inArray(medicines.patientId, patientIds)) : [];
      const medIds = meds.map((m) => m.id);

      // Logs stay, minus everything that points at a person, a phone or a dose.
      const logScope = or(patientIds.length ? inArray(notificationLog.patientId, patientIds) : undefined, allDevices.length ? inArray(notificationLog.deviceId, allDevices) : undefined);
      if (logScope) await tx.update(notificationLog).set({ patientId: null, deviceId: null, doseInstanceId: null, data: null }).where(logScope);
      const consentScope = or(patientIds.length ? inArray(consents.patientId, patientIds) : undefined, allDevices.length ? inArray(consents.deviceId, allDevices) : undefined);
      if (consentScope) await tx.update(consents).set({ patientId: null, deviceId: null }).where(consentScope);

      if (patientIds.length) await tx.delete(doseInstances).where(inArray(doseInstances.patientId, patientIds));
      if (medIds.length) {
        const versionIds = (await tx.select({ id: scheduleVersions.id }).from(scheduleVersions).where(inArray(scheduleVersions.medicineId, medIds))).map((v) => v.id);
        if (versionIds.length) await tx.delete(scheduleTimes).where(inArray(scheduleTimes.scheduleVersionId, versionIds));
        await tx.delete(scheduleVersions).where(inArray(scheduleVersions.medicineId, medIds));
        await tx.delete(medicines).where(inArray(medicines.id, medIds));
      }
      if (patientIds.length) await tx.delete(pairingCodes).where(inArray(pairingCodes.patientId, patientIds));
      await tx.delete(authSessions).where(eq(authSessions.userId, userId)); // sign-out everywhere, now
      if (allDevices.length) await tx.delete(devices).where(inArray(devices.id, allDevices));
      if (patientIds.length) await tx.delete(patients).where(inArray(patients.id, patientIds));
      await tx.delete(caregiverSettings).where(eq(caregiverSettings.userId, userId));
      await tx.delete(idempotencyKeys).where(inArray(idempotencyKeys.principal, [userId, ...allDevices]));

      await tx
        .update(users)
        .set({ email: `deleted-${userId}@deleted.invalid`, passwordHash: 'deleted', deletedAt: sql`now()` })
        .where(eq(users.id, userId));
      await this.audit.record(tx, { actorType: 'caregiver', actorId: userId, action: 'account.deletion_requested', targetType: 'user', targetId: userId, meta: { patients: patientIds.length } });
      return meds.map((m) => m.photo).filter((k): k is string => !!k);
    });

    // After commit: files. A failure leaves an orphan for a cleanup sweep, never data the person can still reach.
    for (const key of photoKeys) this.photos.deleteQuietly(key);
    this.log.log(`Account deleted (${photoKeys.length} photos queued for removal)`);
    return { status: 'deleted' };
  }
}
