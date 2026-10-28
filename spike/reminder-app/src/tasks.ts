// Task definitions. Imported first from index.ts: TaskManager tasks must be defined at
// module scope so headless launches (app killed) find them.
import { AppState } from 'react-native';
import * as TaskManager from 'expo-task-manager';
import * as Notifications from 'expo-notifications';
import * as BackgroundTask from 'expo-background-task';
import { logEvent } from './db';
import { handleResponse } from './answers';
import { flushAnswers } from './flush';
import { logPresentedNotifications } from './notifications';

export const NOTIFICATION_TASK = 'spike_notification_task';
export const BACKGROUND_TASK = 'spike_background_task';

TaskManager.defineTask<Notifications.NotificationTaskPayload>(NOTIFICATION_TASK, async ({ data, error }) => {
  if (error) {
    await logEvent('notification_task_error', { message: error.message });
    return Notifications.BackgroundNotificationTaskResult.Failed;
  }
  if ('actionIdentifier' in data) {
    // Android: action tap while backgrounded or killed (R-02).
    await handleResponse(data, 'android_task', AppState.currentState ?? 'unknown');
    return Notifications.BackgroundNotificationTaskResult.NewData;
  }
  // Remote data push (D-075 test). Record arrival time and payload type only.
  let payload: Record<string, unknown> = {};
  try {
    payload = data.data.dataString ? JSON.parse(data.data.dataString) : (data.data as Record<string, unknown>);
  } catch {
    payload = {};
  }
  await logEvent('data_push', {
    app_state: AppState.currentState ?? 'unknown',
    kind: payload.kind ?? null,
    sent_at: payload.sent_at ?? null,
    received_at: new Date().toISOString(),
  });
  await flushAnswers('data_push').catch(() => undefined);
  return Notifications.BackgroundNotificationTaskResult.NewData;
});

TaskManager.defineTask(BACKGROUND_TASK, async () => {
  await logEvent('background_task', { app_state: AppState.currentState ?? 'unknown' });
  await logPresentedNotifications('background_task').catch(() => undefined);
  await flushAnswers('background_task').catch(() => undefined);
  return BackgroundTask.BackgroundTaskResult.Success;
});

export async function registerTasks(): Promise<void> {
  await Notifications.registerTaskAsync(NOTIFICATION_TASK);
  // 15 minutes is the minimum; the OS treats it as a lower bound (R-03).
  await BackgroundTask.registerTaskAsync(BACKGROUND_TASK, { minimumInterval: 15 });
}
