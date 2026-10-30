import * as SecureStore from 'expo-secure-store';
import Storage from 'expo-sqlite/kv-store';

export interface KeyValue {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

// Credentials. AFTER_FIRST_UNLOCK so a background task can read the device token after a reboot once the phone has been
// unlocked once (docs/06-pairing-and-devices.md#device-tokens). Android keeps these out of Auto Backup by itself (R-04).
export const secureStorage: KeyValue = {
  get: (k) => SecureStore.getItemAsync(k, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK }),
  set: (k, v) => SecureStore.setItemAsync(k, v, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK }),
  remove: (k) => SecureStore.deleteItemAsync(k, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK }),
};

// Not secret, and deliberately *not* the keychain: the install ID must change when the app is reinstalled, and iOS keeps
// keychain items across reinstalls.
export const plainStorage: KeyValue = {
  get: (k) => Storage.getItem(k),
  set: (k, v) => Storage.setItem(k, v),
  remove: (k) => Storage.removeItem(k),
};

export function memoryStorage(): KeyValue & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: (k) => Promise.resolve(data.get(k) ?? null),
    set: (k, v) => Promise.resolve(void data.set(k, v)),
    remove: (k) => Promise.resolve(void data.delete(k)),
  };
}
