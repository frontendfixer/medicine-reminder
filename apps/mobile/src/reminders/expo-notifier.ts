import * as Battery from 'expo-battery';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { t } from '../i18n';
import type { Notifier, Permissions } from './notifier';
import { ALARM_SOUND, CATEGORY, CATEGORY_NO_SNOOZE, CHANNEL, doseIdOf, type Planned, type Scheduled } from './plan';

export const CAREGIVER_CHANNEL = 'caregiver_alerts_v1';
export const ACTION = { taken: 'TAKEN', notTaken: 'NOT_TAKEN', snooze: 'SNOOZE_10' } as const;

// Runs at start-up, before any permission request: on Android 13+ the permission prompt does not appear until a channel
// exists (docs/08). Channel settings cannot change after creation, so the IDs are versioned (D-026).
export async function setUpNotifications(): Promise<void> {
  if (Platform.OS === 'android') {
    const visible = Notifications.AndroidNotificationVisibility.PUBLIC;
    await Notifications.setNotificationChannelAsync(CHANNEL.standard, { name: t('channel.standard'), importance: Notifications.AndroidImportance.HIGH, lockscreenVisibility: visible });
    // D-094: Alarm gets a long custom sound, top importance and vibration.
    await Notifications.setNotificationChannelAsync(CHANNEL.alarm, {
      name: t('channel.alarm'),
      importance: Notifications.AndroidImportance.MAX,
      sound: ALARM_SOUND,
      audioAttributes: { usage: Notifications.AndroidAudioUsage.ALARM, contentType: Notifications.AndroidAudioContentType.SONIFICATION },
      enableVibrate: true,
      vibrationPattern: [0, 800, 400, 800, 400, 800],
      lockscreenVisibility: visible,
    });
    await Notifications.setNotificationChannelAsync(CHANNEL.gentle, { name: t('channel.gentle'), importance: Notifications.AndroidImportance.DEFAULT, lockscreenVisibility: visible });
    await Notifications.setNotificationChannelAsync(CAREGIVER_CHANNEL, { name: t('channel.caregiver'), importance: Notifications.AndroidImportance.HIGH, lockscreenVisibility: visible });
  }
  // The three answers, on the lock screen, without opening the app (D-029). A second set without Snooze for late reminders (D-085).
  const answer = { opensAppToForeground: false };
  const taken = { identifier: ACTION.taken, buttonTitle: t('action.taken'), options: answer };
  const notTaken = { identifier: ACTION.notTaken, buttonTitle: t('action.notTaken'), options: answer };
  const snooze = { identifier: ACTION.snooze, buttonTitle: t('action.snooze'), options: answer };
  await Notifications.setNotificationCategoryAsync(CATEGORY, [taken, notTaken, snooze]);
  await Notifications.setNotificationCategoryAsync(CATEGORY_NO_SNOOZE, [taken, notTaken]);
  // While the app is open the reminder still shows and sounds.
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
  });
}

// Asks for notification permission once, after the channels exist. The guided setup screens (exact alarms, battery) come next.
export async function ensureNotificationPermission(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted || !current.canAskAgain) return current.granted;
  return (await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: true } })).granted;
}

export class ExpoNotifier implements Notifier {
  async scheduled(): Promise<Scheduled[]> {
    const all = await Notifications.getAllScheduledNotificationsAsync();
    return all.map((r) => ({ identifier: r.identifier, hash: typeof r.content.data?.h === 'string' ? r.content.data.h : null }));
  }

  async schedule(p: Planned, patientId: string): Promise<void> {
    await Notifications.scheduleNotificationAsync({
      identifier: p.identifier, // the dose ID: scheduling again replaces, never duplicates (D-035)
      content: {
        title: p.title,
        body: p.body,
        data: { dose_id: p.doseId, patient_id: patientId, h: p.hash },
        sound: p.sound ?? false,
        categoryIdentifier: p.categoryId,
        interruptionLevel: p.interruptionLevel,
        priority: Notifications.AndroidNotificationPriority.MAX,
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(p.fireAt), channelId: p.channelId, delivery: p.delivery },
    });
  }

  async cancel(identifiers: string[]): Promise<void> {
    for (const id of identifiers) await Notifications.cancelScheduledNotificationAsync(id);
  }

  async dismiss(doseId: string): Promise<void> {
    for (const n of await Notifications.getPresentedNotificationsAsync()) {
      if (n.request.content.data?.dose_id === doseId || doseIdOf(n.request.identifier) === doseId) await Notifications.dismissNotificationAsync(n.request.identifier);
    }
  }

  async permissions(): Promise<Permissions> {
    const notifications = (await Notifications.getPermissionsAsync()).granted;
    if (Platform.OS !== 'android') return { notifications, exactAlarm: null, batteryUnrestricted: null };
    return {
      notifications,
      exactAlarm: (await Notifications.getExactAlarmPermissionsAsync()).granted,
      batteryUnrestricted: !(await Battery.isBatteryOptimizationEnabledAsync()), // D-074: read-only, no native module (R-49)
    };
  }
}
