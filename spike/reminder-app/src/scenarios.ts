// One function per roadmap Phase 0 test. Each logs what it scheduled so results can be
// compared against delivery times later (see ../README.md for the protocol).
import * as Notifications from 'expo-notifications';
import { logEvent } from './db';
import {
  cachedPhotoUrl,
  pendingCount,
  scheduleDose,
  type Delivery,
  type DoseType,
} from './notifications';

const MIN = 60_000;
const TYPES: DoseType[] = ['standard', 'alarm', 'gentle'];

function at(msFromNow: number): Date {
  return new Date(Date.now() + msFromNow);
}

export async function testInTenSeconds(): Promise<void> {
  for (const [i, type] of TYPES.entries()) {
    await scheduleDose({ doseId: `t10_${type}`, n: i + 1, type, fireAt: at(10_000 + i * 5_000) });
  }
  await logEvent('scenario', { name: 'test_10s', pending: await pendingCount() });
}

export type WindowPreset = { every: number; count: number; alarmFollowUps: number };
export const SHORT_WINDOW: WindowPreset = { every: 15, count: 12, alarmFollowUps: 3 };

function nextLocal(hour: number): Date {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d;
}

// docs/12-testing-and-slos.md "Device test script" step 1: Standard, Alarm with a
// 30-minute delay (6 follow-ups), Gentle, two doses 1 minute apart, one at 03:00.
// 07:00 is added so a lock-screen answer can be given after the overnight run.
export async function deviceTestScript(): Promise<void> {
  const doses = [
    { doseId: 'dt_standard', type: 'standard' as const, fireAt: at(3 * MIN) },
    { doseId: 'dt_alarm', type: 'alarm' as const, fireAt: at(6 * MIN), followUps: 6 },
    { doseId: 'dt_gentle', type: 'gentle' as const, fireAt: at(9 * MIN) },
    { doseId: 'dt_pair_a', type: 'standard' as const, fireAt: at(12 * MIN) },
    { doseId: 'dt_pair_b', type: 'standard' as const, fireAt: at(13 * MIN) },
    { doseId: 'dt_0300', type: 'alarm' as const, fireAt: nextLocal(3), followUps: 6 },
    { doseId: 'dt_0700', type: 'standard' as const, fireAt: nextLocal(7) },
  ];
  for (const [i, d] of doses.entries()) await scheduleDose({ ...d, n: i + 1 });
  await logEvent('scenario', {
    name: 'device_test_script',
    doses: doses.map((d) => ({ id: d.doseId, type: d.type, at: d.fireAt.toISOString() })),
    pending: await pendingCount(),
  });
}

// Fixed dose IDs (w_<i>), cycling through the three types. Calling this twice must leave
// the pending count unchanged: re-sync replaces by identifier (D-035).
// The start time is pinned on first schedule so re-sync reuses the same fire times.
let windowStart: number | null = null;

export async function scheduleWindow(preset: WindowPreset, resync = false): Promise<void> {
  const before = await pendingCount();
  if (!resync || windowStart === null) windowStart = Date.now() + 2 * MIN;
  for (let i = 0; i < preset.count; i++) {
    const type = TYPES[i % TYPES.length];
    await scheduleDose({
      doseId: `w_${i}`,
      n: i + 1,
      type,
      fireAt: new Date(windowStart + i * preset.every * MIN),
      followUps: type === 'alarm' ? preset.alarmFollowUps : 0,
    });
  }
  await logEvent('scenario', {
    name: resync ? 'window_resync' : 'window',
    preset,
    start: new Date(windowStart).toISOString(),
    pending_before: before,
    pending_after: await pendingCount(),
  });
}

export async function alarmSeries(): Promise<void> {
  await scheduleDose({ doseId: 'alarm_series', n: 1, type: 'alarm', fireAt: at(2 * MIN), followUps: 6 });
  await logEvent('scenario', { name: 'alarm_series', follow_ups: 6, every_min: 5 });
}

// D-072 open question: do Standard/Gentle need alarmClock when doses fall within 9 minutes?
// Run once per delivery mode with the phone in Doze (adb dumpsys deviceidle force-idle).
export async function dozeCluster(delivery: Delivery): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await scheduleDose({
      doseId: `doze_${delivery}_${i}`,
      n: i + 1,
      type: 'standard',
      fireAt: at(5 * MIN + i * 3 * MIN),
      delivery,
    });
  }
  await logEvent('scenario', { name: 'doze_cluster', delivery, offsets_min: [5, 8, 11] });
}

// D-078: confirm the 64-pending limit and which requests survive on the current iOS.
export async function fillTo70(): Promise<void> {
  const base = Date.now() + 24 * 60 * MIN;
  for (let i = 0; i < 70; i++) {
    await scheduleDose({ doseId: `cap_${i}`, n: i + 1, type: 'gentle', fireAt: new Date(base + i * MIN) });
  }
  const pending = await Notifications.getAllScheduledNotificationsAsync();
  const kept = new Set(pending.map((p) => p.identifier));
  const dropped = Array.from({ length: 70 }, (_, i) => `cap_${i}`).filter((id) => !kept.has(id));
  await logEvent('scenario', { name: 'fill_70', pending_total: pending.length, dropped });
}

export async function photoAttachment(): Promise<void> {
  const url = await cachedPhotoUrl();
  await scheduleDose({ doseId: 'photo_1', n: 1, type: 'standard', fireAt: at(30_000), attachmentUrl: url });
  await logEvent('scenario', { name: 'photo_attachment', url });
}

export async function cancelAll(): Promise<void> {
  await Notifications.cancelAllScheduledNotificationsAsync();
  windowStart = null;
  await logEvent('scenario', { name: 'cancel_all' });
}
