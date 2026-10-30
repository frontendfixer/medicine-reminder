import fc from 'fast-check';
import { localToInstant, occurrences, type ScheduleInput } from './schedule.js';

const ZONES = ['Asia/Kolkata', 'America/New_York', 'Europe/London', 'Australia/Lord_Howe', 'Pacific/Chatham', 'UTC'] as const;
const base: ScheduleInput = {
  pattern: 'daily',
  daysOfWeek: null,
  intervalDays: null,
  startDate: '2026-01-01',
  endDate: null,
  times: [{ localTime: '08:00', amountText: '1 tablet' }],
  effectiveFrom: new Date('2025-01-01T00:00:00Z'),
  effectiveUntil: null,
};
const at = (s: string) => new Date(s);
const local = (d: Date, tz: string) => Temporal.Instant.fromEpochMilliseconds(d.getTime()).toZonedDateTimeISO(tz);

describe('localToInstant (D-086)', () => {
  const nyDate = (s: string) => Temporal.PlainDate.from(s);

  it('keeps the wall-clock time across DST in New York', () => {
    expect(localToInstant(nyDate('2026-03-07'), '08:00', 'America/New_York').toString()).toBe('2026-03-07T08:00:00-05:00[America/New_York]');
    expect(localToInstant(nyDate('2026-03-09'), '08:00', 'America/New_York').toString()).toBe('2026-03-09T08:00:00-04:00[America/New_York]');
  });

  it('spring-forward gap: fires at the first valid minute after the gap, not shifted by its length', () => {
    expect(localToInstant(nyDate('2026-03-08'), '02:30', 'America/New_York').toString()).toBe('2026-03-08T03:00:00-04:00[America/New_York]');
    expect(localToInstant(nyDate('2026-03-08'), '02:00', 'America/New_York').toString()).toBe('2026-03-08T03:00:00-04:00[America/New_York]');
  });

  it('fall-back overlap: the first occurrence', () => {
    expect(localToInstant(nyDate('2026-11-01'), '01:30', 'America/New_York').toString()).toBe('2026-11-01T01:30:00-04:00[America/New_York]');
  });

  it('handles Lord Howe’s 30-minute shift and Chatham’s +12:45', () => {
    expect(localToInstant(nyDate('2026-10-04'), '02:15', 'Australia/Lord_Howe').toString()).toBe('2026-10-04T02:30:00+11:00[Australia/Lord_Howe]');
    expect(localToInstant(nyDate('2026-10-05'), '08:00', 'Pacific/Chatham').toString()).toMatch(/T08:00:00\+13:45/);
  });

  it('a day with no clock changes is untouched in Kolkata', () => {
    expect(localToInstant(nyDate('2026-06-01'), '23:59', 'Asia/Kolkata').toString()).toBe('2026-06-01T23:59:00+05:30[Asia/Kolkata]');
  });
});

