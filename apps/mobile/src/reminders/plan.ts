import type { NotificationType } from '@med/shared';
import { t } from '../i18n';
import { SNOOZE_MS, type LocalDose } from './store';

// Turns the doses the server issued into the exact set of local notifications (docs/05-reminder-engine.md#device-scheduling).
// Pure: no clock, no phone. The notification identifier is the dose ID (D-035), so scheduling again replaces, never duplicates.

export const FOLLOW_UP_MS = 5 * 60_000; // Alarm follow-ups (D-025)
export const IOS_BUDGET = 64 - 4; // 64 pending per app, 4 kept for snoozes and ad-hoc (D-038)
export const ANDROID_GUARD = 450; // Android allows about 500 alarms per app; the 5-day window is far below this
const DAY = 86_400_000;

export const CHANNEL: Record<NotificationType, string> = { standard: 'dose_standard_v1', alarm: 'dose_alarm_v1', gentle: 'dose_gentle_v1' }; // D-026
export const CATEGORY = 'dose_v1'; // no ':' or '-' in category IDs (R-02)
export const CATEGORY_NO_SNOOZE = 'dose_nosnooze_v1';
export const ALARM_SOUND = 'dose_alarm.wav';
export const ID_PREFIX = 'dose:';

export type Kind = 'dose' | 'followUp' | 'snooze';
export interface Planned {
  identifier: string;
  doseId: string;
  kind: Kind;
  fireAt: number;
  title: string;
  body: string;
  channelId: string;
  categoryId: string;
  delivery: 'alarmClock' | 'bestEffort';
  sound: 'default' | string | null;
  interruptionLevel: 'active' | 'timeSensitive';
  hash: string;
}
export interface Plan {
  planned: Planned[];
  scheduledThrough: number | null;
  dropped: number;
}
export interface PlanInput {
  doses: LocalDose[];
  now: number;
  platform: 'ios' | 'android';
  lockscreen: 'full' | 'generic';
  windowThrough: number;
}

export const doseIdOf = (identifier: string): string | null => (identifier.startsWith(ID_PREFIX) ? identifier.slice(ID_PREFIX.length).split(':')[0]! : null);

// FNV-1a: a short fingerprint of everything that decides how a notification looks and when it fires.
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

function make(dose: LocalDose, kind: Kind, identifier: string, fireAt: number, lockscreen: 'full' | 'generic'): Planned {
  const again = kind !== 'dose';
  const title =
    lockscreen === 'generic' ? t(again ? 'notif.generic.followUp' : 'notif.generic.title') : t(again ? 'notif.full.followUp' : 'notif.full.title', { name: dose.name, amount: dose.amount });
  const body = t(lockscreen === 'generic' ? 'notif.generic.body' : 'notif.full.body', { time: dose.localTime });
  const p: Omit<Planned, 'hash'> = {
    identifier,
    doseId: dose.id,
    kind,
    fireAt,
    title,
    body,
    channelId: CHANNEL[dose.type],
    // Snooze is hidden when 10 minutes from now would pass the deadline (D-085), so late follow-ups use the shorter set.
    categoryId: fireAt + SNOOZE_MS >= dose.alertDueAt ? CATEGORY_NO_SNOOZE : CATEGORY,
    delivery: dose.type === 'alarm' ? 'alarmClock' : 'bestEffort', // D-072
    sound: dose.type === 'alarm' ? ALARM_SOUND : dose.type === 'gentle' ? null : 'default', // D-094
    interruptionLevel: dose.type === 'gentle' ? 'active' : 'timeSensitive', // D-027
  };
  return { ...p, hash: hash(JSON.stringify(p)) };
}

