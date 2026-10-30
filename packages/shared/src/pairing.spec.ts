import { describe, expect, it } from 'vitest';
import { CODE_ALPHABET, formatCode, normalizeCode, parseQrPayload, qrPayload } from './pairing.js';

describe('pairing code rules', () => {
  it('has 31 distinct symbols without look-alikes', () => {
    expect(CODE_ALPHABET).toHaveLength(31);
    expect(new Set(CODE_ALPHABET).size).toBe(31);
    for (const bad of '01OIL') expect(CODE_ALPHABET).not.toContain(bad);
  });
  it('normalises what people type and refuses the rest', () => {
    for (const typed of ['abcd-2345', 'ABCD 2345', ' abcd2345 ', 'AB-CD-23-45']) expect(normalizeCode(typed)).toBe('ABCD2345');
    for (const bad of ['', 'ABCD234', 'ABCD23456', 'ABCD-23O5', 'ABCD-2315', '####-####']) expect(normalizeCode(bad)).toBeNull();
    expect(formatCode('ABCD2345')).toBe('ABCD-2345');
  });
  it('round-trips the QR payload', () => {
    expect(qrPayload('ABCD2345', 'pair')).toBe('medremind://pair?c=ABCD2345');
    expect(parseQrPayload('medremind://pair?c=ABCD2345')).toEqual({ kind: 'pair', code: 'ABCD2345' });
    expect(parseQrPayload(' medremind://transfer?c=abcd2345 ')).toEqual({ kind: 'transfer', code: 'ABCD2345' });
  });
  it('rejects anything that is not one of our payloads', () => {
    for (const bad of ['', 'https://example.com', 'medremind://pair?c=SHORT', 'medremind://pair?c=ABCD2345&x=1', 'medremind://other?c=ABCD2345', 'medremind://pair?c=ABCD-23O5']) expect(parseQrPayload(bad)).toBeNull();
  });
});