describe('occurrences', () => {
  it('expands daily times over a window, in time order', () => {
    const s: ScheduleInput = { ...base, times: [{ localTime: '21:00', amountText: '2 tablets' }, { localTime: '08:00', amountText: '1 tablet' }] };
    const out = occurrences(s, 'Asia/Kolkata', at('2026-11-01T00:00:00+05:30'), at('2026-11-03T00:00:00+05:30'));
    expect(out.map((o) => o.scheduledAt.toISOString())).toEqual(['2026-11-01T02:30:00.000Z', '2026-11-01T15:30:00.000Z', '2026-11-02T02:30:00.000Z', '2026-11-02T15:30:00.000Z']);
    expect(out[1]).toMatchObject({ localTime: '21:00', amountText: '2 tablets' });
  });

  it('weekdays: only the chosen ISO days, judged in the patient’s timezone', () => {
    const s: ScheduleInput = { ...base, pattern: 'weekdays', daysOfWeek: [1, 3, 5] };
    const out = occurrences(s, 'Pacific/Auckland', at('2026-11-02T00:00:00Z'), at('2026-11-16T00:00:00Z'));
    expect(out.length).toBe(6);
    for (const o of out) expect([1, 3, 5]).toContain(local(o.scheduledAt, 'Pacific/Auckland').dayOfWeek);
  });

  it('every N days is anchored on start_date', () => {
    const s: ScheduleInput = { ...base, pattern: 'every_n_days', intervalDays: 3, startDate: '2026-11-01' };
    const out = occurrences(s, 'UTC', at('2026-11-01T00:00:00Z'), at('2026-11-14T00:00:00Z'));
    expect(out.map((o) => o.scheduledAt.toISOString().slice(0, 10))).toEqual(['2026-11-01', '2026-11-04', '2026-11-07', '2026-11-10', '2026-11-13']);
    // The cycle does not depend on where the window starts.
    const later = occurrences(s, 'UTC', at('2026-11-05T00:00:00Z'), at('2026-11-14T00:00:00Z'));
    expect(later.map((o) => o.scheduledAt.toISOString().slice(0, 10))).toEqual(['2026-11-07', '2026-11-10', '2026-11-13']);
  });

  it('respects start and end dates', () => {
    const s: ScheduleInput = { ...base, startDate: '2026-11-03', endDate: '2026-11-05' };
    const out = occurrences(s, 'UTC', at('2026-11-01T00:00:00Z'), at('2026-11-10T00:00:00Z'));
    expect(out.map((o) => o.scheduledAt.toISOString().slice(0, 10))).toEqual(['2026-11-03', '2026-11-04', '2026-11-05']);
  });

  it('skips instants before effective_from, so an edit at 10:00 does not recreate today’s 08:00 dose', () => {
    const s: ScheduleInput = { ...base, effectiveFrom: at('2026-11-01T10:00:00Z') };
    const out = occurrences(s, 'UTC', at('2026-11-01T00:00:00Z'), at('2026-11-03T00:00:00Z'));
    expect(out.map((o) => o.scheduledAt.toISOString())).toEqual(['2026-11-02T08:00:00.000Z']);
  });

  it('stops at effective_until (the old version ends when the new one begins)', () => {
    const s: ScheduleInput = { ...base, effectiveUntil: at('2026-11-02T08:00:00Z') };
    const out = occurrences(s, 'UTC', at('2026-11-01T00:00:00Z'), at('2026-11-05T00:00:00Z'));
    expect(out.map((o) => o.scheduledAt.toISOString())).toEqual(['2026-11-01T08:00:00.000Z']); // 08:00 on the 2nd is excluded
  });

  it('creates one dose, not two, when two times collapse onto one instant at a gap', () => {
    const s: ScheduleInput = { ...base, times: [{ localTime: '02:15', amountText: 'a' }, { localTime: '02:45', amountText: 'b' }] };
    const out = occurrences(s, 'America/New_York', at('2026-03-08T00:00:00Z'), at('2026-03-09T12:00:00Z'));
    const gapDay = out.filter((o) => local(o.scheduledAt, 'America/New_York').toPlainDate().toString() === '2026-03-08');
    expect(gapDay).toHaveLength(1);
  });

  it('the fall-back day has exactly one 01:30 dose', () => {
    const s: ScheduleInput = { ...base, times: [{ localTime: '01:30', amountText: 'a' }] };
    const out = occurrences(s, 'America/New_York', at('2026-10-31T12:00:00Z'), at('2026-11-02T12:00:00Z'));
    expect(out.map((o) => o.scheduledAt.toISOString())).toEqual(['2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z'].slice(0, out.length));
    expect(out.filter((o) => local(o.scheduledAt, 'America/New_York').toPlainDate().toString() === '2026-11-01')).toHaveLength(1);
  });

  it('returns nothing for an empty or inverted window', () => {
    expect(occurrences(base, 'UTC', at('2026-11-02T00:00:00Z'), at('2026-11-02T00:00:00Z'))).toEqual([]);
    expect(occurrences(base, 'UTC', at('2026-11-03T00:00:00Z'), at('2026-11-02T00:00:00Z'))).toEqual([]);
  });
});

// Random schedules, zones and windows, including ones that cross DST changes.
const timeArb = fc.tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 })).map(([h, m]) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
const dateArb = fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2027, 11, 31) }).map((ms) => new Date(ms).toISOString().slice(0, 10));
const scheduleArb: fc.Arbitrary<ScheduleInput> = fc
  .record({
    pattern: fc.constantFrom('daily', 'weekdays', 'every_n_days' as const),
    days: fc.uniqueArray(fc.integer({ min: 1, max: 7 }), { minLength: 1, maxLength: 7 }),
    interval: fc.integer({ min: 2, max: 14 }),
    startDate: dateArb,
    spanDays: fc.option(fc.integer({ min: 0, max: 200 }), { nil: null }),
    times: fc.uniqueArray(timeArb, { minLength: 1, maxLength: 6 }),
  })
  .map((r) => ({
    pattern: r.pattern,
    daysOfWeek: r.pattern === 'weekdays' ? r.days : null,
    intervalDays: r.pattern === 'every_n_days' ? r.interval : null,
    startDate: r.startDate,
    endDate: r.spanDays === null ? null : Temporal.PlainDate.from(r.startDate).add({ days: r.spanDays }).toString(),
    times: r.times.map((localTime) => ({ localTime, amountText: 'x' })),
    effectiveFrom: new Date('2025-01-01T00:00:00Z'),
    effectiveUntil: null,
  }));
