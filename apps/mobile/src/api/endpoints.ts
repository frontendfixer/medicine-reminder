import type { DoseStatus, LockscreenDetail, NotificationType, PatientStatus, PatientType, Platform, TzMode } from '@med/shared';
import type { Http } from './http';

// Response shapes, as documented in docs/04-api.md.
export interface DeviceSummary {
  id: string;
  platform: Platform;
  label: string | null;
  app_version: string | null;
  last_seen_at: string | null;
  scheduled_through: string | null;
  healthy: boolean;
  problems: string[];
  created_at: string;
  revoked_at: string | null;
}
export interface Patient {
  id: string;
  display_name: string;
  type: PatientType;
  timezone: string;
  tz_mode: TzMode;
  missed_delay_min: number | null;
  lockscreen_detail: LockscreenDetail | null;
  status: PatientStatus;
  devices: DeviceSummary[];
  created_at: string;
}
export interface DeviceInfo {
  platform: Platform;
  app_version: string;
  label?: string;
  push_token?: string;
  tz?: string;
}
export interface AuthResult {
  access_token: string;
  refresh_token: string;
  user: { id: string; email: string };
  session_replaced_previous: boolean;
  self_profile_device_token?: string;
}
export interface PairingCode {
  code: string;
  qr_payload: string;
  expires_at: string;
}
export interface RedeemResult {
  device_id: string;
  device_token: string;
  patient: { id: string; display_name: string; timezone: string };
}
export interface SyncDose {
  id: string;
  medicine_id: string;
  scheduled_at: string;
  local_time: string;
  name: string;
  amount: string;
  status: DoseStatus;
  snooze_until: string | null;
  alert_due_at: string;
  notification_type: NotificationType;
}
export interface SyncResult {
  cursor: string;
  patient: { id: string; display_name: string; timezone: string; status: PatientStatus; lockscreen_detail: LockscreenDetail };
  account_state: 'active' | 'grace' | 'suspended';
  medicines: { id: string; name: string; notes: string | null; notification_type: NotificationType; photo: { url: string; expires_at: string; etag: string } | null }[];
  doses: SyncDose[];
  window: { from: string; through: string };
  commands: string[];
}
export interface Subscription {
  plan: string | null;
  patient_limit: number;
  managed_patients: number;
  status: 'active' | 'store_grace' | 'grace' | 'expired' | null;
  renews_at: string | null;
  expired_at: string | null;
  cutoff_at: string | null;
}

// One function per endpoint the app uses, so screens never build URLs.
export function createApi(http: Http) {
  return {
    auth: {
      register: (b: { email: string; password: string; device: DeviceInfo; consent: { notice_version: string } }) => http.request<AuthResult>('POST', '/v1/auth/register', { auth: 'none', body: b, idempotent: false }),
      login: (b: { email: string; password: string; device: DeviceInfo }) => http.request<AuthResult>('POST', '/v1/auth/login', { auth: 'none', body: b, idempotent: false }),
      logout: () => http.request<void>('POST', '/v1/auth/logout', { idempotent: false }),
    },
    subscription: {
      get: () => http.request<Subscription>('GET', '/v1/subscription'),
    },
    patients: {
      list: () => http.request<{ items: Patient[] }>('GET', '/v1/patients'),
      get: (id: string) => http.request<Patient>('GET', `/v1/patients/${id}`),
      create: (b: { display_name: string; type: PatientType; timezone: string; tz_mode?: TzMode }) => http.request<Patient>('POST', '/v1/patients', { body: b }),
      archive: (id: string) => http.request<Patient>('POST', `/v1/patients/${id}/archive`),
    },
    pairing: {
      createCode: (patientId: string) => http.request<PairingCode>('POST', `/v1/patients/${patientId}/pairing-code`),
      // No caller yet and the response carries the device token, so no Idempotency-Key (D-098).
      redeem: (b: { code: string; device: DeviceInfo & { install_id: string }; consent: { notice_version: string } }) => http.request<RedeemResult>('POST', '/v1/pairing/redeem', { auth: 'none', body: b, idempotent: false }),
    },
    devices: {
      revoke: (deviceId: string) => http.request<DeviceSummary>('POST', `/v1/devices/${deviceId}/revoke`),
    },
    device: {
      sync: () => http.request<SyncResult>('GET', '/v1/device/sync', { auth: 'device' }),
    },
  };
}
export type Api = ReturnType<typeof createApi>;
