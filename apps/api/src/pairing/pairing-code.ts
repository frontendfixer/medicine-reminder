import { randomInt } from 'node:crypto';
import { CODE_ALPHABET, CODE_LENGTH } from '@med/shared';

// The alphabet, normalisation, formatting and QR payload are shared with the apps (@med/shared).
export { CODE_ALPHABET as ALPHABET, formatCode, normalizeCode, qrPayload } from '@med/shared';

export function generateCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

export const lookupPart = (code: string) => code.slice(0, 4); // D-084
