import { useCallback, useEffect, useRef, useState } from 'react';
import { messageFor } from '../lib/errors';
import { useReminders } from './provider';
import type { Action, AnswerResult, LocalDose } from './store';

export interface TodayState {
  loaded: boolean;
  doses: LocalDose[];
  accountState: 'active' | 'grace' | 'suspended';
  unsent: boolean;
  syncing: boolean;
  errorKey: ReturnType<typeof messageFor> | null;
}

// The Today screen's data. It shows what the phone already holds straight away (so it works offline and opens instantly),
// then syncs in the background and refreshes.
export function useToday() {
  const reminders = useReminders();
  const [state, setState] = useState<TodayState>({ loaded: false, doses: [], accountState: 'active', unsent: false, syncing: false, errorKey: null });
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

  const reload = useCallback(async () => {
    if (!reminders) return;
    const { store } = reminders;
    const [doses, account, unsent] = await Promise.all([store.listDoses(), store.getKv('account_state'), store.hasUnsent()]);
    if (alive.current) setState((s) => ({ ...s, loaded: true, doses, unsent, accountState: account === 'grace' || account === 'suspended' ? account : 'active' }));
  }, [reminders]);

  const sync = useCallback(async () => {
    if (!reminders) return;
    setState((s) => ({ ...s, syncing: true }));
    const result = await reminders.engine.sync();
    await reload();
    if (alive.current) setState((s) => ({ ...s, syncing: false, errorKey: result.ok ? null : messageFor(result.error) }));
  }, [reminders, reload]);

  useEffect(() => {
    void reload().then(sync);
  }, [reload, sync]);

  const answer = useCallback(
    async (doseId: string, action: Action): Promise<AnswerResult | null> => {
      if (!reminders) return null;
      const result = await reminders.engine.answer(doseId, action);
      await reload();
      return result;
    },
    [reminders, reload],
  );

  return { ...state, sync, answer };
}
