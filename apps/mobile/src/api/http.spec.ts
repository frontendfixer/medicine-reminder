import { ApiError, createHttp, type HttpOptions, type Tokens } from './http';

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
const err = (status: number, code: string, details = {}) => json(status, { error: { code, message: code, details } });

function setup(handler: (call: Call, n: number) => Response | Promise<Response>, over: Partial<HttpOptions> = {}) {
  const calls: Call[] = [];
  let tokens: Tokens | null = { access: 'A1', refresh: 'R1' };
  let id = 0;
  const events = { lost: [] as string[], rejected: 0, upgrade: [] as (string | undefined)[] };
  const http = createHttp({
    baseUrl: 'https://api.test',
    appVersion: '1.2.3',
    platform: 'android',
    newId: () => `key-${++id}`,
    getTokens: () => tokens,
    setTokens: (t) => (tokens = t),
    getDeviceToken: () => 'DEV',
    onSessionLost: (why) => events.lost.push(why),
    onDeviceRejected: () => events.rejected++,
    onUpgradeRequired: (v) => events.upgrade.push(v),
    fetch: (async (url: string, init: RequestInit) => {
      const call = { url, method: init.method!, headers: init.headers as Record<string, string>, body: init.body as string | undefined };
      calls.push(call);
      return handler(call, calls.length);
    }) as unknown as typeof fetch,
    ...over,
  });
  return { http, calls, events, tokens: () => tokens };
}

describe('requests', () => {
  it('sends the app headers and the caregiver token, and parses JSON', async () => {
    const { http, calls } = setup(() => json(200, { ok: true }));
    expect(await http.request('GET', '/v1/patients', { query: { status: 'active', skip: undefined } })).toEqual({ ok: true });
    expect(calls[0]).toMatchObject({ url: 'https://api.test/v1/patients?status=active', method: 'GET' });
    expect(calls[0]!.headers).toMatchObject({ Authorization: 'Bearer A1', 'X-App-Version': '1.2.3', 'X-Platform': 'android' });
    expect(calls[0]!.headers['Idempotency-Key']).toBeUndefined(); // reads carry none
  });

  it('gives every write a fresh Idempotency-Key unless the route is exempt', async () => {
    const { http, calls } = setup(() => json(200, {}));
    await http.request('POST', '/v1/patients', { body: { a: 1 } });
    await http.request('POST', '/v1/patients', { body: { a: 1 } });
    await http.request('POST', '/v1/auth/login', { auth: 'none', body: {}, idempotent: false });
    expect(calls.map((c) => c.headers['Idempotency-Key'])).toEqual(['key-1', 'key-2', undefined]);
    expect(calls[0]!.headers['Content-Type']).toBe('application/json');
    expect(calls[0]!.body).toBe('{"a":1}');
  });

  it('uses the device token for device routes and nothing for public ones', async () => {
    const { http, calls } = setup(() => json(200, {}));
    await http.request('GET', '/v1/device/sync', { auth: 'device' });
    await http.request('GET', '/v1/app/config', { auth: 'none' });
    expect(calls[0]!.headers.Authorization).toBe('Device DEV');
    expect(calls[1]!.headers.Authorization).toBeUndefined();
  });

  it('returns nothing for 204', async () => {
    const { http } = setup(() => json(204, null));
    expect(await http.request('POST', '/v1/auth/logout', { idempotent: false })).toBeUndefined();
  });
});

describe('errors', () => {
  it('turns the documented error body into an ApiError', async () => {
    const { http } = setup(() => err(409, 'PATIENT_LIMIT_REACHED', { limit: 3 }));
    const e = await http.request('POST', '/v1/patients', { body: {} }).catch((x: ApiError) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ code: 'PATIENT_LIMIT_REACHED', status: 409, details: { limit: 3 } });
  });

  it('exposes validation fields and Retry-After', async () => {
    const { http } = setup(() => json(429, { error: { code: 'RATE_LIMITED', message: 'slow', details: {} } }, { 'Retry-After': '30' }));
    const e = (await http.request('POST', '/x', { body: {} }).catch((x: ApiError) => x)) as ApiError;
    expect(e.retryAfterSeconds).toBe(30);
    const { http: h2 } = setup(() => err(400, 'VALIDATION_FAILED', { fields: { email: 'must be an email address' } }));
    expect(((await h2.request('POST', '/x', { body: {} }).catch((x: ApiError) => x)) as ApiError).fields).toEqual({ email: 'must be an email address' });
  });

  it('reports an unreachable server as NETWORK, and a non-JSON failure as UNKNOWN', async () => {
    const down = setup(() => {
      throw new TypeError('Network request failed');
    });
    expect(await down.http.request('GET', '/x').catch((e: ApiError) => e.code)).toBe('NETWORK');
    const odd = setup(() => new Response('<html>bad gateway</html>', { status: 502 }));
    expect(await odd.http.request('GET', '/x').catch((e: ApiError) => [e.code, e.status])).toEqual(['UNKNOWN', 502]);
  });
});

