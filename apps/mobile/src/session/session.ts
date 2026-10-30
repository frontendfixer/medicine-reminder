import { normalizeCode } from '@med/shared';
import { createApi, type Api, type DeviceInfo, type Patient } from '../api/endpoints';
import { ApiError, createHttp, type SessionLoss, type Tokens } from '../api/http';
import type { KeyValue } from './storage';

export type Mode = 'caregiver' | 'patient';
export interface PairedPatient {
  deviceToken: string;
  patientId: string;
  displayName: string;
  timezone: string;
}
export interface SessionState {
  ready: boolean;
  mode: Mode | null;
  caregiver: { email: string; tokens: Tokens } | null;
  patient: PairedPatient | null;
  deviceRejected: boolean;
  notice: SessionLoss | null; // why the caregiver was signed out, shown once on the sign-in screen
  upgradeRequired: { min: string | null } | null;
}

export interface SessionDeps {
  secure: KeyValue;
  plain: KeyValue;
  baseUrl: string;
  appVersion: string;
  platform: 'ios' | 'android';
  deviceLabel?: string;
  newId: () => string;
  fetch?: typeof fetch;
}

const K = {
  mode: 'med.mode',
  email: 'med.email',
  access: 'med.access',
  refresh: 'med.refresh',
  patient: 'med.patient',
  installId: 'med.install_id',
  rejected: 'med.device_rejected',
};

// Everything the app knows about who is using it. Plain TypeScript so it can be tested without a screen; React reads it
// through useSession. One phone can hold both modes at once (D-009), so the two sides are kept apart.
export class SessionService {
  private state: SessionState = { ready: false, mode: null, caregiver: null, patient: null, deviceRejected: false, notice: null, upgradeRequired: null };
  private listeners = new Set<() => void>();
  readonly api: Api;

  constructor(private readonly d: SessionDeps) {
    this.api = createApi(
      createHttp({
        baseUrl: d.baseUrl,
        appVersion: d.appVersion,
        platform: d.platform,
        newId: d.newId,
        fetch: d.fetch,
        getTokens: () => this.state.caregiver?.tokens ?? null,
        setTokens: (tokens) => void this.storeTokens(tokens),
        getDeviceToken: () => this.state.patient?.deviceToken ?? null,
        onSessionLost: (why) => void this.endCaregiverSession(why),
        onDeviceRejected: () => void this.markRejected(),
        onUpgradeRequired: (min) => this.set({ upgradeRequired: { min: min ?? null } }),
      }),
    );
  }

  getState = (): SessionState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  private set(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  // Reads what the last run left behind.
  async load(): Promise<void> {
    const { secure, plain } = this.d;
    const [mode, email, access, refresh, patient, rejected] = await Promise.all([plain.get(K.mode), secure.get(K.email), secure.get(K.access), secure.get(K.refresh), secure.get(K.patient), plain.get(K.rejected)]);
    this.set({
      ready: true,
      mode: mode === 'caregiver' || mode === 'patient' ? mode : null,
      caregiver: email && access && refresh ? { email, tokens: { access, refresh } } : null,
      patient: patient ? (JSON.parse(patient) as PairedPatient) : null,
      deviceRejected: rejected === '1',
    });
  }

  async setMode(mode: Mode | null): Promise<void> {
    if (mode) await this.d.plain.set(K.mode, mode);
    else await this.d.plain.remove(K.mode);
    this.set({ mode });
  }

  // ── Caregiver ──────────────────────────────────────────────────────────
  private deviceInfo(): DeviceInfo {
    return { platform: this.d.platform, app_version: this.d.appVersion, label: this.d.deviceLabel };
  }

  async signIn(email: string, password: string): Promise<void> {
    await this.adopt(email, await this.api.auth.login({ email, password, device: this.deviceInfo() }));
  }

  async register(email: string, password: string, noticeVersion: string): Promise<void> {
    await this.adopt(email, await this.api.auth.register({ email, password, device: this.deviceInfo(), consent: { notice_version: noticeVersion } }));
  }

  private async adopt(email: string, r: { access_token: string; refresh_token: string; user: { email: string } }): Promise<void> {
    await this.d.secure.set(K.email, r.user.email.toLowerCase() || email);
    await this.storeTokens({ access: r.access_token, refresh: r.refresh_token });
    this.set({ caregiver: { email: r.user.email, tokens: { access: r.access_token, refresh: r.refresh_token } }, notice: null });
  }

  private async storeTokens(tokens: Tokens): Promise<void> {
    await Promise.all([this.d.secure.set(K.access, tokens.access), this.d.secure.set(K.refresh, tokens.refresh)]);
    if (this.state.caregiver) this.set({ caregiver: { ...this.state.caregiver, tokens } });
  }

  // The user chose to sign out: tell the server, but sign out here whatever it says.
  async signOut(): Promise<void> {
    await this.api.auth.logout().catch(() => undefined);
    await this.clearCaregiver();
    this.set({ caregiver: null, notice: null });
  }

  // Another phone signed in, or the refresh token stopped working. Nothing more to call: just forget the session.
  private async endCaregiverSession(why: SessionLoss): Promise<void> {
    if (!this.state.caregiver) return;
    this.set({ caregiver: null, notice: why }); // the screen reacts at once; the files are cleaned up after
    await this.clearCaregiver();
  }

  private async clearCaregiver(): Promise<void> {
    await Promise.all([K.email, K.access, K.refresh].map((k) => this.d.secure.remove(k)));
  }

  dismissNotice(): void {
    this.set({ notice: null });
  }

  // ── Patient ────────────────────────────────────────────────────────────
  async installId(): Promise<string> {
    const existing = await this.d.plain.get(K.installId);
    if (existing) return existing;
    const fresh = this.d.newId();
    await this.d.plain.set(K.installId, fresh);
    return fresh;
  }

  // Redeems a code the patient typed or scanned. Returns the paired patient; throws ApiError for the screen to explain.
  async pair(rawCode: string, noticeVersion: string): Promise<PairedPatient> {
    const code = normalizeCode(rawCode);
    if (!code) throw new ApiError('CODE_INVALID', 422, 'That code is not right.');
    const result = await this.api.pairing.redeem({ code, device: { ...this.deviceInfo(), install_id: await this.installId() }, consent: { notice_version: noticeVersion } });
    const patient: PairedPatient = { deviceToken: result.device_token, patientId: result.patient.id, displayName: result.patient.display_name, timezone: result.patient.timezone };
    await this.d.secure.set(K.patient, JSON.stringify(patient));
    await this.d.plain.remove(K.rejected);
    this.set({ patient, deviceRejected: false });
    return patient;
  }

  // The server refused this phone's token (revoked). Alarms already scheduled keep firing: nothing is cancelled here (D-015).
  async markRejected(): Promise<void> {
    if (this.state.deviceRejected) return;
    this.set({ deviceRejected: true });
    await this.d.plain.set(K.rejected, '1');
  }

  // Forget the pairing on this phone only (the patient chose to stop sharing).
  async unpair(): Promise<void> {
    await this.d.secure.remove(K.patient);
    await this.d.plain.remove(K.rejected);
    this.set({ patient: null, deviceRejected: false });
  }

  patientsForCaregiver = async (): Promise<Patient[]> => (await this.api.patients.list()).items;
}
