import { describe, expect, it } from 'vitest';
import {
  brushRange,
  dayBucketAllowed,
  hourBucketAllowed,
  presetRange,
  rangeDays,
  rangeLabel,
  requestBucket,
  resolveRange,
} from '../../../src/web/lib/range.js';
import { DEFAULT_VIEW } from '../../../src/web/lib/view-state.js';
import { MAX_RANGE_DAYS } from '../../../src/shared/limits.js';

describe('presetRange', () => {
  it('ends every preset today', () => {
    expect(presetRange('today', '2026-09-11', '2026-08-01')).toEqual({ from: '2026-09-11', to: '2026-09-11' });
    expect(presetRange('7d', '2026-09-11', null)).toEqual({ from: '2026-09-05', to: '2026-09-11' });
    expect(presetRange('30d', '2026-03-01', null)).toEqual({ from: '2026-01-31', to: '2026-03-01' });
    expect(presetRange('90d', '2026-09-11', null)).toEqual({ from: '2026-06-14', to: '2026-09-11' });
  });

  it('starts "all" at the first day with data, or today when there is none', () => {
    expect(presetRange('all', '2026-09-11', '2026-08-01')).toEqual({ from: '2026-08-01', to: '2026-09-11' });
    expect(presetRange('all', '2026-09-11', null)).toEqual({ from: '2026-09-11', to: '2026-09-11' });
  });

  it('caps "all" at the longest range the API accepts', () => {
    const all = presetRange('all', '2026-09-11', '2000-01-01');
    expect(all).toEqual({ from: '2016-09-04', to: '2026-09-11' });
    expect(rangeDays(all)).toBe(MAX_RANGE_DAYS);
  });

  it('ignores a first day that is not a valid day', () => {
    expect(presetRange('all', '2026-09-11', '2-06-01')).toEqual({ from: '2026-09-11', to: '2026-09-11' });
    expect(presetRange('all', '2026-09-11', '2026-02-30')).toEqual({ from: '2026-09-11', to: '2026-09-11' });
  });
});

describe('resolveRange', () => {
  it('prefers a custom range over presets', () => {
    const custom = { ...DEFAULT_VIEW, range: null, from: '2026-03-01', to: '2026-03-14' };
    expect(resolveRange(custom, '2026-09-11', null)).toEqual({ from: '2026-03-01', to: '2026-03-14' });
    expect(resolveRange(DEFAULT_VIEW, '2026-09-11', null)).toEqual({ from: '2026-08-13', to: '2026-09-11' });
  });
});

describe('buckets', () => {
  const week = { from: '2026-09-05', to: '2026-09-11' };
  const eightDays = { from: '2026-09-04', to: '2026-09-11' };

  it('allows hour buckets for ranges up to seven days', () => {
    expect(rangeDays(week)).toBe(7);
    expect(hourBucketAllowed(week)).toBe(true);
    expect(hourBucketAllowed(eightDays)).toBe(false);
  });

  it('drops an hour choice the API would reject', () => {
    expect(requestBucket('hour', week)).toBe('hour');
    expect(requestBucket('hour', eightDays)).toBeNull();
    expect(requestBucket('day', eightDays)).toBe('day');
    expect(requestBucket(null, week)).toBeNull();
  });

  const oneDay = { from: '2026-09-11', to: '2026-09-11' };
  const twoDays = { from: '2026-09-10', to: '2026-09-11' };

  it('allows day buckets only for ranges of two days or more', () => {
    expect(dayBucketAllowed(oneDay)).toBe(false);
    expect(dayBucketAllowed(twoDays)).toBe(true);
  });

  it('drops a day choice on a single day, where one point per series draws no line', () => {
    expect(requestBucket('day', oneDay)).toBeNull();
    expect(requestBucket('day', twoDays)).toBe('day');
  });
});

describe('rangeLabel', () => {
  it('names presets and prints custom dates', () => {
    expect(rangeLabel(DEFAULT_VIEW, { from: '2026-08-13', to: '2026-09-11' })).toBe('30d');
    expect(rangeLabel({ ...DEFAULT_VIEW, range: null }, { from: '2026-03-01', to: '2026-03-14' })).toBe('03-01 → 03-14');
  });
});

describe('brushRange', () => {
  const days = ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04'];

  it('maps brushed indices to whole days in order', () => {
    expect(brushRange(days, 2.4, 0.6)).toEqual({ from: '2026-03-02', to: '2026-03-03' });
  });

  it('clamps indices outside the axis', () => {
    expect(brushRange(days, -3, 10)).toEqual({ from: '2026-03-01', to: '2026-03-04' });
  });

  it('uses the date part of hour buckets', () => {
    expect(brushRange(['2026-03-01T22:00', '2026-03-01T23:00', '2026-03-02T00:00'], 0, 2)).toEqual({
      from: '2026-03-01',
      to: '2026-03-02',
    });
  });

  it('uses the date part of hour buckets that carry a UTC offset', () => {
    expect(brushRange(['2026-10-25T02:00', '2026-10-25T03:00+03:00', '2026-10-25T03:00+02:00'], 1, 2)).toEqual({
      from: '2026-10-25',
      to: '2026-10-25',
    });
  });

  it('returns null without buckets', () => {
    expect(brushRange([], 0, 1)).toBeNull();
  });
});
