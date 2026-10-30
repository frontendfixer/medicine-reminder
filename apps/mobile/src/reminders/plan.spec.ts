import type { DoseStatus, NotificationType } from '@med/shared';
import { ANDROID_GUARD, CATEGORY, CATEGORY_NO_SNOOZE, diffPlan, doseIdOf, FOLLOW_UP_MS, IOS_BUDGET, planNotifications, wantedForDose, type PlanInput } from './plan';
import type { LocalDose } from './store';

const MIN = 60_000;
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-01T00:00:00Z');
let seq = 0;
const dose = (over: Partial<LocalDose> & { at?: number; delay?: number } = {}): LocalDose => {
  const scheduledAt = over.at ?? NOW + 60 * MIN;
  return { id: over.id ?? `d${++seq}`, medicineId: 'm', scheduledAt, alertDueAt: scheduledAt + (over.delay ?? 30) * MIN, localTime: '08:00', name: 'Metformin', amount: '1 tablet', type: 'standard', status: 'pending', snoozeUntil: null, ...over };
};
const plan = (doses: LocalDose[], over: Partial<PlanInput> = {}) => planNotifications({ doses, now: NOW, platform: 'android', lockscreen: 'full', windowThrough: NOW + 5 * DAY, ...over });

describe('what one dose wants', () => {
  it('a Standard dose: one notification at its time, keyed by the dose ID', () => {
    const d = dose();
    const [n, ...rest] = wantedForDose(d, NOW, 'full');
    expect(rest).toEqual([]);
    expect(n).toMatchObject({ identifier: `dose:${d.id}`, doseId: d.id, kind: 'dose', fireAt: d.scheduledAt, channelId: 'dose_standard_v1', categoryId: CATEGORY, delivery: 'bestEffort', sound: 'default', interruptionLevel: 'timeSensitive' });
    expect(n!.title).toBe('Metformin — 1 tablet');
    expect(n!.body).toBe('Due 08:00');
  });

  it('shows generic text when the caregiver chose it (D-028)', () => {
    const [n] = wantedForDose(dose(), NOW, 'generic');
    expect(n!.title).toBe('Medicine reminder');
    expect(n!.body).toBe('Due 08:00 — tap to see');
    expect(JSON.stringify(n)).not.toContain('Metformin');
  });

  it('an Alarm dose with a 30-minute delay is 6 notifications: the dose and follow-ups every 5 minutes (docs/05)', () => {
    const d = dose({ type: 'alarm' });
    const w = wantedForDose(d, NOW, 'full');
    expect(w.map((n) => (n.fireAt - d.scheduledAt) / MIN)).toEqual([0, 5, 10, 15, 20, 25]);
    expect(w.map((n) => n.identifier)).toEqual([`dose:${d.id}`, ...[1, 2, 3, 4, 5].map((k) => `dose:${d.id}:f${k}`)]);
    expect(w.every((n) => n.delivery === 'alarmClock' && n.channelId === 'dose_alarm_v1' && n.sound === 'dose_alarm.wav')).toBe(true);
    expect(w[1]!.title).toBe('Reminder: Metformin — 1 tablet');
  });

  it('the follow-ups stop before the deadline, and a short delay has none', () => {
    expect(wantedForDose(dose({ type: 'alarm', delay: 5 }), NOW, 'full')).toHaveLength(1);
    expect(wantedForDose(dose({ type: 'alarm', delay: 12 }), NOW, 'full')).toHaveLength(3); // 0, 5, 10
    expect(wantedForDose(dose({ type: 'alarm', delay: 10 }), NOW, 'full')).toHaveLength(2); // 0, 5 (10 is the deadline)
  });

  it('Snooze is left out of the actions once 10 minutes would pass the deadline (D-085)', () => {
    const w = wantedForDose(dose({ type: 'alarm' }), NOW, 'full');
    expect(w.map((n) => n.categoryId === CATEGORY_NO_SNOOZE)).toEqual([false, false, false, false, true, true]); // 0,5,10,15 ok; 20,25 too late
  });

  it('Gentle is quiet and not time-sensitive (D-094)', () => {
    expect(wantedForDose(dose({ type: 'gentle' }), NOW, 'full')[0]).toMatchObject({ channelId: 'dose_gentle_v1', sound: null, interruptionLevel: 'active' });
  });

  it('a snoozed dose rings again when the snooze ends, and Alarm follow-ups resume from there', () => {
    const d = dose({ type: 'alarm', at: NOW - 5 * MIN, status: 'snoozed', snoozeUntil: NOW + 10 * MIN, delay: 30 });
    const w = wantedForDose(d, NOW, 'full');
    expect(w.map((n) => [n.identifier, (n.fireAt - NOW) / MIN])).toEqual([[`dose:${d.id}:s`, 10], [`dose:${d.id}:sf1`, 15], [`dose:${d.id}:sf2`, 20]]); // deadline is 25 min from now
    expect(w[0]!.kind).toBe('snooze');
  });

  it('a dose already past its time only wants what is still ahead', () => {
    const d = dose({ type: 'alarm', at: NOW - 12 * MIN });
    expect(wantedForDose(d, NOW, 'full').map((n) => (n.fireAt - d.scheduledAt) / MIN)).toEqual([15, 20, 25]);
    expect(wantedForDose(dose({ at: NOW - 12 * MIN }), NOW, 'full')).toEqual([]);
  });

  it.each<DoseStatus>(['taken', 'not_taken', 'missed'])('%s wants nothing, whatever the time', (status) => {
    expect(wantedForDose(dose({ status, type: 'alarm' }), NOW, 'full')).toEqual([]);
  });

  it('a snooze that has already ended wants only the follow-ups still ahead', () => {
    const d = dose({ type: 'standard', at: NOW - 30 * MIN, status: 'snoozed', snoozeUntil: NOW - MIN, delay: 40 });
    expect(wantedForDose(d, NOW, 'full')).toEqual([]);
  });
});