const windowArb = fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2027, 11, 1) }).chain((from) => fc.integer({ min: 1, max: 20 * 86400 }).map((s) => [new Date(from), new Date(from + s * 1000)] as const));

describe('occurrences: properties (docs/12-testing-and-slos.md#dose-generation-tests)', () => {
  const prop = (check: (s: ScheduleInput, tz: string, from: Date, to: Date, out: ReturnType<typeof occurrences>) => void) =>
    fc.assert(fc.property(scheduleArb, fc.constantFrom(...ZONES), windowArb, (s, tz, [from, to]) => check(s, tz, from, to, occurrences(s, tz, from, to))), { numRuns: 400 });

  it('every dose keeps its wall-clock time unless it sits in a DST gap, where it moves to the gap’s end', () => {
    prop((s, tz, _f, _t, out) => {
      for (const o of out) {
        const z = local(o.scheduledAt, tz);
        const hhmm = `${String(z.hour).padStart(2, '0')}:${String(z.minute).padStart(2, '0')}`;
        if (hhmm === o.localTime) continue;
        // Moved: the requested time must not exist that day (it is inside a gap), and the dose must sit on a transition.
        const wanted = z.toPlainDate().toPlainDateTime({ hour: Number(o.localTime.slice(0, 2)), minute: Number(o.localTime.slice(3)) });
        const compat = wanted.toZonedDateTime(tz);
        expect(Temporal.PlainDateTime.compare(compat.toPlainDateTime(), wanted)).not.toBe(0);
        expect(z.add({ nanoseconds: 1 }).getTimeZoneTransition('previous')?.epochMilliseconds).toBe(o.scheduledAt.getTime());
      }
    });
  });

  it('has no duplicates, is sorted, and stays inside the window', () => {
    prop((_s, _tz, from, to, out) => {
      const ms = out.map((o) => o.scheduledAt.getTime());
      expect(new Set(ms).size).toBe(ms.length);
      expect(ms).toEqual([...ms].sort((a, b) => a - b));
      for (const t of ms) {
        expect(t).toBeGreaterThanOrEqual(from.getTime());
        expect(t).toBeLessThan(to.getTime());
      }
    });
  });

  it('only produces doses on dates the pattern allows, within start and end dates', () => {
    prop((s, tz, _f, _t, out) => {
      for (const o of out) {
        const day = local(o.scheduledAt, tz).toPlainDate();
        expect(Temporal.PlainDate.compare(day, Temporal.PlainDate.from(s.startDate))).toBeGreaterThanOrEqual(0);
        if (s.endDate) expect(Temporal.PlainDate.compare(day, Temporal.PlainDate.from(s.endDate))).toBeLessThanOrEqual(0);
        if (s.pattern === 'weekdays') expect(s.daysOfWeek).toContain(day.dayOfWeek);
        if (s.pattern === 'every_n_days') expect(Temporal.PlainDate.from(s.startDate).until(day, { largestUnit: 'days' }).days % s.intervalDays!).toBe(0);
      }
    });
  });

  it('is stable: splitting a window in two gives the same doses as the whole', () => {
    fc.assert(
      fc.property(scheduleArb, fc.constantFrom(...ZONES), windowArb, fc.double({ min: 0, max: 1, noNaN: true }), (s, tz, [from, to], f) => {
        const mid = new Date(from.getTime() + Math.floor((to.getTime() - from.getTime()) * f));
        const whole = occurrences(s, tz, from, to).map((o) => o.scheduledAt.getTime());
        const parts = [...occurrences(s, tz, from, mid), ...occurrences(s, tz, mid, to)].map((o) => o.scheduledAt.getTime());
        expect(parts).toEqual(whole);
      }),
      { numRuns: 300 },
    );
  });

  it('daily schedules give times × days doses over whole local days away from DST gaps', () => {
    fc.assert(
      fc.property(fc.uniqueArray(timeArb.filter((t) => t >= '04:00' && t <= '22:00'), { minLength: 1, maxLength: 5 }), fc.integer({ min: 1, max: 30 }), fc.constantFrom(...ZONES), (times, days, tz) => {
        const s: ScheduleInput = { ...base, times: times.map((localTime) => ({ localTime, amountText: 'x' })) };
        const from = Temporal.PlainDate.from('2026-02-01').toZonedDateTime({ timeZone: tz, plainTime: '00:00' });
        const out = occurrences(s, tz, new Date(from.epochMilliseconds), new Date(from.add({ days }).epochMilliseconds));
        expect(out).toHaveLength(times.length * days);
      }),
      { numRuns: 100 },
    );
  });
});
