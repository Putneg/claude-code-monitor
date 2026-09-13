import type { Day } from '../../shared/api.js';
import { isValidDay } from '../../shared/days.js';
import type { DayRange } from './range.js';

/** A typed day is applied after this long without further input. */
export const DATE_APPLY_DELAY_MS = 400;

/** The days a date input accepts: its min (null before any data exists) and max attributes. */
export interface DateBounds {
  readonly min: Day | null;
  readonly max: Day;
}

/**
 * The from/to pair to apply for a typed value, or null when it must not be applied yet. Chromium reports every
 * segment edit, so half-typed values such as 0002-03-10 arrive while a year is typed: `valid` (the input's
 * validity.valid) and the bounds reject them. The other edge keeps its day; withCustomRange orders the pair.
 */
export function typedRange(value: string, valid: boolean, edge: 'from' | 'to', range: DayRange, bounds: DateBounds): DayRange | null {
  if (!valid || !isValidDay(value)) return null;
  if ((bounds.min !== null && value < bounds.min) || value > bounds.max) return null;
  return edge === 'from' ? { from: value, to: range.to } : { from: range.from, to: value };
}

export interface Debouncer {
  /** Replaces any pending run with `run`, due after the delay. */
  schedule(run: () => void): void;
  /** Replaces any pending run with `run`, kept without a timer: only flush runs it, and schedule or cancel drops it. */
  hold(run: () => void): void;
  /** Runs the pending run now; true when there was one. */
  flush(): boolean;
  /** Drops the pending run. */
  cancel(): void;
}

export function createDebouncer(delayMs: number): Debouncer {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: (() => void) | null = null;
  const cancel = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    pending = null;
  };
  const flush = (): boolean => {
    const run = pending;
    cancel();
    if (run === null) return false;
    run();
    return true;
  };
  return {
    schedule(run) {
      cancel();
      pending = run;
      timer = setTimeout(flush, delayMs);
    },
    hold(run) {
      cancel();
      pending = run;
    },
    flush,
    cancel,
  };
}
