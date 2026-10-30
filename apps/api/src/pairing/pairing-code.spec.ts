import { ALPHABET, formatCode, generateCode, lookupPart, normalizeCode, qrPayload } from './pairing-code.js';

describe('pairing codes', () => {
  it('has 31 distinct symbols and none of the look-alikes', () => {
    expect(ALPHABET).toHaveLength(31);
    expect(new Set(ALPHABET).size).toBe(31);
    for (const bad of '01OIL') expect(ALPHABET).not.toContain(bad);
  });

  it('generates 8 symbols from the alphabet, using every symbol over many draws', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const code = generateCode();
      expect(code).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
      for (const c of code) seen.add(c);
    }
    expect(seen.size).toBe(31);
  });

  it('formats as XXXX-XXXX and normalises what people type', () => {
    expect(formatCode('ABCD2345')).toBe('ABCD-2345');
    for (const typed of ['abcd-2345', 'ABCD 2345', ' abcd2345 ', 'AB-CD-23-45']) expect(normalizeCode(typed)).toBe('ABCD2345');
  });

  it('rejects codes that are the wrong length or use excluded symbols', () => {
    for (const bad of ['', 'ABCD234', 'ABCD23456', 'ABCD-23O5', 'ABCD-2315', 'ABCD-23I5', '####-####']) expect(normalizeCode(bad)).toBeNull();
  });

  it('uses the first 4 symbols as the lookup part and builds the QR payload', () => {
    expect(lookupPart('ABCD2345')).toBe('ABCD');
    expect(qrPayload('ABCD2345', 'pair')).toBe('medremind://pair?c=ABCD2345');
    expect(qrPayload('ABCD2345', 'transfer')).toBe('medremind://transfer?c=ABCD2345');
  });
});
