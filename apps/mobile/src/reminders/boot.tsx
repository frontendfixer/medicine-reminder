import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { getReminders } from '../runtime';
import { useSession } from '../session/provider';
import { ensureNotificationPermission, setUpNotifications } from './expo-notifier';
import { handleResponse } from './handle-response';
import { registerNotificationTask } from './task';

// Start-up work for reminders. Renders nothing.
export function RemindersBoot() {
  const router = useRouter();
  const { mode, patient, ready } = useSession();

  // Channels and categories first, so the permission prompt can appear; then the task for lock-screen taps.
  useEffect(() => {
    void setUpNotifications().then(registerNotificationTask);
  }, []);

  useEffect(() => {
    if (ready && mode === 'patient' && patient) void ensureNotificationPermission();
  }, [ready, mode, patient]);

  // A tap while the app is alive, and the tap that launched it.
  useEffect(() => {
    const open = (r: Notifications.NotificationResponse) =>
      void handleResponse(r, getReminders).then((h) => {
        if (h === 'open') router.push('/today');
      });
    const sub = Notifications.addNotificationResponseReceivedListener(open);
    const launched = Notifications.getLastNotificationResponse();
    if (launched) {
      open(launched);
      void Notifications.clearLastNotificationResponseAsync();
    }
    return () => sub.remove();
  }, [router]);

  // Coming back to the app is one of the ways the window is topped up and answers are sent (docs/05#refill).
  useEffect(() => {
    if (!(ready && mode === 'patient' && patient)) return;
    const sync = () => void getReminders().then((r) => r.engine.sync());
    const sub = AppState.addEventListener('change', (s) => s === 'active' && sync());
    return () => sub.remove();
  }, [ready, mode, patient]);

  return null;
}
