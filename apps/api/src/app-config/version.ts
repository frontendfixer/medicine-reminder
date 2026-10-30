// "1.2.10" style versions: numeric parts compared left to right, missing parts count as 0.
// Returns null for anything that is not dotted numbers.
export function parseVersion(v: string): number[] | null {
  const m = /^(\d+(?:\.\d+){0,3})(?:[-+].*)?$/.exec(v.trim());
  return m ? m[1]!.split('.').map(Number) : null;
}

export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
