import type { Bucket, Day } from '../../shared/api.js';
import { addDays, daysInclusive, isValidDay } from '../../shared/days.js';
import { MAX_HOURLY_DAYS, MAX_RANGE_DAYS, MIN_QUERY_DAY } from '../../shared/limits.js';
import { shortDay } from './format.js';
import { DEFAULT_PRESET, type RangePreset, type ViewState } from './view-state.js';

export interface DayRange {
  readonly from: Day;
  readonly to: Day;
}

const PRESET_DAYS: Readonly<Record<'7d' | '30d' | '90d', number>> = { '7d': 7, '30d': 30, '90d': 90 };

/** Start of the "all" preset: the first day with data, but never more than MAX_RANGE_DAYS back; today without one. */
function allFrom(today: Day, firstDay: Day | null): Day {
  if (firstDay === null || !isValidDay(firstDay) || firstDay >= today) return today;
  const earliest = addDays(today, -(MAX_RANGE_DAYS - 1));
  return firstDay > earliest ? firstDay : earliest;
}

/** Presets end today in the server zone; Nd covers N local days including today. */
export function presetRange(preset: RangePreset, today: Day, firstDay: Day | null): DayRange {
  if (preset === 'today') return { from: today, to: today };
  if (preset === 'all') return { from: allFrom(today, firstDay), to: today };
  return { from: addDays(today, -(PRESET_DAYS[preset] - 1)), to: today };
}

export function resolveRange(view: ViewState, today: Day, firstDay: Day | null): DayRange {
  if (view.range === null && view.from !== null && view.to !== null) return { from: view.from, to: view.to };
  return presetRange(view.range ?? DEFAULT_PRESET, today, firstDay);
}

export const rangeDays = (range: DayRange): number => daysInclusive(range.from, range.to);

export const hourBucketAllowed = (range: DayRange): boolean => rangeDays(range) <= MAX_HOURLY_DAYS;

/** A single day has one day bucket: one point per series, which a step line without symbols does not draw. */
export const dayBucketAllowed = (range: DayRange): boolean => rangeDays(range) > 1;

/**
 * The bucket to send, or null for the API default. An explicit hour choice is dropped when the range is too long,
 * because the API would answer 400; an explicit day choice is dropped on a single day, which would draw an empty chart.
 */
export function requestBucket(choice: Bucket | null, range: DayRange): Bucket | null {
  if (choice === 'hour' && !hourBucketAllowed(range)) return null;
  if (choice === 'day' && !dayBucketAllowed(range)) return null;
  return choice;
}

/** Caption text: the preset name, 'MM-DD' for a single custom day, or 'MM-DD → MM-DD'. */
export function rangeLabel(view: ViewState, range: DayRange): string {
  if (view.range !== null) return view.range;
  return range.from === range.to ? shortDay(range.from) : `${shortDay(range.from)} → ${shortDay(range.to)}`;
}

/** Maps brushed category indices to whole days; hour labels contribute their date part. */
export function brushRange(buckets: readonly string[], start: number, end: number): DayRange | null {
  if (buckets.length === 0) return null;
  const clamp = (index: number): number => Math.min(Math.max(Math.round(index), 0), buckets.length - 1);
  const from = buckets[clamp(Math.min(start, end))]?.slice(0, 10) ?? '';
  const to = buckets[clamp(Math.max(start, end))]?.slice(0, 10) ?? '';
  return isValidDay(from) && isValidDay(to) ? { from, to } : null;
}

export type ShiftDirection = 'back' | 'forward';

export interface ShiftBounds {
  readonly today: Day;
  readonly firstDay: Day | null;
}

export interface ShiftSide {
  readonly allowed: boolean;
  /** Why the side is unavailable, for the button's description; null when allowed. */
  readonly reason: string | null;
  /** Accessible name of the button, e.g. 'previous 7 days'. */
  readonly label: string;
}

function sideLabel(direction: ShiftDirection, days: number): string {
  const word = direction === 'back' ? 'previous' : 'next';
  return days === 1 ? `${word} day` : `${word} ${days} days`;
}

/** Why a step is impossible, or null when it is possible. */
function blockedReason(preset: RangePreset | null, range: DayRange, direction: ShiftDirection, bounds: ShiftBounds): string | null {
  if (preset === 'all') return 'the all range has no neighbour';
  if (direction === 'forward') return range.to < bounds.today ? null : 'already at today';
  if (bounds.firstDay === null) return 'no history yet';
  if (range.from <= bounds.firstDay) return `history starts ${shortDay(bounds.firstDay)}`;
  return addDays(range.from, -rangeDays(range)) < MIN_QUERY_DAY ? 'no earlier days' : null;
}

export function shiftSide(preset: RangePreset | null, range: DayRange, direction: ShiftDirection, bounds: ShiftBounds): ShiftSide {
  const reason = blockedReason(preset, range, direction, bounds);
  return { allowed: reason === null, reason, label: sideLabel(direction, rangeDays(range)) };
}

/**
 * The neighbouring range of the same length, or null when that side is unavailable. Back may start before the first
 * day of history (a partly empty range); forward never passes today, so the last step ends there and may move the
 * range by less than its length.
 */
export function shiftRange(preset: RangePreset | null, range: DayRange, direction: ShiftDirection, bounds: ShiftBounds): DayRange | null {
  if (blockedReason(preset, range, direction, bounds) !== null) return null;
  const days = rangeDays(range);
  if (direction === 'back') return { from: addDays(range.from, -days), to: addDays(range.to, -days) };
  const end = addDays(range.to, days);
  const to = end > bounds.today ? bounds.today : end;
  return { from: addDays(to, -(days - 1)), to };
}
