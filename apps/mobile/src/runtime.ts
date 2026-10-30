import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { RemindersEngine } from './reminders/engine';
import { ExpoNotifier } from './reminders/expo-notifier';
import { openLocalDb } from './reminders/expo-sql';
import { ID_PREFIX } from './reminders/plan';
import { Store } from './reminders/store';
import { SessionService } from './session/session';
import { plainStorage, secureStorage } from './session/storage';

// Where the API lives: EXPO_PUBLIC_API_URL is compiled into the bundle (see .env.example).
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://10.0.2.2:3000';
const platform = Platform.OS === 'ios' ? 'ios' : 'android';

// One session and one engine for the whole process. The screens and the headless task that answers a lock-screen tap both
// use these, so there is a single place that decides what is on the phone.
let session: SessionService | null = null;
let engine: Promise<{ engine: RemindersEngine; store: Store }> | null = null;

export function getSession(): SessionService {
  session ??= new SessionService({
    secure: secureStorage,
    plain: plainStorage,
    baseUrl: API_URL,
    appVersion: Constants.expoConfig?.version ?? '0.0.0',
    platform,
    deviceLabel: Device.modelName ?? undefined,
    newId: () => Crypto.randomUUID(),
    // A phone paired to a different patient must not keep the old one's doses or alarms.
    onPaired: async (now, before) => {
      if (!before || before.patientId === now.patientId) return;
      const { store } = await getReminders();
      const notifier = new ExpoNotifier();
      await notifier.cancel((await notifier.scheduled()).map((s) => s.identifier).filter((id) => id.startsWith(ID_PREFIX)));
      await store.wipe();
    },
  });
  return session;
}

export function getReminders(): Promise<{ engine: RemindersEngine; store: Store }> {
  engine ??= (async () => {
    const s = getSession();
    if (!s.getState().ready) await s.load(); // the headless task starts with nothing loaded
    const store = new Store(await openLocalDb());
    await store.migrate();
    return {
      store,
      engine: new RemindersEngine({
        store,
        notifier: new ExpoNotifier(),
        api: { sync: () => s.api.device.sync(), respond: (r) => s.api.device.respond(r), heartbeat: (b) => s.api.device.heartbeat(b) },
        platform,
        appVersion: Constants.expoConfig?.version ?? '0.0.0',
        timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        patientId: () => s.getState().patient?.patientId ?? null,
        newId: () => Crypto.randomUUID(),
      }),
    };
  })();
  return engine;
}
