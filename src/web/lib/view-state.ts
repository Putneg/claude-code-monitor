import type { Bucket, Day, SessionSort, Stack } from '../../shared/api.js';
import { daysInclusive, isValidDay } from '../../shared/days.js';
import { MAX_LIST_ITEM_LENGTH, MAX_LIST_ITEMS, MAX_QUERY_DAY, MAX_RANGE_DAYS, MIN_QUERY_DAY } from '../../shared/limits.js';

export type RangePreset = 'today' | '7d' | '30d' | '90d' | 'all';
export type Unit = 'usd' | 'tok';

export const PRESETS: readonly RangePreset[] = ['today', '7d', '30d', '90d', 'all'];
export const DEFAULT_PRESET: RangePreset = '30d';
const UNITS: readonly Unit[] = ['usd', 'tok'];
export const STACKS: readonly Stack[] = ['model', 'type', 'project'];
const BUCKETS: readonly Bucket[] = ['day', 'hour'];
export const SORTS: readonly SessionSort[] = ['cost', 'recent'];

/** Everything on the page is a function of this state and the API data; it round-trips through the URL. */
export interface ViewState {
  /** null while a custom from/to range is active. */
  readonly range: RangePreset | null;
  readonly from: Day | null;
  readonly to: Day | null;
  /** Empty means all models. */
  readonly models: readonly string[];
  /** Empty means all projects. */
  readonly projects: readonly string[];
  readonly unit: Unit;
  readonly stack: Stack;
  /** null lets the API choose (hour buckets for ranges up to 2 days). */
  readonly bucket: Bucket | null;
  readonly cumulative: boolean;
  readonly sort: SessionSort;
}

export type ViewSettings = Pick<ViewState, 'models' | 'projects' | 'unit' | 'stack' | 'bucket' | 'cumulative' | 'sort'>;

export const DEFAULT_VIEW: ViewState = {
  range: DEFAULT_PRESET,
  from: null,
  to: null,
  models: [],
  projects: [],
  unit: 'usd',
  stack: 'model',
  bucket: null,
  cumulative: true,
  sort: 'cost',
};

function pick<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.find((item) => item === value) ?? fallback;
}

function parseList(value: string | null): string[] {
  if (value === null) return [];
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item.length <= MAX_LIST_ITEM_LENGTH);
  return [...new Set(items)].slice(0, MAX_LIST_ITEMS);
}

/** A valid day that the API also accepts. */
const isQueryDay = (value: string): boolean => isValidDay(value) && value >= MIN_QUERY_DAY && value <= MAX_QUERY_DAY;

function customRange(from: string | null, to: string | null): { from: Day; to: Day } | null {
  if (from === null || to === null || !isQueryDay(from) || !isQueryDay(to) || from > to) return null;
  return daysInclusive(from, to) <= MAX_RANGE_DAYS ? { from, to } : null;
}

/** Reads the view from location.search; anything invalid falls back to its default. */
export function parseViewState(search: string): ViewState {
  const params = new URLSearchParams(search);
  const custom = customRange(params.get('from'), params.get('to'));
  return {
    range: custom ? null : pick(params.get('range'), PRESETS, DEFAULT_PRESET),
    from: custom?.from ?? null,
    to: custom?.to ?? null,
    models: parseList(params.get('models')),
    projects: parseList(params.get('projects')),
    unit: pick(params.get('unit'), UNITS, DEFAULT_VIEW.unit),
    stack: pick(params.get('stack'), STACKS, DEFAULT_VIEW.stack),
    bucket: BUCKETS.find((bucket) => bucket === params.get('bucket')) ?? null,
    cumulative: params.get('cum') !== '0',
    sort: pick(params.get('sort'), SORTS, DEFAULT_VIEW.sort),
  };
}

/** Comma-joined ids, each URL-encoded (ids never contain commas). */
export const encodeList = (items: readonly string[]): string => items.map(encodeURIComponent).join(',');

type Entry = readonly [string, string | null];

/** Canonical query string without the leading '?'. Defaults are omitted, so the default view is ''. */
export function serializeViewState(view: ViewState): string {
  const custom = view.range === null && view.from !== null && view.to !== null;
  const entries: readonly Entry[] = [
    ['range', !custom && view.range !== DEFAULT_PRESET ? view.range : null],
    ['from', custom ? view.from : null],
    ['to', custom ? view.to : null],
    ['models', view.models.length > 0 ? encodeList(view.models) : null],
    ['projects', view.projects.length > 0 ? encodeList(view.projects) : null],
    ['unit', view.unit === DEFAULT_VIEW.unit ? null : view.unit],
    ['stack', view.stack === DEFAULT_VIEW.stack ? null : view.stack],
    ['bucket', view.bucket],
    ['cum', view.cumulative ? null : '0'],
    ['sort', view.sort === DEFAULT_VIEW.sort ? null : view.sort],
  ];
  return entries
    .filter((entry): entry is readonly [string, string] => entry[1] !== null)
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

/** Switching to a preset clears custom dates and lets the API choose the bucket again. */
export function withPreset(view: ViewState, preset: RangePreset): ViewState {
  return { ...view, range: preset, from: null, to: null, bucket: null };
}

/** A custom range (dates are put in order); the bucket goes back to automatic. A range the API would refuse is ignored. */
export function withCustomRange(view: ViewState, from: Day, to: Day): ViewState {
  const [start, end] = from <= to ? [from, to] : [to, from];
  if (daysInclusive(start, end) > MAX_RANGE_DAYS) return view;
  return { ...view, range: null, from: start, to: end, bucket: null };
}

export function withSettings(view: ViewState, patch: Partial<ViewSettings>): ViewState {
  return { ...view, ...patch };
}

export const isChecked = (selected: readonly string[], id: string): boolean => selected.length === 0 || selected.includes(id);

/**
 * Toggles one model, where an empty list means "all". The last checked model cannot be unchecked,
 * and checking the only missing model collapses the list back to "all". Result order follows `all`.
 */
export function toggleModel(selected: readonly string[], all: readonly string[], id: string): readonly string[] {
  const current = selected.length === 0 ? all : all.filter((item) => selected.includes(item));
  const next = current.includes(id) ? current.filter((item) => item !== id) : all.filter((item) => item === id || current.includes(item));
  if (next.length === 0) return selected;
  return next.length === all.length ? [] : next;
}

/** Toggles a project in the filter; an empty list means all projects. */
export function toggleProject(selected: readonly string[], id: string): readonly string[] {
  return selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id];
}
