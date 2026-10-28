import { useCallback, useEffect, useState } from 'react';
import {
  AppState,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import * as Notifications from 'expo-notifications';
import * as IntentLauncher from 'expo-intent-launcher';
import * as BackgroundTask from 'expo-background-task';
import * as Clipboard from 'expo-clipboard';
import { t, type StringKey } from './i18n';
import { allAnswers, allEvents, clearEvents, logEvent, recentEvents, type EventRow } from './db';
import { configureForegroundHandler, logPresentedNotifications, setUpChannelsAndCategories } from './notifications';
import { handleResponse } from './answers';
import { flushAnswers, stubUrl } from './flush';
import { registerTasks } from './tasks';
import { expoPushToken, readStatus, type Status } from './status';
import * as S from './scenarios';

configureForegroundHandler();

// Startup order matters: channels and categories exist before any permission prompt.
async function startUp(): Promise<void> {
  await setUpChannelsAndCategories();
  await registerTasks();
  const last = Notifications.getLastNotificationResponse();
  if (last) {
    await handleResponse(last, 'last_response_on_launch', 'launch');
    Notifications.clearLastNotificationResponse();
  }
  await logEvent('app_open', {});
  await logPresentedNotifications('app_open');
  await flushAnswers('app_open').catch((e) => logEvent('flush_error', { message: String(e) }));
}

export default function App() {
  const [status, setStatus] = useState<Status>({});
  const [events, setEvents] = useState<EventRow[]>([]);
  const [message, setMessage] = useState('');

  const refresh = useCallback(async () => {
    setStatus(await readStatus());
    setEvents(await recentEvents(100));
  }, []);

  const run = useCallback(
    (fn: () => Promise<unknown>) => async () => {
      try {
        await fn();
      } catch (e) {
        await logEvent('error', { message: String(e) });
        setMessage(String(e));
      }
      await refresh();
    },
    [refresh],
  );

  useEffect(() => {
    run(startUp)();
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      run(() => handleResponse(response, 'listener', AppState.currentState ?? 'unknown'))();
    });
    const appSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        run(async () => {
          await logEvent('app_foreground', {});
          await logPresentedNotifications('app_foreground');
          await flushAnswers('app_foreground').catch(() => undefined);
        })();
      }
    });
    return () => {
      sub.remove();
      appSub.remove();
    };
  }, [run]);

  const copy = async (text: string) => {
    await Clipboard.setStringAsync(text);
    setMessage(t('msg.copied'));
  };

  const android = Platform.OS === 'android';

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.root}>
        <StatusBar style="dark" />
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.title}>{t('app.title')}</Text>
          {message ? <Text style={styles.message}>{message}</Text> : null}

          <Section title={t('section.setup')}>
            <Text style={styles.mono}>{JSON.stringify(status, null, 1)}</Text>
            <Btn label="btn.refreshStatus" onPress={run(refresh)} />
            <Btn
              label="btn.requestNotifications"
              onPress={run(() =>
                Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: true } }),
              )}
            />
            {android && <Btn label="btn.requestExactAlarm" onPress={run(Notifications.requestExactAlarmPermissionsAsync)} />}
            {android && (
              <Btn
                label="btn.openBatterySettings"
                onPress={run(() =>
                  IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
                )}
              />
            )}
            <Btn label="btn.openNotificationSettings" onPress={run(() => Linking.openSettings())} />
          </Section>

          <Section title={t('section.schedule')}>
            <Btn label="btn.testIn10s" onPress={run(S.testInTenSeconds)} />
            <Text style={styles.note}>{t('label.windowMinutes', S.SHORT_WINDOW)}</Text>
            <Btn label="btn.scheduleWindow" onPress={run(() => S.scheduleWindow(S.SHORT_WINDOW))} />
            <Btn label="btn.resync" onPress={run(() => S.scheduleWindow(S.SHORT_WINDOW, true))} />
            <Btn label="btn.deviceScript" onPress={run(S.deviceTestScript)} />
            <Btn label="btn.alarmSeries" onPress={run(S.alarmSeries)} />
            {android && <Btn label="btn.dozeClusterBestEffort" onPress={run(() => S.dozeCluster('bestEffort'))} />}
            {android && <Btn label="btn.dozeClusterAlarmClock" onPress={run(() => S.dozeCluster('alarmClock'))} />}
            {!android && <Btn label="btn.fill64" onPress={run(S.fillTo70)} />}
            {!android && <Btn label="btn.photo" onPress={run(S.photoAttachment)} />}
            <Btn label="btn.cancelAll" onPress={run(S.cancelAll)} />
          </Section>

          <Section title={t('section.push')}>
            <Btn
              label="btn.copyPushToken"
              onPress={run(async () => {
                const token = await expoPushToken();
                if (!token) return setMessage(t('msg.noProjectId'));
                await logEvent('push_token', { token });
                await copy(token);
              })}
            />
            <Btn
              label="btn.flush"
              onPress={run(async () => {
                if (!stubUrl()) return setMessage(t('msg.noStubUrl'));
                await flushAnswers('manual');
              })}
            />
            <Btn label="btn.triggerBgTask" onPress={run(BackgroundTask.triggerTaskWorkerForTestingAsync)} />
          </Section>

          <Section title={t('section.log')}>
            <Btn
              label="btn.exportLog"
              onPress={run(async () => copy(JSON.stringify({ events: await allEvents(), answers: await allAnswers() })))}
            />
            <Btn label="btn.clearLog" onPress={run(clearEvents)} />
            {events.map((e) => (
              <Text key={e.id} style={styles.mono}>
                {e.at.slice(5, 19)} {e.kind} {e.detail}
              </Text>
            ))}
          </Section>
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Btn({ label, onPress }: { label: StringKey; onPress: () => void }) {
  return (
    <Pressable style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]} onPress={onPress}>
      <Text style={styles.btnText}>{t(label)}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 16, paddingBottom: 48 },
  title: { fontSize: 22, fontWeight: '600', marginBottom: 8 },
  message: { color: '#a33', marginBottom: 8 },
  section: { marginTop: 20 },
  sectionTitle: { fontSize: 17, fontWeight: '600', marginBottom: 8 },
  note: { color: '#555', marginTop: 8 },
  btn: { backgroundColor: '#2a7ac9', borderRadius: 8, padding: 12, marginTop: 8 },
  btnPressed: { opacity: 0.7 },
  btnText: { color: '#fff', fontSize: 15 },
  mono: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 11, color: '#222' },
});
