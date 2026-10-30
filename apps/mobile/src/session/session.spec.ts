import { ApiError } from '../api/http';
import { SessionService } from './session';
import { memoryStorage } from './storage';

const json = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status });
const authResult = (email = 'a@b.co') => ({ access_token: 'A1', refresh_token: 'R1', user: { id: 'u1', email }, session_replaced_previous: false });
const redeemed = { device_id: 'd1', device_token: 'DT', patient: { id: 'p1', display_name: 'Asha', timezone: 'Asia/Kolkata' } };

function make(handler: (url: string, init: RequestInit) => Response | Promise<Response> = () => json(200, {})) {
  const secure = memoryStorage();
  const plain = memoryStorage();
  const calls: { url: string; body?: unknown; headers: Record<string, string> }[] = [];
  let n = 0;
  const svc = new SessionService({
    secure,
    plain,
    baseUrl: 'https://api.test',
    appVersion: '1.0.0',
    platform: 'android',
    deviceLabel: 'Pixel 8',
    newId: () => `id-${++n}`,
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body ? JSON.parse(init.body as string) : undefined, headers: init.headers as Record<string, string> });
      return handler(url, init);
    }) as unknown as typeof fetch,
  });
  return { svc, secure, plain, calls };
}

describe('caregiver', () => {
  it('signs in, keeps the tokens in secure storage and sends the phone details', async () => {
    const { svc, secure, calls } = make(() => json(200, authResult()));
    await svc.load();
    await svc.signIn('a@b.co', 'secret-pw');
    expect(svc.getState().caregiver).toEqual({ email: 'a@b.co', tokens: { access: 'A1', refresh: 'R1' } });
    expect(secure.data.get('med.access')).toBe('A1');
    expect(secure.data.get('med.refresh')).toBe('R1');
    expect(calls[0]!.body).toMatchObject({ email: 'a@b.co', device: { platform: 'android', app_version: '1.0.0', label: 'Pixel 8' } });
    expect(calls[0]!.headers['Idempotency-Key']).toBeUndefined(); // auth/* is exempt
  });

  it('registers with the notice version the person agreed to', async () => {
    const { svc, calls } = make(() => json(201, authResult()));
    await svc.register('a@b.co', 'secret-pw', '2026-10');
    expect(calls[0]!.url).toBe('https://api.test/v1/auth/register');
    expect(calls[0]!.body).toMatchObject({ consent: { notice_version: '2026-10' } });
  });

  it('restores the session on the next launch', async () => {
    const first = make(() => json(200, authResult()));
    await first.svc.signIn('a@b.co', 'pw');
    await first.svc.setMode('caregiver');
    const second = new SessionService({ secure: first.secure, plain: first.plain, baseUrl: 'x', appVersion: '1', platform: 'android', newId: () => 'i' });
    expect(second.getState().ready).toBe(false);
    await second.load();
    expect(second.getState()).toMatchObject({ ready: true, mode: 'caregiver', caregiver: { email: 'a@b.co', tokens: { access: 'A1', refresh: 'R1' } } });
  });

  it('signing out clears everything even if the server cannot be reached', async () => {
    const { svc, secure } = make((url) => (url.endsWith('/logout') ? json(500, { error: { code: 'INTERNAL', message: 'x', details: {} } }) : json(200, authResult())));
    await svc.signIn('a@b.co', 'pw');
    await svc.signOut();
    expect(svc.getState().caregiver).toBeNull();
    for (const k of ['med.email', 'med.access', 'med.refresh']) expect(secure.data.has(k)).toBe(false);
  });

  it('when another phone signs in, it forgets the session and says why (D-019)', async () => {
    let calls = 0;
    const { svc, secure } = make((url) => (calls++ === 0 ? json(200, authResult()) : json(401, { error: { code: 'SESSION_REPLACED', message: 'x', details: {} } })));
    await svc.signIn('a@b.co', 'pw');
    await svc.api.patients.list().catch(() => undefined);
    expect(svc.getState()).toMatchObject({ caregiver: null, notice: 'replaced' });
    expect(secure.data.has('med.access')).toBe(false);
    svc.dismissNotice();
    expect(svc.getState().notice).toBeNull();
  });

  it('notifies subscribers when the state changes', async () => {
    const { svc } = make();
    const seen: boolean[] = [];
    const off = svc.subscribe(() => seen.push(svc.getState().ready));
    await svc.load();
    off();
    await svc.setMode('patient');
    expect(seen).toEqual([true]);
  });
});

