// The rules from docs/09-missed-dose-alerts.md#device-problem-alerts. One definition feeds both the alert job and
// the health badge in the caregiver's device list, so the alert and the screen always agree.
export type Problem = 'no_heartbeat' | 'permission_off' | 'window_low' | 'token_invalid';

export const NO_HEARTBEAT_MS = 6 * 3_600_000; // D-047
export const WINDOW_LOW_MS = 24 * 3_600_000; // D-039
export const ALERT_THROTTLE_MS = 12 * 3_600_000; // D-047, D-093

export interface DeviceState {
  platform: 'ios' | 'android';
  lastSeenAt: Date | null;
  scheduledThrough: Date | null;
  permNotifications: boolean | null;
  permExactAlarm: boolean | null;
  permBatteryUnrestricted: boolean | null;
  permTimeSensitive: boolean | null;
  pushInvalidAt: Date | null;
}

export interface PatientDoseContext {
  hasDoseWithin24h: boolean;
  lastPendingDoseAt: Date | null;
}

// A permission only counts as off when the phone reported `false`. A phone that has not reported yet is covered
// by no_heartbeat later, so onboarding doesn't raise alerts. (Backup pushes are the opposite: unknown counts as off.)
export function deviceProblems(d: DeviceState, ctx: PatientDoseContext, now: Date): Problem[] {
  const out: Problem[] = [];
  if ((!d.lastSeenAt || d.lastSeenAt.getTime() < now.getTime() - NO_HEARTBEAT_MS) && ctx.hasDoseWithin24h) out.push('no_heartbeat');
  const required = d.platform === 'android' ? [d.permNotifications, d.permExactAlarm, d.permBatteryUnrestricted] : [d.permNotifications, d.permTimeSensitive]; // D-042, D-073, D-074
  if (required.some((p) => p === false)) out.push('permission_off');
  const through = d.scheduledThrough?.getTime() ?? 0;
  if (through < now.getTime() + WINDOW_LOW_MS && ctx.lastPendingDoseAt && ctx.lastPendingDoseAt.getTime() > Math.max(through, now.getTime())) out.push('window_low');
  if (d.pushInvalidAt) out.push('token_invalid');
  return out;
}

// Whether a due dose needs a backup push on this device (D-036, 05#conditional-push-backup).
export function needsBackup(d: DeviceState, doseScheduledAt: Date, now: Date): boolean {
  if (!d.scheduledThrough || doseScheduledAt.getTime() > d.scheduledThrough.getTime()) return true; // beyond what the phone scheduled
  if (!d.lastSeenAt || d.lastSeenAt.getTime() < now.getTime() - 12 * 3_600_000) return true; // silent for 12 h
  const required = d.platform === 'android' ? [d.permNotifications, d.permExactAlarm, d.permBatteryUnrestricted] : [d.permNotifications, d.permTimeSensitive];
  return required.some((p) => p !== true); // off, or never reported: take no chances
}