describe('signing in elsewhere, revocation and forced update', () => {
  it('reports SESSION_REPLACED once and does not try to refresh', async () => {
    const { http, calls, events } = setup(() => err(401, 'SESSION_REPLACED'));
    await http.request('GET', '/v1/patients').catch(() => undefined);
    expect(events.lost).toEqual(['replaced']);
    expect(calls).toHaveLength(1);
  });

  it('reports a revoked phone', async () => {
    const { http, events } = setup(() => err(401, 'DEVICE_TOKEN_REJECTED'));
    await http.request('GET', '/v1/device/sync', { auth: 'device' }).catch(() => undefined);
    expect(events.rejected).toBe(1);
  });

  it('reports the forced update with the minimum version', async () => {
    const { http, events } = setup(() => err(426, 'UPGRADE_REQUIRED', { min_app_version: '2.0.0' }));
    await http.request('GET', '/v1/patients').catch(() => undefined);
    expect(events.upgrade).toEqual(['2.0.0']);
  });
});

describe('token refresh', () => {
  const refreshed = () => json(200, { access_token: 'A2', refresh_token: 'R2' });

  it('refreshes once on an expired token and replays the same write with the same Idempotency-Key', async () => {
    const { http, calls, tokens } = setup((c) => (c.url.endsWith('/auth/refresh') ? refreshed() : c.headers.Authorization === 'Bearer A2' ? json(201, { id: 'p1' }) : err(401, 'UNAUTHENTICATED')));
    expect(await http.request('POST', '/v1/patients', { body: { n: 1 } })).toEqual({ id: 'p1' });
    expect(tokens()).toEqual({ access: 'A2', refresh: 'R2' });
    const writes = calls.filter((c) => c.url.endsWith('/v1/patients'));
    expect(writes).toHaveLength(2);
    expect(writes[1]!.headers['Idempotency-Key']).toBe(writes[0]!.headers['Idempotency-Key']);
    expect(JSON.parse(calls.find((c) => c.url.endsWith('/auth/refresh'))!.body!)).toEqual({ refresh_token: 'R1' });
  });

  it('shares one refresh between simultaneous requests', async () => {
    const { http, calls } = setup(async (c) => {
      if (c.url.endsWith('/auth/refresh')) {
        await new Promise((r) => setTimeout(r, 20));
        return refreshed();
      }
      return c.headers.Authorization === 'Bearer A2' ? json(200, { ok: 1 }) : err(401, 'UNAUTHENTICATED');
    });
    const out = await Promise.all([http.request('GET', '/a'), http.request('GET', '/b'), http.request('GET', '/c')]);
    expect(out).toHaveLength(3);
    expect(calls.filter((c) => c.url.endsWith('/auth/refresh'))).toHaveLength(1);
  });

  it('ends the session when the refresh token no longer works', async () => {
    const { http, events } = setup(() => err(401, 'UNAUTHENTICATED'));
    const e = (await http.request('GET', '/v1/patients').catch((x: ApiError) => x)) as ApiError;
    expect(e.code).toBe('UNAUTHENTICATED');
    expect(events.lost).toEqual(['expired']);
  });

  it('says "replaced" if the refresh finds another phone took over', async () => {
    const { http, events } = setup((c) => (c.url.endsWith('/auth/refresh') ? err(401, 'SESSION_REPLACED') : err(401, 'UNAUTHENTICATED')));
    await http.request('GET', '/v1/patients').catch(() => undefined);
    expect(events.lost).toContain('replaced');
  });

  it('does not refresh when signed out, for device calls, or when the retry fails again', async () => {
    const signedOut = setup(() => err(401, 'UNAUTHENTICATED'), { getTokens: () => null });
    await signedOut.http.request('GET', '/v1/patients').catch(() => undefined);
    expect(signedOut.calls).toHaveLength(1);
    const device = setup(() => err(401, 'UNAUTHENTICATED'));
    await device.http.request('GET', '/v1/device/sync', { auth: 'device' }).catch(() => undefined);
    expect(device.calls).toHaveLength(1);
    const twice = setup((c) => (c.url.endsWith('/auth/refresh') ? json(200, { access_token: 'A2', refresh_token: 'R2' }) : err(401, 'UNAUTHENTICATED')));
    await twice.http.request('GET', '/v1/patients').catch(() => undefined);
    expect(twice.calls.filter((c) => c.url.endsWith('/v1/patients'))).toHaveLength(2); // one retry, then it gives up
  });
});