describe('patient', () => {
  it('pairs: normalises the code, sends a stable install ID, stores the device token securely', async () => {
    const { svc, secure, calls } = make(() => json(201, redeemed));
    await svc.load();
    const paired = await svc.pair(' abcd 2345 ', '2026-10');
    expect(paired).toEqual({ deviceToken: 'DT', patientId: 'p1', displayName: 'Asha', timezone: 'Asia/Kolkata' });
    expect(calls[0]!.body).toMatchObject({ code: 'ABCD2345', device: { install_id: 'id-1', label: 'Pixel 8' }, consent: { notice_version: '2026-10' } });
    expect(JSON.parse(secure.data.get('med.patient')!)).toMatchObject({ deviceToken: 'DT' });
    expect(calls[0]!.headers.Authorization).toBeUndefined();
    await svc.pair('ABCD2345', '2026-10');
    expect((calls[1]!.body as { device: { install_id: string } }).device.install_id).toBe('id-1'); // same install, same ID
  });

  it('refuses a malformed code without calling the server', async () => {
    const { svc, calls } = make();
    const e = (await svc.pair('NOT A CODE', '1').catch((x: ApiError) => x)) as ApiError;
    expect(e.code).toBe('CODE_INVALID');
    expect(calls).toHaveLength(0);
  });

  it('passes the server’s reasons through for the screen to explain', async () => {
    const { svc } = make(() => json(410, { error: { code: 'CODE_EXPIRED_OR_USED', message: 'x', details: {} } }));
    expect(await svc.pair('ABCD2345', '1').catch((x: ApiError) => x.code)).toBe('CODE_EXPIRED_OR_USED');
    expect(svc.getState().patient).toBeNull();
  });

  it('a revoked phone is flagged, keeps its token, and a new pairing clears the flag (D-015)', async () => {
    let step = 0;
    const { svc, plain } = make(() => (step++ === 0 ? json(401, { error: { code: 'DEVICE_TOKEN_REJECTED', message: 'x', details: {} } }) : json(201, redeemed)));
    await svc.pair('ABCD2345', '1').catch(() => undefined); // hits the rejection handler too, harmlessly
    await svc.markRejected();
    expect(svc.getState().deviceRejected).toBe(true);
    expect(plain.data.get('med.device_rejected')).toBe('1');
    await svc.pair('ABCD2345', '1');
    expect(svc.getState()).toMatchObject({ deviceRejected: false, patient: { patientId: 'p1' } });
  });

  it('unpairing forgets the token on this phone only', async () => {
    const { svc, secure } = make(() => json(201, redeemed));
    await svc.pair('ABCD2345', '1');
    await svc.unpair();
    expect(svc.getState().patient).toBeNull();
    expect(secure.data.has('med.patient')).toBe(false);
  });

  it('both modes can be held on one phone at once (D-009)', async () => {
    const { svc } = make((url) => (url.includes('pairing') ? json(201, redeemed) : json(200, authResult())));
    await svc.signIn('a@b.co', 'pw');
    await svc.pair('ABCD2345', '1');
    expect(svc.getState()).toMatchObject({ caregiver: { email: 'a@b.co' }, patient: { patientId: 'p1' } });
  });
});

describe('forced update (D-080)', () => {
  it('is noted without touching the session or the pairing', async () => {
    const { svc } = make((url) => (url.includes('pairing') ? json(201, redeemed) : json(426, { error: { code: 'UPGRADE_REQUIRED', message: 'x', details: { min_app_version: '2.0.0' } } })));
    await svc.pair('ABCD2345', '1');
    await svc.api.device.sync().catch(() => undefined);
    expect(svc.getState().upgradeRequired).toEqual({ min: '2.0.0' });
    expect(svc.getState().patient).not.toBeNull();
  });
});
