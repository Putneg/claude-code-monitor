import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDebouncer, DATE_APPLY_DELAY_MS, typedRange } from '../../../src/web/lib/date-input.js';

const RANGE = { from: '2026-03-01', to: '2026-03-14' };
const BOUNDS = { min: '2026-02-01', max: '2026-03-15' };

describe('typedRange', () => {
  it('replaces the edited edge with a valid typed day', () => {
    expect(typedRange('2026-03-10', true, 'from', RANGE, BOUNDS)).toEqual({ from: '2026-03-10', to: '2026-03-14' });
    expect(typedRange('2026-03-05', true, 'to', RANGE, BOUNDS)).toEqual({ from: '2026-03-01', to: '2026-03-05' });
  });

  it('leaves a reversed pair for withCustomRange to order', () => {
    expect(typedRange('2026-03-12', true, 'to', { from: '2026-03-13', to: '2026-03-14' }, BOUNDS)).toEqual({
      from: '2026-03-13',
      to: '2026-03-12',
    });
  });

  it('rejects a value the input itself reports invalid', () => {
    expect(typedRange('2026-03-10', false, 'from', RANGE, BOUNDS)).toBeNull();
  });

  it('rejects empty, half-typed and impossible values', () => {
    expect(typedRange('', true, 'from', RANGE, BOUNDS)).toBeNull();
    // A year typed as 2026 passes through 0002; isValidDay rejects years below 100.
    expect(typedRange('0002-03-10', true, 'from', RANGE, { min: null, max: '2026-03-15' })).toBeNull();
    expect(typedRange('2026-02-30', true, 'from', RANGE, BOUNDS)).toBeNull();
  });

  it('accepts only days inside [min, max], and has no lower bound without data', () => {
    expect(typedRange('2026-01-31', true, 'from', RANGE, BOUNDS)).toBeNull();
    expect(typedRange('2026-03-16', true, 'to', RANGE, BOUNDS)).toBeNull();
    expect(typedRange('2026-02-01', true, 'from', RANGE, BOUNDS)).toEqual({ from: '2026-02-01', to: '2026-03-14' });
    expect(typedRange('2026-03-15', true, 'to', RANGE, BOUNDS)).toEqual({ from: '2026-03-01', to: '2026-03-15' });
    expect(typedRange('2020-01-01', true, 'from', RANGE, { min: null, max: '2026-03-15' })).toEqual({
      from: '2020-01-01',
      to: '2026-03-14',
    });
  });
});

describe('createDebouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs only the last scheduled run, once the delay passes without another', () => {
    expect(DATE_APPLY_DELAY_MS).toBe(400);
    const debouncer = createDebouncer(DATE_APPLY_DELAY_MS);
    const first = vi.fn();
    const last = vi.fn();
    debouncer.schedule(first);
    vi.advanceTimersByTime(DATE_APPLY_DELAY_MS - 1);
    debouncer.schedule(last);
    vi.advanceTimersByTime(DATE_APPLY_DELAY_MS - 1);
    expect(last).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(first).not.toHaveBeenCalled();
    expect(last).toHaveBeenCalledTimes(1);
  });

  it('flushes a pending run at once and reports whether there was one', () => {
    const debouncer = createDebouncer(DATE_APPLY_DELAY_MS);
    const run = vi.fn();
    expect(debouncer.flush()).toBe(false);
    debouncer.schedule(run);
    expect(debouncer.flush()).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(debouncer.flush()).toBe(false);
  });

  it('drops a cancelled run', () => {
    const debouncer = createDebouncer(DATE_APPLY_DELAY_MS);
    const run = vi.fn();
    debouncer.schedule(run);
    debouncer.cancel();
    vi.advanceTimersByTime(1_000);
    expect(run).not.toHaveBeenCalled();
    expect(debouncer.flush()).toBe(false);
  });

  it('never runs a held run on its own, and drops the scheduled run it replaces', () => {
    const debouncer = createDebouncer(DATE_APPLY_DELAY_MS);
    const scheduled = vi.fn();
    const held = vi.fn();
    debouncer.schedule(scheduled);
    debouncer.hold(held);
    vi.advanceTimersByTime(10_000);
    expect(scheduled).not.toHaveBeenCalled();
    expect(held).not.toHaveBeenCalled();
  });

  it('runs a held run once on flush', () => {
    const debouncer = createDebouncer(DATE_APPLY_DELAY_MS);
    const held = vi.fn();
    debouncer.hold(held);
    expect(debouncer.flush()).toBe(true);
    expect(held).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(held).toHaveBeenCalledTimes(1);
    expect(debouncer.flush()).toBe(false);
  });

  it('replaces a held run with a later scheduled one', () => {
    const debouncer = createDebouncer(DATE_APPLY_DELAY_MS);
    const held = vi.fn();
    const scheduled = vi.fn();
    debouncer.hold(held);
    debouncer.schedule(scheduled);
    vi.advanceTimersByTime(DATE_APPLY_DELAY_MS);
    expect(scheduled).toHaveBeenCalledTimes(1);
    expect(held).not.toHaveBeenCalled();
    expect(debouncer.flush()).toBe(false);
  });

  it('drops a held run on cancel', () => {
    const debouncer = createDebouncer(DATE_APPLY_DELAY_MS);
    const held = vi.fn();
    debouncer.hold(held);
    debouncer.cancel();
    vi.advanceTimersByTime(10_000);
    expect(debouncer.flush()).toBe(false);
    expect(held).not.toHaveBeenCalled();
  });
});
