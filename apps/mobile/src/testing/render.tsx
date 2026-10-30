import { render } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { RemindersProvider } from '../reminders/provider';
import { RemindersEngine } from '../reminders/engine';
import { Store } from '../reminders/store';
import { SessionProvider } from '../session/provider';
import { FakeNotifier } from './fake-notifier';
import { nodeSql } from './node-sql';
import { SessionService } from '../session/session';
import { memoryStorage } from '../session/storage';

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
export const apiError = (status: number, code: string, details: Record<string, unknown> = {}) => json(status, { error: { code, message: code, details } });

export type Handler = (path: string, init: RequestInit & { json?: any }) => Response | Promise<Response>;

// A real SessionService over in-memory storage and a scripted network, so screens run their real logic.
export function makeService(handler: Handler = () => json(200, {})) {
  const secure = memoryStorage();
  const plain = memoryStorage();
  const requests: { path: string; method: string; body?: any; headers: Record<string, string> }[] = [];
  let n = 0;
  const service = new SessionService({
    secure,
    plain,
    baseUrl: 'https://api.test',
    appVersion: '1.0.0',
    platform: 'android',
    deviceLabel: 'Test phone',
    newId: () => `id-${++n}`,
    fetch: (async (url: string, init: RequestInit) => {
      const path = url.replace('https://api.test', '');
      const body = init.body ? JSON.parse(init.body as string) : undefined;
      requests.push({ path, method: init.method!, body, headers: init.headers as Record<string, string> });
      return handler(path, { ...init, json: body });
    }) as unknown as typeof fetch,
  });
  return { service, secure, plain, requests };
}

export async function renderScreen(ui: ReactElement, service: SessionService, opts: { load?: boolean } = {}) {
  if (opts.load !== false) await service.load();
  return render(<SessionProvider service={service}>{ui}</SessionProvider>);
}

export const caregiverTokens = { access_token: 'A1', refresh_token: 'R1', user: { id: 'u1', email: 'a@b.co' }, session_replaced_previous: false };

// The Today screen's world: the real engine and store (on real SQLite), a fake notification system, and the scripted server.
export async function renderToday(ui: ReactElement, service: SessionService) {
  await service.load();
  const store = new Store(nodeSql());
  await store.migrate();
  const notifier = new FakeNotifier();
  let n = 0;
  const engine = new RemindersEngine({
    store,
    notifier,
    api: { sync: () => service.api.device.sync(), respond: (r) => service.api.device.respond(r), heartbeat: (b) => service.api.device.heartbeat(b) },
    platform: 'android',
    appVersion: '1.0.0',
    timeZone: () => 'Asia/Kolkata',
    patientId: () => service.getState().patient?.patientId ?? null,
    newId: () => `ev-${++n}`,
  });
  const view = await render(
    <SessionProvider service={service}>
      <RemindersProvider value={{ engine, store }}>{ui}</RemindersProvider>
    </SessionProvider>,
  );
  return { ...view, engine, store, notifier };
}
