// Keeps medicine names, notes, photos, emails and credentials out of Sentry (D-063, CLAUDE.md, docs/10-security-privacy.md
// #observability-scrubbing). Pure functions: applied in beforeSend / beforeBreadcrumb, and tested on their own.
const FILTERED = '[Filtered]';

// Fields named like these never leave the server, wherever they sit in an event.
const DENY = /^(name|notes?|display_?name|amount.*|photo.*|url|code|token|.*_token|.*token$|push_?token|email|password.*|authorization|cookie|set-cookie|secret.*|refresh.*|device_?token|label|body|data|query_?string|response_?body)$/i;

// Things that look like secrets or personal data inside free text (exception messages, SQL parameters).
const PATTERNS: [RegExp, string][] = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [Filtered]'],
  [/Device\s+[A-Za-z0-9_-]{20,}/g, 'Device [Filtered]'],
  [/ExponentPushToken\[[^\]]*\]/g, 'ExponentPushToken[Filtered]'],
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[Filtered JWT]'],
  [/\$argon2[a-z]*\$[^\s"']+/g, '[Filtered hash]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[Filtered email]'],
  [/\bv1:[A-Za-z0-9_-]{1,32}:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+/g, '[Filtered ciphertext]'],
  [/\b[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}\b/g, '[Filtered code]'],
];

// Free text cannot be cleaned reliably: a person's data can sit anywhere in a message ("could not save <name>"). So
// exception and breadcrumb messages are not sent at all, except system errors that carry no data.
const SAFE_MESSAGE = /^(connect|getaddrinfo|read|write|listen) (E[A-Z]+|ETIMEDOUT)\b|^(Connection terminated|timeout exceeded|Redis connection)/i;

export function scrubText(text: string): string {
  // A database error echoes every bound value ("params: …"), which can be anything a person typed.
  const cut = text.search(/\bparams:/i);
  const base = cut >= 0 ? `${text.slice(0, cut)}params: [Filtered]` : text;
  return PATTERNS.reduce((t, [re, to]) => t.replace(re, to), base);
}

export function scrubValue(value: unknown, key = '', depth = 0): unknown {
  if (depth > 12) return FILTERED;
  if (key && DENY.test(key)) return FILTERED;
  if (typeof value === 'string') return scrubText(value);
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, '', depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, scrubValue(v, k, depth + 1)]));
  }
  return value;
}

type Loose = Record<string, unknown>;

// Request bodies, headers, cookies and query strings are dropped outright; people are identified by internal ID only.
export function scrubEvent<T>(event: T): T {
  const e = { ...(event as Loose) };
  if (e.request) {
    const { method, url } = e.request as { method?: string; url?: string };
    e.request = { method, url: typeof url === 'string' ? scrubText(url.split('?')[0]!) : undefined };
  }
  if (e.user) e.user = { id: (e.user as { id?: string }).id };
  delete e.server_name;
  if (e.extra) e.extra = scrubValue(e.extra);
  if (e.contexts) e.contexts = scrubValue(e.contexts);
  if (e.tags) e.tags = scrubValue(e.tags);
  if (typeof e.message === 'string') e.message = SAFE_MESSAGE.test(e.message) ? scrubText(e.message) : '[Filtered message]';
  if (e.breadcrumbs) e.breadcrumbs = (e.breadcrumbs as Loose[]).map((b) => scrubBreadcrumb(b)).filter(Boolean);
  const exception = e.exception as { values?: Loose[] } | undefined;
  if (exception?.values) {
    e.exception = {
      ...exception,
      values: exception.values.map((v) => ({
        ...v,
        value: typeof v.value === 'string' ? (SAFE_MESSAGE.test(v.value) ? scrubText(v.value) : '[Filtered message]') : v.value,
        // Stack frames keep file and line; local variables are removed.
        stacktrace: v.stacktrace ? { frames: ((v.stacktrace as { frames?: Loose[] }).frames ?? []).map(({ vars: _vars, ...frame }) => frame) } : undefined,
      })),
    };
  }
  return e as T;
}

export function scrubBreadcrumb<T>(crumb: T): T | null {
  const b = crumb as Loose;
  if (b.category === 'console') return null; // log lines can contain anything
  const out: Loose = { ...b };
  delete out.message;
  if (out.data) {
    out.data = scrubValue(out.data); // includes the `url` key, which is on the deny list
  }
  return out as T;
}
