// Channels, categories and scheduling for the spike. Names follow docs/08-notifications-and-platform.md.
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { File, Paths } from 'expo-file-system';
import { Asset } from 'expo-asset';
import { t } from './i18n';
import { logEvent, markDelivered, recordScheduled, scheduledFireAt } from './db';

export type DoseType = 'standard' | 'alarm' | 'gentle';
export type Delivery = 'bestEffort' | 'alarmClock';

export const CHANNEL: Record<DoseType, string> = {
  standard: 'dose_standard_v1',
  alarm: 'dose_alarm_v1',
  gentle: 'dose_gentle_v1',
};
export const CATEGORY = 'dose_v1';
export const CATEGORY_NO_SNOOZE = 'dose_nosnooze_v1';
export const ACTION = { taken: 'TAKEN', notTaken: 'NOT_TAKEN', snooze: 'SNOOZE_10' } as const;

const ALARM_SOUND = 'dose_alarm.wav';
const FOLLOW_UP_MINUTES = 5;

// Must run before the permission prompt: Android 13+ shows no prompt until a channel exists.
export async function setUpChannelsAndCategories(): Promise<void> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNEL.standard, {
      name: t('channel.standard'),
      importance: Notifications.AndroidImportance.HIGH,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
    await Notifications.setNotificationChannelAsync(CHANNEL.alarm, {
      name: t('channel.alarm'),
      importance: Notifications.AndroidImportance.MAX,
      sound: ALARM_SOUND,
      audioAttributes: { usage: Notifications.AndroidAudioUsage.ALARM },
      enableVibrate: true,
      vibrationPattern: [0, 800, 400, 800, 400, 800],
      bypassDnd: true,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
    await Notifications.setNotificationChannelAsync(CHANNEL.gentle, {
      name: t('channel.gentle'),
      importance: Notifications.AndroidImportance.DEFAULT,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
  }
  const answer = { opensAppToForeground: false };
  const taken = { identifier: ACTION.taken, buttonTitle: t('action.taken'), options: answer };
  const notTaken = { identifier: ACTION.notTaken, buttonTitle: t('action.notTaken'), options: answer };
  const snooze = { identifier: ACTION.snooze, buttonTitle: t('action.snooze'), options: answer };
  await Notifications.setNotificationCategoryAsync(CATEGORY, [taken, notTaken, snooze]);
  await Notifications.setNotificationCategoryAsync(CATEGORY_NO_SNOOZE, [taken, notTaken]);
}

export function configureForegroundHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

export type DoseSpec = {
  doseId: string;
  // Notification identifier; defaults to the dose ID. Snooze uses `${doseId}__s…`.
  identifier?: string;
  n: number;
  type: DoseType;
  fireAt: Date;
  delivery?: Delivery;
  // Alarm only: number of 5-minute follow-ups after the dose.
  followUps?: number;
  attachmentUrl?: string;
};

function interruptionLevel(type: DoseType) {
  return type === 'gentle' ? 'active' : 'timeSensitive';
}

function timeLabel(d: Date): string {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function followUpId(doseId: string, k: number): string {
  return `${doseId}__f${k}`;
}

// Schedules one dose (and Alarm follow-ups) keyed by dose ID. Re-scheduling an existing
// identifier replaces it, which is what makes re-sync idempotent (D-035).
export async function scheduleDose(spec: DoseSpec): Promise<string[]> {
  const delivery: Delivery = spec.delivery ?? (spec.type === 'alarm' ? 'alarmClock' : 'bestEffort');
  const base = spec.identifier ?? spec.doseId;
  const parts = [{ identifier: base, fireAt: spec.fireAt, k: 0 }];
  for (let k = 1; k <= (spec.followUps ?? 0); k++) {
    parts.push({
      identifier: followUpId(base, k),
      fireAt: new Date(spec.fireAt.getTime() + k * FOLLOW_UP_MINUTES * 60_000),
      k,
    });
  }
  const ids: string[] = [];
  for (const p of parts) {
    const title =
      p.k === 0
        ? t('notif.title', { n: spec.n, type: spec.type })
        : t('notif.titleFollowUp', { n: spec.n, type: spec.type, k: p.k });
    const id = await Notifications.scheduleNotificationAsync({
      identifier: p.identifier,
      content: {
        title,
        body: t('notif.body', { time: timeLabel(spec.fireAt) }),
        categoryIdentifier: p.k === (spec.followUps ?? 0) && p.k > 0 ? CATEGORY_NO_SNOOZE : CATEGORY,
        data: { dose_id: spec.doseId, patient_id: 'spike_patient', type: spec.type, follow_up: p.k },
        sound: spec.type === 'alarm' ? ALARM_SOUND : spec.type === 'gentle' ? undefined : 'default',
        interruptionLevel: interruptionLevel(spec.type),
        priority: spec.type === 'gentle' ? undefined : Notifications.AndroidNotificationPriority.MAX,
        attachments: spec.attachmentUrl
          ? [{ identifier: 'photo', url: spec.attachmentUrl, type: null, typeHint: 'public.png' }]
          : undefined,
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: p.fireAt,
        channelId: CHANNEL[spec.type],
        delivery,
      },
    });
    ids.push(id);
  }
  await recordScheduled(
    parts.map((p) => ({ identifier: p.identifier, doseId: spec.doseId, type: spec.type, delivery, fireAt: p.fireAt })),
  );
  return ids;
}

// Cancels everything still pending for a dose (follow-ups, snoozes) and clears the
// delivered ones from the shade so the patient isn't nagged after answering.
export async function cancelFollowUps(doseId: string): Promise<void> {
  const mine = (id: string) => id === doseId || id.startsWith(`${doseId}__`);
  for (const req of await Notifications.getAllScheduledNotificationsAsync()) {
    if (mine(req.identifier)) await Notifications.cancelScheduledNotificationAsync(req.identifier);
  }
  for (const n of await Notifications.getPresentedNotificationsAsync()) {
    if (mine(n.request.identifier)) await Notifications.dismissNotificationAsync(n.request.identifier);
  }
}

export async function pendingCount(): Promise<number> {
  return (await Notifications.getAllScheduledNotificationsAsync()).length;
}

// Copies the bundled test photo into the documents directory so iOS can attach it.
export async function cachedPhotoUrl(): Promise<string> {
  const target = new File(Paths.document, 'test-photo.png');
  if (!target.exists) {
    const asset = Asset.fromModule(require('../assets/test-photo.png'));
    await asset.downloadAsync();
    if (!asset.localUri) throw new Error('photo asset has no local URI');
    new File(asset.localUri).copy(target);
  }
  return target.uri;
}

// Records which notifications are in the shade and when the OS delivered them, against
// when we asked for them. Run on every app open: the only delivery-time evidence we get
// for notifications that fired while the app was killed.
export async function logPresentedNotifications(source: string): Promise<void> {
  const presented = await Notifications.getPresentedNotificationsAsync();
  for (const n of presented) {
    const deliveredAt = new Date(n.date).toISOString();
    if (!(await markDelivered(n.request.identifier, deliveredAt))) continue;
    const planned = await scheduledFireAt(n.request.identifier);
    await logEvent('presented', {
      source,
      identifier: n.request.identifier,
      delivered_at: deliveredAt,
      planned_at: planned,
      late_seconds: planned ? Math.round((n.date - Date.parse(planned)) / 1000) : null,
    });
  }
}
