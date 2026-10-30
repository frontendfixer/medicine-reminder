import type { ApiErrorBody, ErrorCode } from '@med/shared';

// What went wrong, in terms the screens can act on. NETWORK means the request never got an answer.
export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode | 'NETWORK' | 'UNKNOWN',
    readonly status: number,
    message: string,
    readonly details: Record<string, unknown> = {},
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  get fields(): Record<string, string> {
    return (this.details.fields as Record<string, string> | undefined) ?? {};
  }
}

export type SessionLoss = 'replaced' | 'expired';
export type Auth = 'none' | 'caregiver' | 'device';

export interface Tokens {
  access: string;
  refresh: string;
}

export interface HttpOptions {
  baseUrl: string;
  appVersion: string;
  platform: 'ios' | 'android';
  fetch?: typeof fetch;
  newId: () => string; // Idempotency-Key source
  getTokens: () => Tokens | null;
  setTokens: (tokens: Tokens) => void;
  getDeviceToken: () => string | null;
  onSessionLost: (why: SessionLoss) => void; // another phone signed in, or the refresh token no longer works
  onDeviceRejected: () => void; // the patient's phone was revoked (D-015)
  onUpgradeRequired: (minVersion: string | undefined) => void; // D-080
}

export interface RequestOptions {
  auth?: Auth;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  // Writes carry an Idempotency-Key by default (docs/04-api.md#idempotency). Exempt routes pass false.
  idempotent?: boolean;
  idempotencyKey?: string;
}

// The one place that talks to the API: headers, errors, refresh, and the three situations that end a session or a pairing.
export function createHttp(o: HttpOptions) {
  const doFetch = o.fetch ?? fetch;
  let refreshing: Promise<boolean> | null = null;

  async function send<T>(method: string, path: string, opts: RequestOptions, key: string | undefined, retried: boolean): Promise<T> {
    const auth = opts.auth ?? 'caregiver';
    const headers: Record<string, string> = { Accept: 'application/json', 'X-App-Version': o.appVersion, 'X-Platform': o.platform };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (key) headers['Idempotency-Key'] = key;
    if (auth === 'caregiver') {
      const tokens = o.getTokens();
      if (tokens) headers.Authorization = `Bearer ${tokens.access}`;
    } else if (auth === 'device') {
      const token = o.getDeviceToken();
      if (token) headers.Authorization = `Device ${token}`;
    }
    const qs = opts.query ? Object.entries(opts.query).filter(([, v]) => v !== undefined).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&') : '';

    let res: Response;
    try {
      res = await doFetch(`${o.baseUrl}${path}${qs ? `?${qs}` : ''}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    } catch {
      throw new ApiError('NETWORK', 0, 'The server could not be reached.');
    }
    if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T;

    const error = await toError(res);
    if (error.code === 'SESSION_REPLACED') o.onSessionLost('replaced');
    if (error.code === 'DEVICE_TOKEN_REJECTED') o.onDeviceRejected();
    if (error.code === 'UPGRADE_REQUIRED') o.onUpgradeRequired(error.details.min_app_version as string | undefined);
    // An expired access token: refresh once and replay the same request (same Idempotency-Key, so a write can't double).
    if (auth === 'caregiver' && error.code === 'UNAUTHENTICATED' && !retried && o.getTokens()) {
      if (await refreshTokens()) return send<T>(method, path, opts, key, true);
      o.onSessionLost('expired');
    }
    throw error;
  }

  // Many requests can find the token expired at once; they share one refresh.
  function refreshTokens(): Promise<boolean> {
    refreshing ??= (async () => {
      try {
        const current = o.getTokens();
        if (!current) return false;
        const next = await send<{ access_token: string; refresh_token: string }>('POST', '/v1/auth/refresh', { auth: 'none', body: { refresh_token: current.refresh }, idempotent: false }, undefined, true);
        o.setTokens({ access: next.access_token, refresh: next.refresh_token });
        return true;
      } catch {
        return false; // SESSION_REPLACED has already been reported by send()
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  return {
    request<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, opts: RequestOptions = {}): Promise<T> {
      const write = method !== 'GET';
      const key = write && opts.idempotent !== false ? (opts.idempotencyKey ?? o.newId()) : undefined;
      return send<T>(method, path, opts, key, false);
    },
  };
}

export type Http = ReturnType<typeof createHttp>;

async function toError(res: Response): Promise<ApiError> {
  const retry = Number(res.headers.get('Retry-After') ?? '') || undefined;
  try {
    const { error } = (await res.json()) as ApiErrorBody;
    return new ApiError(error.code, res.status, error.message, error.details, retry);
  } catch {
    return new ApiError('UNKNOWN', res.status, 'Something went wrong.', {}, retry);
  }
}
