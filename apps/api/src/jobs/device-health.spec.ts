import { deviceProblems, needsBackup, type DeviceState } from './device-health.js';

const now = new Date('2026-11-01T12:00:00Z');
const hours = (h: number) => new Date(now.getTime() + h * 3_600_000);
const healthy: DeviceState = { platform: 'android', lastSeenAt: hours(-1), scheduledThrough: hours(72), permNotifications: true, permExactAlarm: true, permBatteryUnrestricted: true, permTimeSensitive: null, pushInvalidAt: null };
const busy = { hasDoseWithin24h: true, lastPendingDoseAt: hours(100) };

describe('deviceProblems (09)', () => {
  it('reports nothing for a healthy phone', () => {
    expect(deviceProblems(healthy, busy, now)).toEqual([]);
  });
  it('no heartbeat: silent for over 6 h while doses are due in the next 24 h', () => {
    expect(deviceProblems({ ...healthy, lastSeenAt: hours(-7) }, busy, now)).toContain('no_heartbeat');
    expect(deviceProblems({ ...healthy, lastSeenAt: hours(-5) }, busy, now)).not.toContain('no_heartbeat');
    expect(deviceProblems({ ...healthy, lastSeenAt: hours(-7) }, { hasDoseWithin24h: false, lastPendingDoseAt: null }, now)).toEqual([]);
    expect(deviceProblems({ ...healthy, lastSeenAt: null }, busy, now)).toContain('no_heartbeat');
  });
  it('permission off: only a reported false counts, per platform', () => {
    expect(deviceProblems({ ...healthy, permExactAlarm: false }, busy, now)).toContain('permission_off');
    expect(deviceProblems({ ...healthy, permBatteryUnrestricted: false }, busy, now)).toContain('permission_off');
    expect(deviceProblems({ ...healthy, permNotifications: false }, busy, now)).toContain('permission_off');
    expect(deviceProblems({ ...healthy, permExactAlarm: null }, busy, now)).toEqual([]);
    const ios = { ...healthy, platform: 'ios' as const, permExactAlarm: null, permBatteryUnrestricted: null, permTimeSensitive: true };
    expect(deviceProblems(ios, busy, now)).toEqual([]);
    expect(deviceProblems({ ...ios, permTimeSensitive: false }, busy, now)).toContain('permission_off');
    expect(deviceProblems({ ...ios, permBatteryUnrestricted: false }, busy, now)).toEqual([]); // not an iOS requirement
  });
  it('window low: scheduled_through under 24 h away while doses exist beyond it', () => {
    expect(deviceProblems({ ...healthy, scheduledThrough: hours(12) }, busy, now)).toContain('window_low');
    expect(deviceProblems({ ...healthy, scheduledThrough: hours(12) }, { hasDoseWithin24h: true, lastPendingDoseAt: hours(10) }, now)).not.toContain('window_low');
    expect(deviceProblems({ ...healthy, scheduledThrough: null }, busy, now)).toContain('window_low');
    expect(deviceProblems({ ...healthy, scheduledThrough: hours(30) }, busy, now)).not.toContain('window_low');
  });
  it('invalid push token', () => {
    expect(deviceProblems({ ...healthy, pushInvalidAt: hours(-1) }, busy, now)).toEqual(['token_invalid']);
  });
  it('combines several problems', () => {
    expect(deviceProblems({ ...healthy, lastSeenAt: hours(-9), permExactAlarm: false, scheduledThrough: hours(1) }, busy, now)).toEqual(['no_heartbeat', 'permission_off', 'window_low']);
  });
});

describe('needsBackup (D-036)', () => {
  const dose = hours(0);
  it('a healthy phone never gets a duplicate', () => {
    expect(needsBackup(healthy, dose, now)).toBe(false);
  });
  it('the dose lies beyond what the phone scheduled, or it never reported', () => {
    expect(needsBackup({ ...healthy, scheduledThrough: hours(-1) }, dose, now)).toBe(true);
    expect(needsBackup({ ...healthy, scheduledThrough: null }, dose, now)).toBe(true);
  });
  it('the phone has been silent for 12 hours', () => {
    expect(needsBackup({ ...healthy, lastSeenAt: hours(-13) }, dose, now)).toBe(true);
    expect(needsBackup({ ...healthy, lastSeenAt: hours(-11) }, dose, now)).toBe(false);
  });
  it('a required permission is off or unknown', () => {
    expect(needsBackup({ ...healthy, permExactAlarm: false }, dose, now)).toBe(true);
    expect(needsBackup({ ...healthy, permBatteryUnrestricted: null }, dose, now)).toBe(true);
    expect(needsBackup({ ...healthy, platform: 'ios', permTimeSensitive: true }, dose, now)).toBe(false);
    expect(needsBackup({ ...healthy, platform: 'ios', permTimeSensitive: null }, dose, now)).toBe(true);
  });
});
