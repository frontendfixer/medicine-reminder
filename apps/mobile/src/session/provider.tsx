import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { Platform } from 'react-native';
import { SessionService, type SessionState } from './session';
import { plainStorage, secureStorage } from './storage';

const SessionContext = createContext<SessionService | null>(null);

// Where the API lives: EXPO_PUBLIC_API_URL is compiled into the bundle (see .env.example).
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://10.0.2.2:3000';
// The privacy notice version people agree to. Re-consent is required when it changes (docs/10-security-privacy.md#consent).
// The wording is a draft until the legal review in C-10 is done.
export const NOTICE_VERSION = '2026-10-draft';

export function SessionProvider({ children, service }: { children: ReactNode; service?: SessionService }) {
  const value = useMemo(
    () =>
      service ??
      new SessionService({
        secure: secureStorage,
        plain: plainStorage,
        baseUrl: API_URL,
        appVersion: Constants.expoConfig?.version ?? '0.0.0',
        platform: Platform.OS === 'ios' ? 'ios' : 'android',
        deviceLabel: Device.modelName ?? undefined,
        newId: () => Crypto.randomUUID(),
      }),
    [service],
  );
  useEffect(() => {
    void value.load();
  }, [value]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSessionService(): SessionService {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSessionService must be used inside <SessionProvider>');
  return s;
}

export function useSession(): SessionState {
  const s = useSessionService();
  return useSyncExternalStore(s.subscribe, s.getState, s.getState);
}
