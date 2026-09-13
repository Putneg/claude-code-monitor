import { describe, expect, it } from 'vitest';
import { createHourLabels, createLocalDay, createZonedDayStart, isValidTimeZone } from '../../src/server/time.js';

const HOUR = 3_600_000;

describe('isValidTimeZone', () => {
  it('accepts IANA zones and rejects unknown ones', () => {
    expect(isValidTimeZone('Europe/Kyiv')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
  });
});

describe('createLocalDay', () => {
  it('maps a UTC instant to the local calendar day', () => {
    const kyivDay = createLocalDay('Europe/Kyiv');
    expect(kyivDay(Date.parse('2026-09-10T21:30:00Z'))).toBe('2026-09-11'); // UTC+3 in summer
    expect(kyivDay(Date.parse('2026-01-10T21:30:00Z'))).toBe('2026-01-10'); // UTC+2 in winter
    expect(kyivDay(Date.parse('2026-01-10T22:30:00Z'))).toBe('2026-01-11');
  });

  it('supports UTC', () => {
    expect(createLocalDay('UTC')(Date.parse('2026-09-10T23:59:59Z'))).toBe('2026-09-10');
  });
});

describe('createHourLabels', () => {
  it('labels the start of each local hour', () => {
    const labels = createHourLabels('Europe/Berlin');
    expect(labels(Date.parse('2026-09-11T12:00:00Z'), 2)).toEqual(['2026-09-11T14:00', '2026-09-11T15:00']);
    expect(labels(Date.parse('2026-09-10T22:00:00Z'), 1)).toEqual(['2026-09-11T00:00']);
  });

  it('adds the UTC offset to both repeated hours of the fall-back day', () => {
    // Kyiv leaves summer time at 01:00Z on 2026-10-25: local 03:00 happens at +03:00 and again at +02:00.
    const labels = createHourLabels('Europe/Kyiv')(createZonedDayStart('Europe/Kyiv')('2026-10-25'), 25);
    expect(labels).toHaveLength(25);
    expect(labels.slice(2, 6)).toEqual(['2026-10-25T02:00', '2026-10-25T03:00+03:00', '2026-10-25T03:00+02:00', '2026-10-25T04:00']);
    expect(labels.filter((label) => label.length > 16)).toHaveLength(2);
    expect(labels.at(-1)).toBe('2026-10-25T23:00');
  });

  it('adds no offset on the spring-forward day or in UTC', () => {
    const spring = createHourLabels('Europe/Kyiv')(createZonedDayStart('Europe/Kyiv')('2026-03-29'), 23);
    expect(spring.slice(2, 4)).toEqual(['2026-03-29T02:00', '2026-03-29T04:00']);
    expect(spring.every((label) => label.length === 16)).toBe(true);
    const utc = createHourLabels('UTC')(Date.parse('2026-10-25T00:00:00Z'), 24);
    expect(utc.every((label) => label.length === 16)).toBe(true);
    expect(utc.at(-1)).toBe('2026-10-25T23:00');
  });

  it('prints offsets west of UTC with a minus sign', () => {
    const labels = createHourLabels('America/New_York')(createZonedDayStart('America/New_York')('2026-11-01'), 25);
    expect(labels.filter((label) => label.length > 16)).toEqual(['2026-11-01T01:00-04:00', '2026-11-01T01:00-05:00']);
  });

  it('prints the minutes of a half-hour offset', () => {
    // Lord Howe Island turns its clocks back 30 minutes at 15:00Z on 2026-04-04: local 01:30-02:00 happens at +11:00, then at +10:30.
    const labels = createHourLabels('Australia/Lord_Howe')(createZonedDayStart('Australia/Lord_Howe')('2026-04-05'), 25);
    expect(labels.filter((label) => label.length > 16)).toEqual(['2026-04-05T01:00+11:00', '2026-04-05T01:00+10:30']);
  });
});

describe('createZonedDayStart', () => {
  const dayStart = createZonedDayStart('Europe/Berlin');

  it('returns the UTC instant of local midnight', () => {
    expect(dayStart('2026-09-11')).toBe(Date.parse('2026-09-10T22:00:00Z'));
    expect(dayStart('2026-01-15')).toBe(Date.parse('2026-01-14T23:00:00Z'));
  });

  it('handles the spring-forward day (23 hours)', () => {
    expect(dayStart('2026-03-29')).toBe(Date.parse('2026-03-28T23:00:00Z'));
    expect((dayStart('2026-03-30') - dayStart('2026-03-29')) / HOUR).toBe(23);
  });

  it('handles the fall-back day (25 hours)', () => {
    expect((dayStart('2026-10-26') - dayStart('2026-10-25')) / HOUR).toBe(25);
  });

  it('rejects an invalid day', () => {
    expect(() => createZonedDayStart('UTC')('2026-02-30')).toThrow(RangeError);
  });
});
