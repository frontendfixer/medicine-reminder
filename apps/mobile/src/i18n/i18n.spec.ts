import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import en from './en.json';
import { t } from './index';

const root = join(__dirname, '..', '..');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f: string) => {
    const p = join(dir, f);
    if (f === 'node_modules' || f === '.expo') return [];
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.tsx') || p.endsWith('.ts') ? [p] : [];
  });
const sources = [...walk(join(root, 'app')), ...walk(join(root, 'src'))].filter((f) => !f.endsWith('.spec.ts') && !f.endsWith('.spec.tsx') && !f.includes('/testing/')); // test support is not shipped UI

describe('translations (CLAUDE.md: all user-facing strings go through translation files)', () => {
  it('looks up flat keys and fills in values', () => {
    expect(t('auth.signIn.title')).toBe('Sign in');
    expect(t('patients.devices.count', { count: 2 })).toBe('2 connected');
    expect(t('patient.connect.body', { name: 'Asha' })).toContain('Asha');
  });

  it('every key the code uses exists, and every key is used', () => {
    const used = new Set<string>();
    const source = sources.map((f) => readFileSync(f, 'utf8')).join('\n');
    for (const m of source.matchAll(/\bt\(\s*['"`]([\w.]+)['"`]/g)) used.add(m[1]!);
    for (const m of source.matchAll(/['"`]((?:app|common|error|mode|auth|notice|patients|patientNew|patient|pair|today|rejected|upgrade)\.[\w.]+)['"`]/g)) used.add(m[1]!);
    const prefixes = [...source.matchAll(/`((?:today|patients|pair)\.[\w.]+\.)\$\{/g)].map((m) => m[1]!); // keys built from a template, such as today.status.${status}
    const missing = [...used].filter((k) => !(k in en));
    expect(missing).toEqual([]); // keys used in code but missing from en.json
    const unused = Object.keys(en).filter((k) => !used.has(k) && !prefixes.some((pre) => k.startsWith(pre)) && ![...used].some((u) => k.startsWith(u + '.') || u.endsWith('.') && k.startsWith(u)));
    expect(unused).toEqual([]); // keys in en.json that nothing uses
  });

  it('no screen contains text a person reads outside the translation file', () => {
    const offenders: string[] = [];
    for (const file of sources.filter((f) => f.endsWith('.tsx'))) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        // JSX text between tags: ">Some words<" or a line that is only words inside a component.
        if (/>\s*[A-Za-z][^<>{}]*[A-Za-z.!?]\s*</.test(line) && !/^\s*(\/\/|\*)/.test(line)) offenders.push(`${file.replace(root, '')}:${i + 1}: ${line.trim()}`);
        if (/\b(title|placeholder|label|accessibilityLabel|text)=["'][A-Za-z]/.test(line)) offenders.push(`${file.replace(root, '')}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
