import { render } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { SessionProvider } from '../session/provider';
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
