import type { Bucket, OverviewSeries, SeriesKey, Stack } from '../../../shared/api.js';
import {
  OTHER_COLOR,
  PROJECT_PALETTE,
  TOKEN_TYPE_META,
  TOKEN_TYPE_ORDER,
  modelColor,
  modelLabel,
  projectLabel,
} from '../../../shared/models.js';
import { addDays, createHourLabels, createZonedDayStart, enumerateDays } from '../../time.js';
import type { Db } from '../connection.js';
import { buildWhere, type SqlFragment, type UsageFilter } from './filter-sql.js';
import { TOKENS_SUM_SQL } from './totals.js';

export const TOP_PROJECTS = 8;
export const OTHER_KEY = 'other';
const MS_PER_HOUR = 3_600_000;

export interface SeriesOptions {
  readonly bucket: Bucket;
  readonly stack: Stack;
  readonly timeZone: string;
}

interface Axis {
  readonly labels: readonly string[];
  readonly ids: readonly string[];
  readonly sql: string;
  /** Values bound by the bucket expression. */
  readonly params: Readonly<Record<string, number>>;
}

interface CellRow {
  readonly bucket: string | number;
  readonly key: string;
  readonly path: string | null;
  readonly cost: number;
  readonly tokens: number;
}

interface Cell {
  readonly bucket: string;
  readonly key: string;
  readonly cost: number;
  readonly tokens: number;
}

function dayAxis(filter: UsageFilter): Axis {
  const days = enumerateDays(filter.from, filter.to);
  return { labels: days, ids: days, sql: 'local_day', params: {} };
}

function hourAxis(filter: UsageFilter, timeZone: string): Axis {
  const dayStart = createZonedDayStart(timeZone);
  // Buckets are whole hours counted from local midnight, so their edges stay on local
  // hour boundaries even in zones with half-hour or 45-minute offsets.
  const start = dayStart(filter.from);
  const count = Math.max(0, Math.round((dayStart(addDays(filter.to, 1)) - start) / MS_PER_HOUR));
  const hours = Array.from({ length: count }, (_, i) => i);
  return {
    labels: createHourLabels(timeZone)(start, count),
    ids: hours.map(String),
    // better-sqlite3 binds every JS number as REAL; the CAST keeps this an integer division.
    sql: `((ts - CAST(@hourStart AS INTEGER)) / ${MS_PER_HOUR})`,
    params: { hourStart: start },
  };
}

function selectCells(db: Db, filter: UsageFilter, axis: Axis, keyExpr: string): (Cell & { path: string | null })[] {
  const where = buildWhere(filter);
  const rows = db
    .prepare<SqlFragment['params'], CellRow>(
      `SELECT ${axis.sql} AS bucket, ${keyExpr} AS key, MAX(project_path) AS path,
              TOTAL(cost) AS cost, TOTAL(${TOKENS_SUM_SQL}) AS tokens
       FROM usage_costed WHERE ${where.sql} GROUP BY bucket, key`,
    )
    .all({ ...where.params, ...axis.params });
  return rows.map((row) => ({ ...row, bucket: String(row.bucket) }));
}

function selectTypeCells(db: Db, filter: UsageFilter, axis: Axis): Cell[] {
  const where = buildWhere(filter);
  const rows = db
    .prepare<SqlFragment['params'], Record<string, number>>(
      `SELECT ${axis.sql} AS bucket,
              TOTAL(cost_cache_read) AS c_cache_read, TOTAL(cost_cache_write) AS c_cache_write,
              TOTAL(cost_output) AS c_output, TOTAL(cost_input) AS c_input,
              TOTAL(cache_read) AS t_cache_read, TOTAL(cache_write_5m + cache_write_1h) AS t_cache_write,
              TOTAL(output) AS t_output, TOTAL(input) AS t_input
       FROM usage_costed WHERE ${where.sql} GROUP BY bucket`,
    )
    .all({ ...where.params, ...axis.params });
  return rows.flatMap((row) =>
    TOKEN_TYPE_ORDER.map((type) => ({
      bucket: String(row.bucket),
      key: type,
      cost: row[`c_${type}`] ?? 0,
      tokens: row[`t_${type}`] ?? 0,
    })),
  );
}

function mergeCells(cells: readonly Cell[]): Map<string, Cell> {
  return cells.reduce((acc, cell) => {
    const id = `${cell.key}|${cell.bucket}`;
    const existing = acc.get(id);
    acc.set(id, existing ? { ...existing, cost: existing.cost + cell.cost, tokens: existing.tokens + cell.tokens } : cell);
    return acc;
  }, new Map<string, Cell>());
}

function keysByCost(cells: readonly Cell[]): string[] {
  const totals = cells.reduce((acc, cell) => acc.set(cell.key, (acc.get(cell.key) ?? 0) + cell.cost), new Map<string, number>());
  return [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([key]) => key);
}

function assemble(stack: Stack, axis: Axis, cells: readonly Cell[], keys: readonly SeriesKey[]): OverviewSeries {
  const index = mergeCells(cells);
  const matrix = (pick: (cell: Cell) => number): number[][] =>
    keys.map((k) =>
      axis.ids.map((bucket) => {
        const cell = index.get(`${k.key}|${bucket}`);
        return cell ? pick(cell) : 0;
      }),
    );
  return { stack, buckets: axis.labels, keys, cost: matrix((c) => c.cost), tokens: matrix((c) => c.tokens) };
}

function modelSeries(db: Db, filter: UsageFilter, axis: Axis): OverviewSeries {
  const cells = selectCells(db, filter, axis, 'model');
  const keys = keysByCost(cells).map((key) => ({ key, label: modelLabel(key), color: modelColor(key) }));
  return assemble('model', axis, cells, keys);
}

function typeSeries(db: Db, filter: UsageFilter, axis: Axis): OverviewSeries {
  const keys = TOKEN_TYPE_ORDER.map((key) => ({ key, ...TOKEN_TYPE_META[key] }));
  return assemble('type', axis, selectTypeCells(db, filter, axis), keys);
}

function projectSeries(db: Db, filter: UsageFilter, axis: Axis): OverviewSeries {
  const raw = selectCells(db, filter, axis, `COALESCE(project_id, '')`);
  const ranked = keysByCost(raw.filter((cell) => cell.key !== ''));
  const top = new Set(ranked.slice(0, TOP_PROJECTS));
  const cells = raw.map((cell) => (top.has(cell.key) ? cell : { ...cell, key: OTHER_KEY }));
  const paths = new Map(raw.map((cell) => [cell.key, cell.path ?? cell.key]));
  const keys: SeriesKey[] = ranked.slice(0, TOP_PROJECTS).map((key, i) => ({
    key,
    label: projectLabel(paths.get(key) ?? key),
    color: PROJECT_PALETTE[i % PROJECT_PALETTE.length] ?? OTHER_COLOR,
  }));
  const hasOther = cells.some((cell) => cell.key === OTHER_KEY);
  return assemble('project', axis, cells, hasOther ? [...keys, { key: OTHER_KEY, label: 'other', color: OTHER_COLOR }] : keys);
}

export function querySeries(db: Db, filter: UsageFilter, options: SeriesOptions): OverviewSeries {
  const axis = options.bucket === 'hour' ? hourAxis(filter, options.timeZone) : dayAxis(filter);
  if (options.stack === 'type') return typeSeries(db, filter, axis);
  if (options.stack === 'project') return projectSeries(db, filter, axis);
  return modelSeries(db, filter, axis);
}
