// Reads the permission and device state the heartbeat will report (D-041).
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import * as BackgroundTask from 'expo-background-task';
import * as Battery from 'expo-battery';
import { pendingCount } from './notifications';
import { unsentAnswers } from './db';

export type Status = Record<string, string | number | boolean | null>;

export async function readStatus(): Promise<Status> {
  const perm = await Notifications.getPermissionsAsync();
  const status: Status = {
    platform: `${Platform.OS} ${Platform.Version}`,
    notifications: perm.status,
    pending: await pendingCount(),
    unsent_answers: (await unsentAnswers()).length,
    background_task: BackgroundTask.BackgroundTaskStatus[(await BackgroundTask.getStatusAsync()) ?? 0] ?? null,
  };
  if (Platform.OS === 'android') {
    status.exact_alarm = (await Notifications.getExactAlarmPermissionsAsync()).granted;
    status.battery_unrestricted = !(await Battery.isBatteryOptimizationEnabledAsync());
    status.android_importance = perm.android?.importance ?? null;
  } else {
    status.ios_auth_status = perm.ios ? Notifications.IosAuthorizationStatus[perm.ios.status] : null;
    status.ios_lock_screen = perm.ios?.allowsDisplayOnLockScreen ?? null;
    status.ios_sound = perm.ios?.allowsSound ?? null;
    // expo-notifications 58.1.6 does not expose UNNotificationSettings.timeSensitiveSetting.
    status.time_sensitive = 'not exposed';
  }
  return status;
}

export async function expoPushToken(): Promise<string | null> {
  const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
  if (!projectId) return null;
  return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
}
