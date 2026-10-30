import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import type { SessionService, SessionState } from './session';

const SessionContext = createContext<SessionService | null>(null);

// The privacy notice version people agree to. Re-consent is required when it changes (docs/10-security-privacy.md#consent).
// The wording is a draft until the legal review in C-10 is done.
export const NOTICE_VERSION = '2026-10-draft';

export function SessionProvider({ children, service }: { children: ReactNode; service?: SessionService }) {
  // The real session is the one in runtime.ts, shared with the headless task. It is required lazily so that screen tests,
  // which pass their own service, never load the native modules behind it.
  const value = useMemo<SessionService>(() => service ?? (require('../runtime') as typeof import('../runtime')).getSession(), [service]);
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
