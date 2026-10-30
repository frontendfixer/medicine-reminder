// "m:ss" for a countdown. Never negative.
export function formatRemaining(ms: number): string {
  const total = Math.max(Math.ceil(ms / 1000), 0);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// "08:00" in the person's own time zone, from an ISO instant.
export function localTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(new Date(iso));
}
