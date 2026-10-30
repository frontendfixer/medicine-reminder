// Field-level encryption for medicine names, notes, snapshots and patient names.
// Spec: docs/10-security-privacy.md#field-level-encryption (D-066, D-082).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Where a ciphertext may be used. It is bound into the AAD, so a value copied to another column fails to decrypt.
export type EncryptedField =
  | 'medicines.name'
  | 'medicines.notes'
  | 'dose_instances.name_snapshot'
  | 'patients.display_name';

const VERSION = 'v1';
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // 96-bit random IV, NIST SP 800-38D 8.2.2 (R-63)
const TAG_BYTES = 16;
const KID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

// Messages never contain plaintext, keys or ciphertext: they may reach logs and Sentry.
export class FieldEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FieldEncryptionError';
  }
}

export class FieldEncryption {
  private readonly keys = new Map<string, Buffer>();

  constructor(
    keys: Record<string, Buffer>,
    private readonly activeKid: string,
  ) {
    for (const [kid, key] of Object.entries(keys)) {
      if (!KID_PATTERN.test(kid)) throw new FieldEncryptionError('invalid key id');
      if (key.length !== KEY_BYTES) throw new FieldEncryptionError(`key "${kid}" must be ${KEY_BYTES} bytes`);
      this.keys.set(kid, Buffer.from(key));
    }
    if (!this.keys.has(activeKid)) throw new FieldEncryptionError('active key id is not in the key set');
  }

  // FIELD_ENCRYPTION_KEYS="kid1:<base64 32 bytes>,kid2:<base64 32 bytes>"; FIELD_ENCRYPTION_ACTIVE_KID="kid1".
  // The values come from the secret manager. Generate one with `openssl rand -base64 32`.
  static fromEnv(env: Record<string, string | undefined> = process.env): FieldEncryption {
    const raw = env.FIELD_ENCRYPTION_KEYS;
    const active = env.FIELD_ENCRYPTION_ACTIVE_KID;
    if (!raw || !active) throw new FieldEncryptionError('FIELD_ENCRYPTION_KEYS and FIELD_ENCRYPTION_ACTIVE_KID are required');
    const keys: Record<string, Buffer> = {};
    for (const entry of raw.split(',')) {
      const [kid, b64, extra] = entry.trim().split(':');
      if (!kid || !b64 || extra !== undefined) throw new FieldEncryptionError('FIELD_ENCRYPTION_KEYS must be kid:base64 pairs');
      keys[kid] = Buffer.from(b64, 'base64');
    }
    return new FieldEncryption(keys, active);
  }

  // Returns the bytes to store in a bytea column: "v1:<kid>:<iv>:<ciphertext||tag>" (base64url parts).
  encrypt(field: EncryptedField, plaintext: string): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key(this.activeKid), iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad(this.activeKid, field));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return Buffer.from(`${VERSION}:${this.activeKid}:${iv.toString('base64url')}:${body.toString('base64url')}`, 'utf8');
  }

  decrypt(field: EncryptedField, stored: Buffer): string {
    const { kid, iv, body } = parse(stored);
    if (body.length < TAG_BYTES) throw new FieldEncryptionError('malformed ciphertext');
    const decipher = createDecipheriv('aes-256-gcm', this.key(kid), iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(kid, field));
    decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
    try {
      return Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]).toString('utf8');
    } catch {
      // Wrong key, wrong field or tampered data: callers can't tell which, and shouldn't.
      throw new FieldEncryptionError('decryption failed');
    }
  }

  // True when the value was written with the active key. Rotation re-encrypts values where this is false.
  isCurrent(stored: Buffer): boolean {
    return parse(stored).kid === this.activeKid;
  }

  private key(kid: string): Buffer {
    const key = this.keys.get(kid);
    if (!key) throw new FieldEncryptionError(`unknown key id "${kid}"`);
    return key;
  }
}

function aad(kid: string, field: EncryptedField): Buffer {
  return Buffer.from(`${VERSION}:${kid}:${field}`, 'utf8');
}

function parse(stored: Buffer): { kid: string; iv: Buffer; body: Buffer } {
  const parts = stored.toString('utf8').split(':');
  const [version, kid, iv, body] = parts;
  if (parts.length !== 4 || version !== VERSION || !kid || !iv || !body || !KID_PATTERN.test(kid)) {
    throw new FieldEncryptionError('malformed ciphertext');
  }
  const ivBytes = Buffer.from(iv, 'base64url');
  if (ivBytes.length !== IV_BYTES) throw new FieldEncryptionError('malformed ciphertext');
  return { kid, iv: ivBytes, body: Buffer.from(body, 'base64url') };
}
