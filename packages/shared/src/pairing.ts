// Pairing and transfer code rules shared by the API and the apps (docs/06-pairing-and-devices.md#code-format).
// 31 symbols, no 0/O or 1/I/L (D-010).
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 8;

// Uppercase, drop spaces and dashes. Returns null unless it is exactly 8 symbols from the alphabet.
export function normalizeCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  return code.length === CODE_LENGTH && code.split('').every((c) => CODE_ALPHABET.includes(c)) ? code : null;
}

export const formatCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;

export type CodeKind = 'pair' | 'transfer';

export const qrPayload = (code: string, kind: CodeKind): string => `medremind://${kind}?c=${code}`;

// What a scanned QR code holds. Anything that is not one of our payloads is null.
export function parseQrPayload(data: string): { kind: CodeKind; code: string } | null {
  const m = /^medremind:\/\/(pair|transfer)\?c=([^&\s]+)$/i.exec(data.trim());
  const code = m ? normalizeCode(m[2]!) : null;
  return m && code ? { kind: m[1]!.toLowerCase() as CodeKind, code } : null;
}
