// Minimal translation lookup for the spike. The real app uses i18next (Phase 1).
import en from './strings.en.json';

export type StringKey = keyof typeof en;

export function t(key: StringKey, vars: Record<string, string | number> = {}): string {
  return en[key].replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars[name] ?? ''));
}
