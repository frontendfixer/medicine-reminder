// Sends queued answers to the stub endpoint in the shape of POST /v1/device/dose-responses (docs/04-api.md).
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import { logEvent, markSent, unsentAnswers } from './db';

export function stubUrl(): string {
  return (Constants.expoConfig?.extra?.stubUrl as string | undefined) ?? '';
}

export async function flushAnswers(trigger: string): Promise<number> {
  const base = stubUrl();
  if (!base) return 0;
  const rows = (await unsentAnswers()).slice(0, 100);
  if (rows.length === 0) return 0;
  const res = await fetch(`${base}/v1/device/dose-responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': Crypto.randomUUID(),
      'X-App-Version': Constants.expoConfig?.version ?? '0.0.0',
      'X-Platform': Platform.OS,
    },
    body: JSON.stringify({
      responses: rows.map((r) => ({
        client_event_id: r.client_event_id,
        dose_id: r.dose_id,
        action: r.action,
        responded_at: r.responded_at,
        network_restored_at: null,
      })),
    }),
  });
  if (!res.ok) throw new Error(`stub returned ${res.status}`);
  await markSent(rows.map((r) => r.client_event_id));
  await logEvent('flushed', { trigger, count: rows.length });
  return rows.length;
}
