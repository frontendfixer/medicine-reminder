import { randomBytes } from 'node:crypto';
import { FieldEncryption, FieldEncryptionError } from './field-encryption.js';

const key = () => randomBytes(32);
const make = (active = 'k1') => new FieldEncryption({ k1: key(), k2: key() }, active);

describe('FieldEncryption', () => {
  it('round-trips text, including non-ASCII and empty strings', () => {
    const fe = make();
    for (const text of ['Metformin 500 mg', 'पैरासिटामोल', '😀 with : colons : inside', '']) {
      expect(fe.decrypt('medicines.name', fe.encrypt('medicines.name', text))).toBe(text);
    }
  });

  it('stores v1:<kid>:<iv>:<ciphertext> and never the plaintext', () => {
    const stored = make().encrypt('medicines.name', 'Metformin').toString('utf8');
    expect(stored).toMatch(/^v1:k1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
    expect(stored).not.toContain('Metformin');
  });

  it('uses a fresh random nonce each time', () => {
    const fe = make();
    const a = fe.encrypt('medicines.name', 'same');
    const b = fe.encrypt('medicines.name', 'same');
    expect(a.equals(b)).toBe(false);
  });

  it('rejects a ciphertext moved to another field', () => {
    const fe = make();
    const stored = fe.encrypt('medicines.name', 'Metformin');
    expect(() => fe.decrypt('medicines.notes', stored)).toThrow(FieldEncryptionError);
  });

  it('rejects tampered ciphertext, IV, key id and version', () => {
    const fe = make();
    const [v, kid, iv, body] = fe.encrypt('medicines.name', 'Metformin').toString('utf8').split(':') as [string, string, string, string];
    const flip = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
    for (const bad of [`${v}:${kid}:${iv}:${flip(body)}`, `${v}:${kid}:${flip(iv)}:${body}`, `${v}:k2:${iv}:${body}`, `v2:${kid}:${iv}:${body}`]) {
      expect(() => fe.decrypt('medicines.name', Buffer.from(bad))).toThrow(FieldEncryptionError);
    }
  });

  it('rejects malformed input and other keys', () => {
    const fe = make();
    for (const bad of ['', 'v1', 'v1:k1:abc', 'garbage:with:four:parts', 'v1:k1:AAAA:AAAA']) {
      expect(() => fe.decrypt('medicines.name', Buffer.from(bad))).toThrow(FieldEncryptionError);
    }
    expect(() => fe.decrypt('medicines.name', make().encrypt('medicines.name', 'x'))).toThrow(FieldEncryptionError);
  });

  it('keeps decrypting old data after rotation, and reports what needs re-encrypting', () => {
    const keys = { k1: key(), k2: key() };
    const old = new FieldEncryption(keys, 'k1').encrypt('patients.display_name', 'Asha');
    const rotated = new FieldEncryption(keys, 'k2');
    expect(rotated.decrypt('patients.display_name', old)).toBe('Asha');
    expect(rotated.isCurrent(old)).toBe(false);
    const fresh = rotated.encrypt('patients.display_name', 'Asha');
    expect(rotated.isCurrent(fresh)).toBe(true);
    expect(fresh.toString('utf8').startsWith('v1:k2:')).toBe(true);
  });

  it('refuses to read data whose key was removed', () => {
    const stored = new FieldEncryption({ k1: key() }, 'k1').encrypt('medicines.name', 'x');
    expect(() => new FieldEncryption({ k2: key() }, 'k2').decrypt('medicines.name', stored)).toThrow(/unknown key id/);
  });

  it('validates keys and the active key id', () => {
    expect(() => new FieldEncryption({ k1: randomBytes(16) }, 'k1')).toThrow(FieldEncryptionError);
    expect(() => new FieldEncryption({ 'bad:id': key() }, 'bad:id')).toThrow(FieldEncryptionError);
    expect(() => new FieldEncryption({ k1: key() }, 'k2')).toThrow(FieldEncryptionError);
  });

  it('never puts plaintext in error messages', () => {
    const fe = make();
    const secret = 'Metformin-SECRET';
    const stored = fe.encrypt('medicines.name', secret);
    try {
      fe.decrypt('medicines.notes', stored);
    } catch (e) {
      expect(String(e)).not.toContain(secret);
      expect(String(e)).not.toContain(stored.toString('utf8'));
    }
  });

  describe('fromEnv', () => {
    const k1 = randomBytes(32).toString('base64');
    const k2 = randomBytes(32).toString('base64');

    it('loads several keys and the active id', () => {
      const fe = FieldEncryption.fromEnv({ FIELD_ENCRYPTION_KEYS: `k1:${k1}, k2:${k2}`, FIELD_ENCRYPTION_ACTIVE_KID: 'k2' });
      expect(fe.encrypt('medicines.name', 'x').toString('utf8').startsWith('v1:k2:')).toBe(true);
    });

    it('fails fast on missing or malformed config', () => {
      expect(() => FieldEncryption.fromEnv({})).toThrow(FieldEncryptionError);
      expect(() => FieldEncryption.fromEnv({ FIELD_ENCRYPTION_KEYS: k1, FIELD_ENCRYPTION_ACTIVE_KID: 'k1' })).toThrow(FieldEncryptionError);
      expect(() => FieldEncryption.fromEnv({ FIELD_ENCRYPTION_KEYS: 'k1:c2hvcnQ=', FIELD_ENCRYPTION_ACTIVE_KID: 'k1' })).toThrow(FieldEncryptionError);
    });
  });
});
