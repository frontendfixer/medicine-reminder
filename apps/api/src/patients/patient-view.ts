import { FieldEncryption } from '../crypto/field-encryption.js';
import type { DeviceRow, PatientRow } from './patients.repository.js';

// DeviceSummary (docs/04-api.md#devices). `healthy` and `problems` use the same rules as the device-health alerts (09).
export function deviceSummary(d: DeviceRow, problems: readonly string[] = []) {
  return {
    id: d.id,
    platform: d.platform,
    label: d.label,
    app_version: d.appVersion,
    last_seen_at: d.lastSeenAt,
    scheduled_through: d.scheduledThrough,
    permissions: {
      notifications: d.permNotifications,
      exact_alarm: d.permExactAlarm,
      battery_unrestricted: d.permBatteryUnrestricted,
      time_sensitive: d.permTimeSensitive,
    },
    healthy: problems.length === 0,
    problems,
    created_at: d.createdAt,
    revoked_at: d.revokedAt,
  };
}

export function patientView(row: PatientRow, devices: DeviceRow[], encryption: FieldEncryption, problems: ReadonlyMap<string, readonly string[]> = new Map()) {
  return {
    id: row.id,
    display_name: encryption.decrypt('patients.display_name', row.displayName),
    type: row.type,
    timezone: row.timezone,
    tz_mode: row.tzMode,
    missed_delay_min: row.missedDelayMin,
    lockscreen_detail: row.lockscreenDetail,
    status: row.status,
    devices: devices.map((d) => deviceSummary(d, problems.get(d.id))),
    created_at: row.createdAt,
  };
}
