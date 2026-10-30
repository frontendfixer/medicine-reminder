import type { NotificationResponse } from 'expo-notifications';
import { ACTION } from './expo-notifier';
import { doseIdOf } from './plan';
import type { Action } from './store';

export type Parsed = { kind: 'answer'; doseId: string; action: Action } | { kind: 'open'; doseId: string | null } | { kind: 'ignore' };

const DEFAULT_ACTION = 'expo.modules.notifications.actions.DEFAULT';

// What a tap on a notification means. A button answers the dose; a tap on the notification itself just opens the app.
export function parseResponse(r: Pick<NotificationResponse, 'actionIdentifier' | 'notification'>): Parsed {
  const req = r.notification?.request;
  const raw = req?.content?.data?.dose_id;
  const doseId = typeof raw === 'string' ? raw : req?.identifier ? doseIdOf(req.identifier) : null;
  if (r.actionIdentifier === DEFAULT_ACTION) return { kind: 'open', doseId };
  const action = ({ [ACTION.taken]: 'taken', [ACTION.notTaken]: 'not_taken', [ACTION.snooze]: 'snooze' } as Record<string, Action>)[r.actionIdentifier];
  return action && doseId ? { kind: 'answer', doseId, action } : { kind: 'ignore' };
}

// The same tap can reach us twice (the live listener and the background task). Remember what we just handled.
const recent = new Map<string, number>();
const DEDUPE_MS = 60_000;
export function seenRecently(r: Pick<NotificationResponse, 'actionIdentifier' | 'notification'>, now = Date.now()): boolean {
  const key = `${r.notification?.request?.identifier}|${r.actionIdentifier}|${r.notification?.date}`;
  for (const [k, at] of recent) if (now - at > DEDUPE_MS) recent.delete(k);
  if (recent.has(key)) return true;
  recent.set(key, now);
  return false;
}
export const forgetRecent = (): void => recent.clear();
