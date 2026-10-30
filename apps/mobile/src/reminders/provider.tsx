import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { RemindersEngine } from './engine';
import type { Store } from './store';

export interface Reminders {
  engine: RemindersEngine;
  store: Store;
}
const Ctx = createContext<Reminders | null>(null);

// Opens the local database and builds the engine once. Screens that need doses wait for it (null until ready).
export function RemindersProvider({ children, value }: { children: ReactNode; value?: Reminders }) {
  const [ready, setReady] = useState<Reminders | null>(value ?? null);
  useEffect(() => {
    if (value) return;
    let live = true;
    void (require('../runtime') as typeof import('../runtime')).getReminders().then((r) => live && setReady(r));
    return () => void (live = false);
  }, [value]);
  return <Ctx.Provider value={ready}>{children}</Ctx.Provider>;
}

export const useReminders = (): Reminders | null => useContext(Ctx);
