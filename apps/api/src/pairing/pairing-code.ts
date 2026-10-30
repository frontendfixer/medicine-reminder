import { randomInt } from 'node:crypto';

// 31 symbols, no 0/O or 1/I/L (D-010). 31^8 is about 8.5e11 codes.
export const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const LENGTH = 8;

export function generateCode(): string {
  let code = '';
  for (let i = 0; i < LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

// Uppercase, drop spaces and dashes. Returns null unless it is exactly 8 symbols from the alphabet.
export function normalizeCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  return code.length === LENGTH && [...code].every((c) => ALPHABET.includes(c)) ? code : null;
}

export const formatCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;
export const lookupPart = (code: string) => code.slice(0, 4); // D-084
export const qrPayload = (code: string, kind: 'pair' | 'transfer') => (kind === 'pair' ? `medremind://pair?c=${code}` : `medremind://transfer?c=${code}`);
