import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { getReminders } from '../runtime';
import { handleResponse } from './handle-response';

export const NOTIFICATION_TASK = 'dose-notification-response';

// Runs when the patient taps Taken / Not taken / Snooze on the lock screen and the app is not in the foreground. On Android
// this works even when the app was killed; on iOS expo-notifications documents it as Android-only, so the iOS path is an open
// item (D-076, OI-29). It must be defined at the top level of the bundle: index.ts imports this file before anything else.
TaskManager.defineTask<Notifications.NotificationTaskPayload>(NOTIFICATION_TASK, async ({ data, error }) => {
  if (error || !data || !('actionIdentifier' in data)) return;
  await handleResponse(data, getReminders);
});

export const registerNotificationTask = (): Promise<null> => Notifications.registerTaskAsync(NOTIFICATION_TASK);