describe('the whole plan', () => {
  it('lists everything in time order, with scheduled_through at the window end when all of it fits', () => {
    const doses = [dose({ at: NOW + 3 * 3600_000 }), dose({ at: NOW + 3600_000 })];
    const p = plan(doses);
    expect(p.planned.map((n) => n.doseId)).toEqual([doses[1]!.id, doses[0]!.id]);
    expect(p.dropped).toBe(0);
    expect(p.scheduledThrough).toBe(NOW + 5 * DAY);
  });

  it('with nothing to do, scheduled_through is the window end', () => {
    expect(plan([])).toEqual({ planned: [], scheduledThrough: NOW + 5 * DAY, dropped: 0 });
  });

  it('answered doses are never rescheduled, even if the server still says pending', () => {
    expect(plan([dose({ status: 'taken' }), dose({ status: 'missed' })]).planned).toEqual([]);
  });

  describe('iOS keeps to 60 pending notifications (D-038, D-078)', () => {
    const perDay = (n: number, type: NotificationType, days: number) =>
      Array.from({ length: n * days }, (_, i) => dose({ type, at: NOW + Math.floor(i / n) * DAY + (i % n) * 2 * 3600_000 + 3600_000 }));

    it('2 Alarm doses a day for 5 days (12 slots a day) fits exactly', () => {
      const p = plan(perDay(2, 'alarm', 5), { platform: 'ios' });
      expect(p.planned).toHaveLength(60);
      expect(p.dropped).toBe(0);
    });

    it('6 Alarm doses a day does not fit: follow-ups only for 24 hours, plain notifications beyond', () => {
      const p = plan(perDay(6, 'alarm', 3), { platform: 'ios' });
      expect(p.planned.length).toBeLessThanOrEqual(IOS_BUDGET);
      expect(p.planned.filter((n) => n.kind === 'followUp').every((n) => n.fireAt <= NOW + DAY)).toBe(true);
      expect(p.planned.some((n) => n.kind === 'dose' && n.fireAt > NOW + DAY)).toBe(true); // later doses still ring
      expect(p.dropped).toBeGreaterThan(0);
    });

    it('reports scheduled_through honestly: not past the first dose that lost a notification', () => {
      const doses = perDay(6, 'alarm', 3);
      const p = plan(doses, { platform: 'ios' });
      expect(p.scheduledThrough).not.toBeNull();
      expect(p.scheduledThrough!).toBeLessThanOrEqual(NOW + DAY + 6 * 3600_000);
      const through = p.scheduledThrough!;
      const ids = new Set(p.planned.map((n) => n.identifier));
      for (const d of doses.filter((x) => x.scheduledAt <= through)) for (const w of wantedForDose(d, NOW, 'full')) expect(ids.has(w.identifier)).toBe(true);
    });

    it('with far too many doses it keeps the earliest and says so', () => {
      const doses = Array.from({ length: 120 }, (_, i) => dose({ at: NOW + (i + 1) * 10 * MIN })); // one every 10 minutes
      const p = plan(doses, { platform: 'ios' });
      expect(p.planned).toHaveLength(IOS_BUDGET);
      expect(p.planned[0]!.doseId).toBe(doses[0]!.id);
      expect(p.dropped).toBe(120 - IOS_BUDGET);
      expect(p.scheduledThrough).toBe(doses[IOS_BUDGET - 1]!.scheduledAt); // exactly as far as it really holds
    });

    it('two doses at the same minute are both covered or neither is claimed', () => {
      const same = Array.from({ length: IOS_BUDGET + 1 }, () => dose({ at: NOW + 3600_000 }));
      const p = plan(same, { platform: 'ios' });
      expect(p.planned).toHaveLength(IOS_BUDGET);
      expect(p.scheduledThrough).toBeNull(); // the last one did not fit, and shares the minute with all the others
    });

  });

  it('Android has no 64 limit, only a safety guard far above any real window', () => {
    const many = Array.from({ length: 200 }, (_, i) => dose({ type: 'alarm', at: NOW + (i + 1) * 3600_000 })); // 1,200 slots
    const p = plan(many, { platform: 'android' });
    expect(p.planned).toHaveLength(ANDROID_GUARD);
    expect(p.scheduledThrough!).toBeLessThan(NOW + 5 * DAY);
    expect(plan(Array.from({ length: 30 }, (_, i) => dose({ type: 'alarm', at: NOW + (i + 1) * 3600_000 })), { platform: 'android' }).planned).toHaveLength(180);
  });

  it('holds for any mix of doses: unique IDs, nothing in the past, within budget, time-sorted, honest through', () => {
    let seed = 12345;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    for (let run = 0; run < 300; run++) {
      const doses = Array.from({ length: rnd(40) }, () =>
        dose({
          type: (['standard', 'alarm', 'gentle'] as const)[rnd(3)],
          at: NOW + (rnd(7 * 24 * 60) - 120) * MIN,
          delay: 5 + rnd(120),
          status: (['pending', 'pending', 'pending', 'snoozed', 'taken', 'missed'] as const)[rnd(6)],
          snoozeUntil: NOW + rnd(300) * MIN,
        }),
      );
      for (const platform of ['ios', 'android'] as const) {
        const p = plan(doses, { platform, windowThrough: NOW + 5 * DAY });
        const ids = p.planned.map((n) => n.identifier);
        expect(new Set(ids).size).toBe(ids.length);
        expect(p.planned.every((n) => n.fireAt > NOW)).toBe(true);
        expect(p.planned.map((n) => n.fireAt)).toEqual([...p.planned.map((n) => n.fireAt)].sort((a, b) => a - b));
        expect(p.planned.length).toBeLessThanOrEqual(platform === 'ios' ? IOS_BUDGET : ANDROID_GUARD);
        if (p.scheduledThrough !== null) {
          const kept = new Set(ids);
          for (const d of doses.filter((x) => x.scheduledAt <= p.scheduledThrough!)) for (const w of wantedForDose(d, NOW, 'full')) expect(kept.has(w.identifier)).toBe(true);
        }
        for (const n of p.planned) expect(doses.find((d) => d.id === n.doseId)!.status).toMatch(/pending|snoozed/);
      }
    }
  });
});

