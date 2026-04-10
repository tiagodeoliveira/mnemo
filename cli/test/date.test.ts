import { describe, it, expect } from 'vitest';
import { localDate } from '../src/date';

describe('localDate', () => {
  it('formats as YYYY-MM-DD zero-padded', () => {
    expect(localDate(new Date(2026, 0, 5, 10, 0, 0))).toBe('2026-01-05');
    expect(localDate(new Date(2026, 11, 31, 23, 59, 59))).toBe('2026-12-31');
  });

  it('reflects local timezone, not UTC, near midnight', () => {
    // 23:30 local on April 15 is always April 15 locally, regardless of where
    // UTC falls. toISOString().slice(0, 10) would return the next day in any
    // positive UTC offset — this test guards against that regression.
    const localEvening = new Date(2026, 3, 15, 23, 30, 0);
    expect(localDate(localEvening)).toBe('2026-04-15');
  });
});
