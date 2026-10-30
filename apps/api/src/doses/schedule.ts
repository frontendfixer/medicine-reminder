// Turns a schedule version into dose instants. Pure: no database, no clock. Rules: docs/05-reminder-engine.md
// (Dose generation) and D-034, D-086. The phone never runs this (D-035).
import type { SchedulePattern } from '@med/shared';

export interface ScheduleInput {
  pattern: SchedulePattern;
  daysOfWeek: readonly number[] | null; // ISO 1 = Monday .. 7 = Sunday
  intervalDays: number | null;
  startDate: string; // local date, YYYY-MM-DD; the every_n_days anchor
  endDate: string | null;
  times: readonly { localTime: string; amountText: string }[]; // "08:00" or "08:00:00"
  effectiveFrom: Date;
  effectiveUntil: Date | null;
}

export interface Occurrence {
  scheduledAt: Date;
  localTime: string; // "HH:MM", the wall-clock time the caregiver asked for
  amountText: string;
}

// D-086. DST gap (the clock skips forward): the dose fires at the first valid minute after the gap, not shifted
// by the gap length as Temporal's default would. DST overlap (the clock repeats): the first occurrence.
export function localToInstant(date: Temporal.PlainDate, localTime: string, timeZone: string): Temporal.ZonedDateTime {
  const [hour, minute] = localTime.split(':').map(Number) as [number, number];
  const wanted = date.toPlainDateTime({ hour, minute });
  const zoned = wanted.toZonedDateTime(timeZone, { disambiguation: 'compatible' }); // overlap: earlier offset
  if (Temporal.PlainDateTime.compare(zoned.toPlainDateTime(), wanted) === 0) return zoned;
  // Inside a gap: `compatible` moved us forward by the gap length. The gap's end is the latest transition at or
  // before that instant ("previous" alone is strictly earlier, and misses a request for the gap's first minute).
  return zoned.add({ nanoseconds: 1 }).getTimeZoneTransition('previous') ?? zoned;
}

function includesDate(s: ScheduleInput, date: Temporal.PlainDate): boolean {
  const start = Temporal.PlainDate.from(s.startDate);
  if (Temporal.PlainDate.compare(date, start) < 0) return false;
  if (s.endDate && Temporal.PlainDate.compare(date, Temporal.PlainDate.from(s.endDate)) > 0) return false;
  switch (s.pattern) {
    case 'daily':
      return true;
    case 'weekdays':
      return (s.daysOfWeek ?? []).includes(date.dayOfWeek);
    case 'every_n_days':
      return s.intervalDays !== null && s.intervalDays >= 1 && start.until(date, { largestUnit: 'days' }).days % s.intervalDays === 0;
  }
}

// Doses of `s` with `from <= scheduledAt < to`, also inside [effectiveFrom, effectiveUntil), in time order.
export function occurrences(s: ScheduleInput, timeZone: string, from: Date, to: Date): Occurrence[] {
  const lower = Math.max(from.getTime(), s.effectiveFrom.getTime());
  const upper = Math.min(to.getTime(), s.effectiveUntil?.getTime() ?? Infinity);
  if (lower >= upper) return [];

  // One day of slack each side: local dates near the window edge can map to instants inside it.
  let date = Temporal.Instant.fromEpochMilliseconds(lower).toZonedDateTimeISO(timeZone).toPlainDate().subtract({ days: 1 });
  const last = Temporal.Instant.fromEpochMilliseconds(upper).toZonedDateTimeISO(timeZone).toPlainDate().add({ days: 1 });
  const seen = new Set<number>();
  const out: Occurrence[] = [];
  for (; Temporal.PlainDate.compare(date, last) <= 0; date = date.add({ days: 1 })) {
    if (!includesDate(s, date)) continue;
    for (const t of s.times) {
      const ms = localToInstant(date, t.localTime, timeZone).epochMilliseconds;
      if (ms < lower || ms >= upper || seen.has(ms)) continue; // two times can land on one instant at a gap
      seen.add(ms);
      out.push({ scheduledAt: new Date(ms), localTime: t.localTime.slice(0, 5), amountText: t.amountText });
    }
  }
  return out.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
}
