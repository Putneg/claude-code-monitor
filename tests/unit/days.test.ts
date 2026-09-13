import { describe, expect, it } from 'vitest';
import * as time from '../../src/server/time.js';
import { addDays, dayToUtcMs, daysInclusive, enumerateDays, formatDay, isValidDay, parseDay } from '../../src/shared/days.js';

describe('shared day arithmetic', () => {
  it('parses, validates and formats calendar days', () => {
    expect(parseDay('2026-02-28')).toEqual({ year: 2026, month: 2, day: 28 });
    expect(parseDay('2026-02-30')).toBeNull();
    expect(isValidDay('2026-02-28')).toBe(true);
    expect(isValidDay('2026-02-30')).toBe(false);
    expect(isValidDay('2026-13-01')).toBe(false);
    expect(isValidDay('2026-9-1')).toBe(false);
    expect(formatDay({ year: 2026, month: 3, day: 7 })).toBe('2026-03-07');
    expect(dayToUtcMs({ year: 2026, month: 3, day: 7 })).toBe(Date.parse('2026-03-07T00:00:00Z'));
  });

  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-02-27', 3)).toBe('2026-03-02');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('counts days inclusively and enumerates them', () => {
    expect(daysInclusive('2026-02-27', '2026-03-02')).toBe(4);
    expect(daysInclusive('2026-09-01', '2026-09-30')).toBe(30);
    expect(daysInclusive('2026-09-11', '2026-09-11')).toBe(1);
    expect(enumerateDays('2026-09-29', '2026-10-02')).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
    expect(enumerateDays('2026-09-02', '2026-09-01')).toEqual([]);
  });

  it('rejects invalid input', () => {
    expect(() => addDays('not-a-day', 1)).toThrow(RangeError);
  });

  it('is re-exported unchanged by the server time module', () => {
    expect(time.addDays).toBe(addDays);
    expect(time.daysInclusive).toBe(daysInclusive);
    expect(time.enumerateDays).toBe(enumerateDays);
    expect(time.isValidDay).toBe(isValidDay);
    expect(time.parseDay).toBe(parseDay);
  });
});
