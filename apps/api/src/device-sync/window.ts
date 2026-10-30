// How many days of doses a phone is issued (docs/05-reminder-engine.md#window-size, D-038, D-078).
export const IOS_PENDING_LIMIT = 64; // per app, Apple staff Jan 2026 (R-39)
export const IOS_RESERVED_SLOTS = 4; // snoozes and ad-hoc
export const MIN_WINDOW_DAYS = 2;
export const MAX_WINDOW_DAYS = 14; // the generation horizon (D-034)
export const ANDROID_WINDOW_DAYS = 5;
export const FOLLOW_UP_MINUTES = 5; // Alarm follow-ups (D-025)

// Notification slots one dose uses at scheduling time: the dose itself, plus its Alarm follow-ups every 5 minutes
// until the missed delay. "Repeat" slots are 0 (D-078).
export function slotsPerDose(type: 'standard' | 'alarm' | 'gentle', delayMin: number): number {
  return type === 'alarm' ? 1 + Math.max(Math.ceil(delayMin / FOLLOW_UP_MINUTES) - 1, 0) : 1;
}

export function windowDays(platform: 'ios' | 'android', slotsPerDay: number): number {
  if (platform === 'android') return ANDROID_WINDOW_DAYS;
  if (slotsPerDay <= 0) return MAX_WINDOW_DAYS;
  const days = Math.floor((IOS_PENDING_LIMIT - IOS_RESERVED_SLOTS) / slotsPerDay);
  return Math.min(Math.max(days, MIN_WINDOW_DAYS), MAX_WINDOW_DAYS);
}
