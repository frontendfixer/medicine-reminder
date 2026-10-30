import { FieldEncryption } from '../crypto/field-encryption.js';
import type { DeviceRow, PatientRow } from './patients.repository.js';

// DeviceSummary (docs/04-api.md#devices). `healthy` and `problems` arrive with the device-health job (Phase 4).
export function deviceSummary(d: DeviceRow) {
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
    created_at: d.createdAt,
    revoked_at: d.revokedAt,
  };
}

export function patientView(row: PatientRow, devices: DeviceRow[], encryption: FieldEncryption) {
  return {
    id: row.id,
    display_name: encryption.decrypt('patients.display_name', row.displayName),
    type: row.type,
    timezone: row.timezone,
    tz_mode: row.tzMode,
    missed_delay_min: row.missedDelayMin,
    lockscreen_detail: row.lockscreenDetail,
    status: row.status,
    devices: devices.map(deviceSummary),
    created_at: row.createdAt,
  };
}
