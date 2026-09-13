import { describe, expect, it } from 'vitest';
import { bucketTotals, cumulativeOf, peakOf, unitValues } from '../../../src/web/lib/series.js';
import { SERIES } from './fixtures.js';

describe('series helpers', () => {
  it('picks the matrix for the unit', () => {
    expect(unitValues(SERIES, 'usd')).toBe(SERIES.cost);
    expect(unitValues(SERIES, 'tok')).toBe(SERIES.tokens);
  });

  it('sums each bucket across keys', () => {
    expect(bucketTotals(SERIES, 'usd')).toEqual([3, 5, 0]);
    expect(bucketTotals(SERIES, 'tok')).toEqual([150, 1_100, 0]);
  });

  it('accumulates running totals', () => {
    expect(cumulativeOf([3, 5, 0])).toEqual([3, 8, 8]);
    expect(cumulativeOf([])).toEqual([]);
  });

  it('finds the peak bucket per unit, or null when everything is zero', () => {
    expect(peakOf(SERIES, 'usd')).toEqual({ index: 1, bucket: '2026-03-02', value: 5 });
    expect(peakOf(SERIES, 'tok')).toEqual({ index: 1, bucket: '2026-03-02', value: 1_100 });
    expect(
      peakOf(
        {
          ...SERIES,
          cost: [
            [0, 0, 0],
            [0, 0, 0],
          ],
        },
        'usd',
      ),
    ).toBeNull();
  });
});
