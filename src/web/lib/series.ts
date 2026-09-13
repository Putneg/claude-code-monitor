import type { OverviewSeries } from '../../shared/api.js';
import type { Unit } from './view-state.js';

/** [keyIndex][bucketIndex] values in the chosen unit. */
export const unitValues = (series: OverviewSeries, unit: Unit): readonly (readonly number[])[] =>
  unit === 'usd' ? series.cost : series.tokens;

export function bucketTotals(series: OverviewSeries, unit: Unit): number[] {
  const rows = unitValues(series, unit);
  return series.buckets.map((_, index) => rows.reduce((sum, row) => sum + (row[index] ?? 0), 0));
}

export function cumulativeOf(values: readonly number[]): number[] {
  let running = 0;
  return values.map((value) => (running += value));
}

export interface Peak {
  readonly index: number;
  readonly bucket: string;
  readonly value: number;
}

/** Largest bucket total in the unit (the first one on ties); null when every bucket is zero. */
export function peakOf(series: OverviewSeries, unit: Unit): Peak | null {
  return bucketTotals(series, unit).reduce<Peak | null>(
    (best, value, index) =>
      value > 0 && (best === null || value > best.value) ? { index, bucket: series.buckets[index] ?? '', value } : best,
    null,
  );
}
