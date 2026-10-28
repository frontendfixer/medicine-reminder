// Turns a notification response (from any handler) into an outbox row, then cancels
// the dose's follow-ups. Called from the Android headless task, the response listener
// and the cold-start "last response" check, so it must be safe to call twice.
import * as Notifications from 'expo-notifications';
import * as Crypto from 'expo-crypto';
import { insertAnswer, logEvent, type OutboxRow } from './db';
import { ACTION, cancelFollowUps, scheduleDose, type DoseType } from './notifications';
import { flushAnswers } from './flush';

export type ResponseSource = 'android_task' | 'listener' | 'last_response_on_launch';

const ACTION_MAP: Record<string, OutboxRow['action']> = {
  [ACTION.taken]: 'taken',
  [ACTION.notTaken]: 'not_taken',
  [ACTION.snooze]: 'snooze',
};

export async function handleResponse(
  response: Notifications.NotificationResponse,
  source: ResponseSource,
  appState: string,
): Promise<void> {
  const req = response.notification.request;
  const data = (req.content.data ?? {}) as { dose_id?: string; type?: DoseType };
  const doseId = data.dose_id ?? req.identifier;
  const action = ACTION_MAP[response.actionIdentifier];
  const now = new Date().toISOString();

  await logEvent('response', {
    source,
    app_state: appState,
    action_identifier: response.actionIdentifier,
    identifier: req.identifier,
    dose_id: doseId,
    delivered_at: new Date(response.notification.date).toISOString(),
  });
  if (!action) return; // plain tap on the notification body

  const inserted = await insertAnswer({
    client_event_id: Crypto.randomUUID(),
    response_key: `${req.identifier}|${response.actionIdentifier}|${response.notification.date}`,
    dose_id: doseId,
    action,
    responded_at: now,
    written_at: now,
    source,
  });
  if (!inserted) {
    await logEvent('response_duplicate', { source, dose_id: doseId });
    return;
  }

  if (action === 'snooze') {
    // Snooze never extends the missed delay (D-030); the spike only re-notifies.
    await scheduleDose({
      doseId,
      identifier: `${doseId}__s${Date.now()}`,
      n: 0,
      type: data.type ?? 'standard',
      fireAt: new Date(Date.now() + 10 * 60_000),
    });
  } else {
    await cancelFollowUps(doseId);
  }
  await logEvent('answer_saved', { source, dose_id: doseId, action });
  await flushAnswers(source).catch((e) => logEvent('flush_error', { source, message: String(e) }));
}
