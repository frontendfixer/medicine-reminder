import type { NotificationResponse } from 'expo-notifications';
import type { RemindersEngine } from './engine';
import { parseResponse, seenRecently } from './respond';

export type Handled = 'answered' | 'open' | 'ignored' | 'duplicate' | 'refused';

// Shared by the live listener and the background task. Writes the answer locally first and tries to send it; a lock-screen tap
// with no network still counts (D-031).
export async function handleResponse(response: NotificationResponse, engine: () => Promise<{ engine: RemindersEngine }>): Promise<Handled> {
  const parsed = parseResponse(response);
  if (parsed.kind === 'open') return 'open';
  if (parsed.kind === 'ignore') return 'ignored';
  if (seenRecently(response)) return 'duplicate';
  const result = await (await engine()).engine.answer(parsed.doseId, parsed.action);
  return result.ok ? 'answered' : 'refused';
}