// What one dose wants scheduled, before any budget. Answered, missed and unknown states want nothing.
export function wantedForDose(dose: LocalDose, now: number, lockscreen: 'full' | 'generic'): Planned[] {
  if (dose.status !== 'pending' && dose.status !== 'snoozed') return [];
  const out: Planned[] = [];
  const snoozed = dose.status === 'snoozed' && dose.snoozeUntil !== null;
  const start = snoozed ? dose.snoozeUntil! : dose.scheduledAt;
  const mainId = snoozed ? `${ID_PREFIX}${dose.id}:s` : `${ID_PREFIX}${dose.id}`;
  if (start > now && start < dose.alertDueAt) out.push(make(dose, snoozed ? 'snooze' : 'dose', mainId, start, lockscreen));
  if (dose.type === 'alarm') {
    // Every 5 minutes from the start until the deadline (exclusive). Only the ones still ahead of us.
    for (let k = 1; start + k * FOLLOW_UP_MS < dose.alertDueAt; k++) {
      const at = start + k * FOLLOW_UP_MS;
      if (at > now) out.push(make(dose, 'followUp', `${ID_PREFIX}${dose.id}:${snoozed ? 'sf' : 'f'}${k}`, at, lockscreen));
    }
  }
  return out;
}

export function planNotifications(input: PlanInput): Plan {
  const { doses, now, platform, lockscreen, windowThrough } = input;
  const ordered = [...doses].sort((a, b) => a.scheduledAt - b.scheduledAt);
  const wanted = ordered.map((dose) => ({ dose, items: wantedForDose(dose, now, lockscreen) }));
  let all = wanted.flatMap((w) => w.items);

  let kept = new Set(all.map((p) => p.identifier));
  if (platform === 'ios' && all.length > IOS_BUDGET) {
    // D-078: Alarm follow-ups only for the next 24 hours, plain dose notifications beyond; then earliest first.
    all = all.filter((p) => p.kind !== 'followUp' || p.fireAt <= now + DAY);
    if (all.length > IOS_BUDGET) all = [...all].sort((a, b) => a.fireAt - b.fireAt).slice(0, IOS_BUDGET);
    kept = new Set(all.map((p) => p.identifier));
  } else if (platform === 'android' && all.length > ANDROID_GUARD) {
    all = [...all].sort((a, b) => a.fireAt - b.fireAt).slice(0, ANDROID_GUARD);
    kept = new Set(all.map((p) => p.identifier));
  }

  // scheduled_through: the last dose whose notifications are all in, counting from the front. The server pushes a backup for
  // anything after it (D-036), so this must never claim more than the phone really holds.
  // Strictly before the first incomplete dose: two doses at the same minute are either both covered or neither is claimed.
  const firstIncomplete = wanted.find(({ items }) => items.some((p) => !kept.has(p.identifier)));
  let through: number | null;
  if (!firstIncomplete) through = Math.max(windowThrough, ...ordered.map((d) => d.scheduledAt));
  else {
    const before = ordered.filter((d) => d.scheduledAt < firstIncomplete.dose.scheduledAt);
    through = before.length ? before[before.length - 1]!.scheduledAt : null;
  }

  const planned = all.sort((a, b) => a.fireAt - b.fireAt || (a.identifier < b.identifier ? -1 : 1));
  return { planned, scheduledThrough: through, dropped: wanted.reduce((n, w) => n + w.items.length, 0) - planned.length };
}

export interface Scheduled {
  identifier: string;
  hash: string | null;
}

// What to cancel and what to schedule so the phone ends up holding exactly `desired`. Only notifications of ours (dose:…) are
// touched. An unchanged one (same ID, same fingerprint) is left alone: re-sync must not churn the OS scheduler.
export function diffPlan(desired: Planned[], current: Scheduled[]): { cancel: string[]; schedule: Planned[] } {
  const want = new Map(desired.map((p) => [p.identifier, p]));
  const have = new Map(current.filter((c) => c.identifier.startsWith(ID_PREFIX)).map((c) => [c.identifier, c.hash]));
  return {
    cancel: [...have.keys()].filter((id) => !want.has(id)),
    schedule: desired.filter((p) => have.get(p.identifier) !== p.hash),
  };
}
