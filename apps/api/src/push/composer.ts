import { Inject, Injectable } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import { FieldEncryption } from '../crypto/field-encryption.js';
import type { Db } from '../db/client.js';
import { DB } from '../db/database.module.js';
import { devices, doseInstances, medicines, notificationLog, patients } from '../db/schema.js';
import { t } from '../i18n/t.js';
import type { PushMessage } from './push-transport.js';

type Row = typeof notificationLog.$inferSelect;
type Data = Record<string, unknown>;

const CHANNEL = { standard: 'dose_standard_v1', alarm: 'dose_alarm_v1', gentle: 'dose_gentle_v1' } as const; // D-026
export const CAREGIVER_CHANNEL = 'caregiver_alerts_v1';

// Message parameters come from a JSON column, so check their type instead of stringifying whatever is there.
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

export function formatTime(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(d);
}

// Builds the push for a queued notification_log row. Remote pushes carry generic text plus IDs (D-077): a patient's
// first name or a phone label at most, never a medicine name, amount or note. The app shows details from its own data.
@Injectable()
export class NotificationComposer {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly encryption: FieldEncryption,
  ) {}

  // Returns messages keyed by row ID; rows that cannot be composed (device gone, no token) are absent.
  async compose(rows: Row[]): Promise<Map<string, PushMessage>> {
    const out = new Map<string, PushMessage>();
    if (!rows.length) return out;
    const deviceRows = await this.db.select().from(devices).where(inArray(devices.id, [...new Set(rows.map((r) => r.deviceId).filter((x): x is string => !!x))]));
    const patientIds = [...new Set(rows.map((r) => r.patientId).filter((x): x is string => !!x))];
    const patientRows = patientIds.length ? await this.db.select().from(patients).where(inArray(patients.id, patientIds)) : [];
    const doseIds = [...new Set(rows.map((r) => r.doseInstanceId).filter((x): x is string => !!x))];
    const doseRows = doseIds.length ? await this.db.select({ dose: doseInstances, type: medicines.notificationType }).from(doseInstances).innerJoin(medicines, eq(medicines.id, doseInstances.medicineId)).where(inArray(doseInstances.id, doseIds)) : [];

    const device = new Map(deviceRows.map((d) => [d.id, d]));
    const patient = new Map(patientRows.map((p) => [p.id, p]));
    const dose = new Map(doseRows.map((d) => [d.dose.id, d]));

    for (const row of rows) {
      const target = row.deviceId ? device.get(row.deviceId) : undefined;
      const toOldPhone = (row.data as Data | null)?.event === 'signed_in_elsewhere'; // the one message meant for a phone we just signed out
      if (!target?.pushToken || target.pushInvalidAt || (target.revokedAt && !toOldPhone)) continue;
      const p = row.patientId ? patient.get(row.patientId) : undefined;
      const d = row.doseInstanceId ? dose.get(row.doseInstanceId) : undefined;
      const message = this.build(row, target.pushToken, p && { id: p.id, name: this.encryption.decrypt('patients.display_name', p.displayName), timezone: p.timezone }, d, (row.data ?? {}) as Data);
      if (message) out.set(row.id, message);
    }
    return out;
  }

  private build(row: Row, to: string, p: { id: string; name: string; timezone: string } | undefined, d: { dose: typeof doseInstances.$inferSelect; type: keyof typeof CHANNEL } | undefined, data: Data): PushMessage | null {
    const time = d && p ? formatTime(d.dose.scheduledAt, p.timezone) : '';
    const caregiver = { channelId: CAREGIVER_CHANNEL, priority: 'high' as const, sound: 'default' as const, interruptionLevel: 'time-sensitive' as const };

    switch (row.kind) {
      case 'backup': {
        if (!d || !p) return null;
        const ttl = Math.max(Math.floor((d.dose.alertDueAt.getTime() - Date.now()) / 1000), 60); // no use after the deadline
        return {
          to,
          title: t('push.backup.title'),
          body: t('push.backup.body', { time }),
          data: { type: 'dose', dose_id: d.dose.id, patient_id: p.id },
          priority: 'high',
          channelId: CHANNEL[d.type],
          categoryId: 'dose_v1',
          sound: 'default',
          interruptionLevel: d.type === 'gentle' ? 'active' : 'time-sensitive', // D-027, D-094
          collapseId: d.dose.id,
          ttl,
        };
      }
      case 'missed': {
        if (!p) return null;
        const count = Number(data.count ?? 1);
        return {
          to,
          title: t('push.missed.title'),
          body: count > 1 ? t('push.missed.many', { count, patient: p.name, time: str(data.first_time, time) }) : t('push.missed.one', { patient: p.name, time: str(data.first_time, time) }),
          data: { type: 'missed', patient_id: p.id, dose_id: row.doseInstanceId },
          collapseId: row.groupKey ?? undefined,
          tag: row.groupKey ?? undefined,
          ...caregiver,
        };
      }
      case 'not_taken':
        if (!p || !d) return null;
        return { to, title: t('push.not_taken.title'), body: t('push.not_taken.body', { patient: p.name, time }), data: { type: 'not_taken', patient_id: p.id, dose_id: d.dose.id }, ...caregiver };
      case 'correction': {
        if (!p || !d || !d.dose.respondedAt) return null;
        const answer = d.dose.status === 'not_taken' ? 'push.correction.not_taken' : 'push.correction.taken';
        return { to, title: t('push.correction.title'), body: t(answer, { patient: p.name, time, answeredAt: formatTime(d.dose.respondedAt, p.timezone) }), data: { type: 'correction', patient_id: p.id, dose_id: d.dose.id }, ...caregiver };
      }
      case 'device_health': {
        if (!p) return null;
        const problems = (Array.isArray(data.problems) ? data.problems : []).map((x) => t(`push.device_health.problem.${str(x)}` as 'push.device_health.problem.no_heartbeat'));
        return {
          to,
          title: t('push.device_health.title'),
          body: t('push.device_health.body', { patient: p.name, device: str(data.device_label, t('device.unknown')), problems: problems.join('; ') }),
          data: { type: 'device_health', patient_id: p.id, device_id: data.device_id },
          ...caregiver,
        };
      }
      case 'window_low':
        return { to, title: t('push.window_low.title'), body: t('push.window_low.body'), data: { type: 'window_low' }, priority: 'high', sound: 'default' }; // D-039, D-093
      case 'pairing': {
        if (str(data.event) === 'signed_in_elsewhere') return { to, title: t('push.pairing.title'), body: t('push.pairing.signed_in_elsewhere'), data: { type: 'signed_in_elsewhere' }, priority: 'high', sound: 'default' };
        if (!p) return null;
        const event = str(data.event);
        const body =
          event === 'connected' ? t('push.pairing.connected', { patient: p.name, device: str(data.device_label, t('device.unknown')) }) : event === 'timezone_changed' ? t('push.pairing.timezone_changed', { patient: p.name, timezone: str(data.timezone, p.timezone) }) : t('push.pairing.token_rejected', { patient: p.name });
        return { to, title: t('push.pairing.title'), body, data: { type: 'pairing', event, patient_id: p.id }, ...caregiver };
      }
      case 'billing': {
        const key = ({ expired: 'push.billing.expired', cutoff_soon: 'push.billing.cutoff_soon', suspended: 'push.billing.suspended' } as const)[str(data.event) as 'expired'];
        return key ? { to, title: t('push.billing.title'), body: t(key), data: { type: 'billing', event: data.event }, ...caregiver } : null;
      }
      case 'sync':
        // Data only, no text. Best effort (D-075): the next sync converges either way.
        return { to, data: { type: data.command ?? 'sync', dose_id: row.doseInstanceId ?? undefined }, priority: 'high', contentAvailable: true, ttl: 3600 };
    }
  }
}
