import { slotsPerDose, windowDays } from './window.js';

describe('window size (docs/05 examples)', () => {
  it('counts follow-ups for Alarm doses only', () => {
    expect(slotsPerDose('standard', 30)).toBe(1);
    expect(slotsPerDose('gentle', 30)).toBe(1);
    expect(slotsPerDose('alarm', 30)).toBe(6); // dose + follow-ups at +5, +10, +15, +20, +25
    expect(slotsPerDose('alarm', 5)).toBe(1);
    expect(slotsPerDose('alarm', 1)).toBe(1);
  });

  it.each([
    ['3 Standard doses', 3, 14], // 60 / 3 = 20, capped at the 14-day horizon
    ['2 Alarm doses, 30 min delay', 12, 5],
    ['4 Alarm doses, 30 min delay', 24, 2], // 60 / 24 = 2.5
    ['6 Alarm doses, 30 min delay', 36, 2], // does not fit: the phone trims follow-ups beyond 24 h
    ['nothing scheduled', 0, 14],
  ])('iOS: %s', (_l, slots, days) => {
    expect(windowDays('ios', slots)).toBe(days);
  });

  it('Android always gets 5 days', () => {
    for (const slots of [0, 3, 12, 40]) expect(windowDays('android', slots)).toBe(5);
  });
});
