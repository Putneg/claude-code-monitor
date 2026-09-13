import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changeKey, decideLoad, startPolling } from '../../../src/web/lib/poll.js';
import { makeStatus } from './fixtures.js';

describe('startPolling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ticks immediately and then one interval after each tick', async () => {
    const tick = vi.fn(async () => {});
    const poller = startPolling({ intervalMs: 1_000, tick, onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tick).toHaveBeenCalledTimes(2);
    poller.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('never overlaps a slow tick', async () => {
    let finish: () => void = () => {};
    const tick = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const poller = startPolling({ intervalMs: 1_000, tick, onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tick).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tick).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it('reports failures and keeps polling', async () => {
    const failure = new Error('down');
    const tick = vi.fn(async () => {
      throw failure;
    });
    const onError = vi.fn();
    const poller = startPolling({ intervalMs: 1_000, tick, onError });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onError).toHaveBeenCalledWith(failure);
    expect(tick).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it('runs a tick on demand and restarts the interval from it', async () => {
    const tick = vi.fn(async () => {});
    const poller = startPolling({ intervalMs: 1_000, tick, onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(400);
    expect(tick).toHaveBeenCalledTimes(1);
    poller.runNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(2);
    // The tick that was due at 1,000 ms is replaced by one at 400 + 1,000 ms.
    await vi.advanceTimersByTimeAsync(999);
    expect(tick).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(3);
    poller.stop();
  });

  it('ignores runNow while a tick is running and after stop', async () => {
    let finish: () => void = () => {};
    const tick = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const poller = startPolling({ intervalMs: 1_000, tick, onError: vi.fn() });
    poller.runNow();
    expect(tick).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    poller.stop();
    poller.runNow();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('schedules nothing after a tick that was running when it stopped', async () => {
    let finish: () => void = () => {};
    const tick = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const poller = startPolling({ intervalMs: 1_000, tick, onError: vi.fn() });
    expect(tick).toHaveBeenCalledTimes(1);
    // The page unmounts in the middle of a poll; the poll then settles.
    poller.stop();
    finish();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('changeKey', () => {
  const at = (lastChangeAt: string | null, fetchedAt: string | null) =>
    makeStatus({
      sync: { ...makeStatus().sync, lastChangeAt },
      pricing: { ...makeStatus().pricing, fetchedAt },
    });

  it('moves with new transcript data or new prices, not with every sync', () => {
    const base = changeKey(at('2026-09-11T11:00:00.000Z', '2026-09-11T06:00:00.000Z'));
    expect(changeKey({ ...at('2026-09-11T11:00:00.000Z', '2026-09-11T06:00:00.000Z'), now: 'later' })).toBe(base);
    expect(changeKey(at('2026-09-11T11:01:00.000Z', '2026-09-11T06:00:00.000Z'))).not.toBe(base);
    expect(changeKey(at('2026-09-11T11:00:00.000Z', '2026-09-12T06:00:00.000Z'))).not.toBe(base);
    const grown = at('2026-09-11T11:00:00.000Z', '2026-09-11T06:00:00.000Z');
    expect(changeKey({ ...grown, data: { ...grown.data, rows: grown.data.rows + 1 } })).not.toBe(base);
  });
});

describe('decideLoad', () => {
  const mark = { key: 'a', version: 1 };

  it('loads the first request and every user-driven change, even with the pointer on the chart', () => {
    expect(decideLoad(null, mark, true)).toBe('load');
    expect(decideLoad(mark, { key: 'b', version: 1 }, true)).toBe('load');
  });

  it('skips when nothing changed', () => {
    expect(decideLoad(mark, mark, false)).toBe('skip');
  });

  it('defers a background refresh while the pointer is on the chart', () => {
    expect(decideLoad(mark, { key: 'a', version: 2 }, true)).toBe('defer');
    expect(decideLoad(mark, { key: 'a', version: 2 }, false)).toBe('load');
  });
});
