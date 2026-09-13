import { z } from 'zod';
import type { Bucket } from '../../shared/api.js';
import {
  AUTO_HOURLY_DAYS,
  DEFAULT_RANGE_DAYS,
  MAX_HOURLY_DAYS,
  MAX_LIST_ITEM_LENGTH,
  MAX_LIST_ITEMS,
  MAX_QUERY_DAY,
  MAX_RANGE_DAYS,
  MIN_QUERY_DAY,
} from '../../shared/limits.js';
import type { UsageFilter } from '../db/queries/filter-sql.js';
import { addDays, daysInclusive, isValidDay } from '../time.js';

export { AUTO_HOURLY_DAYS, DEFAULT_RANGE_DAYS, MAX_HOURLY_DAYS, MAX_RANGE_DAYS };

export class QueryError extends Error {
  override readonly name = 'QueryError';
  readonly details: unknown;

  constructor(details: unknown) {
    super('invalid_query');
    this.details = details;
  }
}

const day = z
  .string()
  .refine(
    (value) => isValidDay(value) && value >= MIN_QUERY_DAY && value <= MAX_QUERY_DAY,
    `expected a calendar day in YYYY-MM-DD format between ${MIN_QUERY_DAY} and ${MAX_QUERY_DAY}`,
  );
const list = z
  .string()
  .optional()
  .transform((value) =>
    value
      ? value
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
      : [],
  )
  .pipe(z.array(z.string().max(MAX_LIST_ITEM_LENGTH)).max(MAX_LIST_ITEMS));

const filterShape = { from: day.optional(), to: day.optional(), models: list, projects: list };

export const overviewQuerySchema = z.object({
  ...filterShape,
  bucket: z.enum(['day', 'hour']).optional(),
  stack: z.enum(['model', 'type', 'project']).default('model'),
});

export const sessionsQuerySchema = z.object({
  ...filterShape,
  sort: z.enum(['cost', 'recent']).default('cost'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function parseQuery<S extends z.ZodType>(schema: S, query: Record<string, string>): z.output<S> {
  const result = schema.safeParse(query);
  if (!result.success) throw new QueryError(z.flattenError(result.error).fieldErrors);
  return result.data;
}

export interface FilterQuery {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly models: readonly string[];
  readonly projects: readonly string[];
}

export function resolveFilter(query: FilterQuery, today: string): UsageFilter {
  const to = query.to ?? today;
  const from = query.from ?? addDays(to, -(DEFAULT_RANGE_DAYS - 1));
  if (from > to) throw new QueryError({ from: ['must not be after to'] });
  if (daysInclusive(from, to) > MAX_RANGE_DAYS) throw new QueryError({ from: [`range is limited to ${MAX_RANGE_DAYS} days`] });
  return { from, to, models: [...query.models], projects: [...query.projects] };
}

export function resolveBucket(requested: Bucket | undefined, days: number): Bucket {
  if (requested === 'hour' && days > MAX_HOURLY_DAYS) {
    throw new QueryError({ bucket: [`hour buckets are limited to ${MAX_HOURLY_DAYS} days`] });
  }
  return requested ?? (days <= AUTO_HOURLY_DAYS ? 'hour' : 'day');
}
