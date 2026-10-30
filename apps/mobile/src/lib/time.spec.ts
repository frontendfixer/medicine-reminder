import { formatRemaining, localTime } from './time';

describe('time helpers', () => {
  it('formats a countdown as m:ss and never goes negative', () => {
    expect(formatRemaining(10 * 60_000)).toBe('10:00');
    expect(formatRemaining(61_001)).toBe('1:02');
    expect(formatRemaining(9_000)).toBe('0:09');
    expect(formatRemaining(-5_000)).toBe('0:00');
  });
  it('shows a time in the patient’s zone', () => {
    expect(localTime('2026-11-01T02:30:00Z', 'Asia/Kolkata')).toBe('08:00');
    expect(localTime('2026-11-01T02:30:00Z', 'UTC')).toBe('02:30');
  });
});
