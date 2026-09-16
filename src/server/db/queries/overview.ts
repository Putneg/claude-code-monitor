import type { OverviewResponse, OverviewSeries } from '../../../shared/api.js';
import { addDays, daysInclusive } from '../../time.js';
import type { Db } from '../connection.js';
import type { UsageFilter } from './filter-sql.js';
import { querySeries, type SeriesOptions } from './series.js';
import { queryByClient, queryByModel, queryByProject, queryPeriodCost, queryTotals } from './totals.js';

export interface OverviewOptions extends SeriesOptions {
  /** First day with any usage in the database (unfiltered), or null when empty. */
  readonly dataFirstDay: string | null;
}

export function findPeak(series: OverviewSeries): { bucket: string; cost: number } | null {
  const totals = series.buckets.map((_, b) => series.cost.reduce((sum, row) => sum + (row[b] ?? 0), 0));
  const best = totals.reduce((bestIndex, value, index) => (value > (totals[bestIndex] ?? 0) ? index : bestIndex), 0);
  const cost = totals[best] ?? 0;
  const bucket = series.buckets[best];
  return cost > 0 && bucket !== undefined ? { bucket, cost } : null;
}

export function previousPeriod(filter: UsageFilter): UsageFilter {
  const days = daysInclusive(filter.from, filter.to);
  return { ...filter, from: addDays(filter.from, -days), to: addDays(filter.from, -1) };
}

function prevPeriodCost(db: Db, filter: UsageFilter, dataFirstDay: string | null): number | null {
  const previous = previousPeriod(filter);
  if (dataFirstDay === null || dataFirstDay > previous.from) return null;
  return queryPeriodCost(db, previous);
}

export function queryOverview(db: Db, filter: UsageFilter, options: OverviewOptions): OverviewResponse {
  const days = daysInclusive(filter.from, filter.to);
  const core = queryTotals(db, filter);
  const series = querySeries(db, filter, options);
  return {
    range: { from: filter.from, to: filter.to, days, bucket: options.bucket },
    totals: {
      ...core,
      avgCostPerDay: days > 0 ? core.cost.total / days : 0,
      peak: findPeak(series),
      prevPeriodCost: prevPeriodCost(db, filter, options.dataFirstDay),
    },
    series,
    byModel: queryByModel(db, filter, core.cost.total),
    byProject: queryByProject(db, filter),
    byClient: queryByClient(db, filter, core.cost.total),
  };
}
