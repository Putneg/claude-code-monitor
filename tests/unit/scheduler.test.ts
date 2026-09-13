import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../src/server/logger.js';
import { startScheduler } from '../../src/server/scheduler.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const logger = createLogger('silent');

describe('startScheduler', () => {
  it('runs immediately and then after each interval', async () => {
    const task = vi.fn(async () => {});
    const scheduler = startScheduler({ intervalMs: 1_000, task, logger });
    await vi.advanceTimersByTimeAsync(0);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(task).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });

  it('never overlaps runs when a task is slower than the interval', async () => {
    let active = 0;
    let maxActive = 0;
    const task = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      active -= 1;
    });
    const scheduler = startScheduler({ intervalMs: 1_000, task, logger });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(maxActive).toBe(1);
    expect(task.mock.calls.length).toBeGreaterThanOrEqual(3);
    const stopping = scheduler.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    await stopping;
  });

  it('logs failures and keeps running', async () => {
    const errorSpy = vi.spyOn(logger, 'error');
    const task = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('boom')).mockResolvedValue();
    const scheduler = startScheduler({ intervalMs: 1_000, task, logger });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(task).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    await scheduler.stop();
  });

  it('stops after the in-flight run completes', async () => {
    let finished = false;
    const task = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      finished = true;
    });
    const scheduler = startScheduler({ intervalMs: 1_000, task, logger });
    await vi.advanceTimersByTimeAsync(10);
    const stopping = scheduler.stop();
    await vi.advanceTimersByTimeAsync(500);
    await stopping;
    expect(finished).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(task).toHaveBeenCalledTimes(1);
  });
});