describe('reconciling with what is already scheduled', () => {
  const [a, b] = [dose(), dose({ at: NOW + 2 * 3600_000 })].map((d) => wantedForDose(d, NOW, 'full')[0]!);

  it('schedules everything on a clean phone', () => {
    expect(diffPlan([a!, b!], [])).toEqual({ cancel: [], schedule: [a, b] });
  });
  it('leaves an unchanged notification alone, so a re-sync does not churn the scheduler', () => {
    expect(diffPlan([a!, b!], [{ identifier: a!.identifier, hash: a!.hash }, { identifier: b!.identifier, hash: b!.hash }])).toEqual({ cancel: [], schedule: [] });
  });
  it('replaces one whose time or wording changed, under the same ID', () => {
    const moved = { ...a!, fireAt: a!.fireAt + MIN, hash: 'changed' };
    expect(diffPlan([moved], [{ identifier: a!.identifier, hash: a!.hash }])).toEqual({ cancel: [], schedule: [moved] });
  });
  it('cancels ours that are no longer wanted, and never touches anything else', () => {
    const out = diffPlan([a!], [{ identifier: a!.identifier, hash: a!.hash }, { identifier: `dose:${b!.doseId}`, hash: 'x' }, { identifier: 'something-else', hash: null }]);
    expect(out).toEqual({ cancel: [`dose:${b!.doseId}`], schedule: [] });
  });
  it('reschedules one with no fingerprint (made by an older version)', () => {
    expect(diffPlan([a!], [{ identifier: a!.identifier, hash: null }]).schedule).toEqual([a]);
  });
  it('reads the dose ID from any of our identifiers', () => {
    expect(doseIdOf('dose:abc')).toBe('abc');
    expect(doseIdOf('dose:abc:f3')).toBe('abc');
    expect(doseIdOf('dose:abc:sf2')).toBe('abc');
    expect(doseIdOf('other:abc')).toBeNull();
    expect(FOLLOW_UP_MS).toBe(5 * MIN);
  });
});
