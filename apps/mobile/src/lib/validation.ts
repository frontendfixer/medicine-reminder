// Quick checks before calling the server, so people get an answer without waiting. The server is the authority.
export const looksLikeEmail = (v: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim());
// Counted in characters, not UTF-16 units, matching the server (8 to 128, D-096).
export const passwordLongEnough = (v: string): boolean => Array.from(v).length >= 8;
