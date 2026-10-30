import type { Request } from 'express';

// Who is calling. Set by the caregiver (JWT) and device (token) guards; unauthenticated routes have none.
export interface Principal {
  type: 'caregiver' | 'device';
  id: string; // users.id for caregivers, devices.id for patient devices
  sessionId?: string; // caregivers: auth_sessions.id
  patientId?: string; // devices: the one patient this device is scoped to
}

export type AuthedRequest = Request & { principal?: Principal };
