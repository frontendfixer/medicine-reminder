import en from './en.json' with { type: 'json' };

// Every user-facing string the server sends comes from a translation file (CLAUDE.md). English only for now (D-003).
export type MessageKey = keyof typeof en;

export function t(key: MessageKey, params: Record<string, string | number> = {}): string {
  return en[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
}
