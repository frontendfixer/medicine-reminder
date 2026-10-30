import type { Planned, Scheduled } from './plan';

export interface Permissions {
  notifications: boolean;
  exactAlarm: boolean | null; // Android only
  batteryUnrestricted: boolean | null; // Android only
}

// What the engine needs from the phone's notification system. The Expo implementation is in expo-notifier.ts; tests use a
// fake that behaves the same way (scheduling an existing ID replaces it).
export interface Notifier {
  scheduled(): Promise<Scheduled[]>;
  schedule(p: Planned, patientId: string): Promise<void>;
  cancel(identifiers: string[]): Promise<void>;
  // Takes this dose's notifications out of the notification shade once it has been answered.
  dismiss(doseId: string): Promise<void>;
  permissions(): Promise<Permissions>;
}
