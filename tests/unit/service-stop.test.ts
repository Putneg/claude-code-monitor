import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../src/server/logger.js';
import { abortStart, stopAll, type Background } from '../../src/server/service.js';

interface FakeBackground {
  readonly background: Background;
  /** Every shutdown step, in the order it ran. */
  readonly calls: string[];
}

/** Plain fakes that record their calls; `schedulerStop` decides how the scheduler's stop settles. */
function fakeBackground(schedulerStop: () => Promise<void> = () => Promise.resolve()): FakeBackground {
  const calls: string[] = [];
  const controller = new AbortController();
  controller.signal.addEventListener('abort', () => calls.push('abort'));
  const background: Background = {
    controller,
    scheduler: {
      stop: () => {
        calls.push('scheduler.stop');
        return schedulerStop();
      },
    },
    pricing: {
      stop: () => {
        calls.push('pricing.stop');
      },
    },
    db: {
      close: () => {
        calls.push('db.close');
      },
    },
  };
  return { background, calls };
}

describe('stopAll', () => {
  it('aborts ingest, stops the scheduler and pricing, then closes the database', async () => {
    const { background, calls } = fakeBackground();
    await stopAll(background, null);
    expect(calls).toEqual(['abort', 'scheduler.stop', 'pricing.stop', 'db.close']);
  });

  it('still closes the database when the scheduler fails to stop, and rejects with that error', async () => {
    const failure = new Error('scheduler did not stop');
    const { background, calls } = fakeBackground(() => Promise.reject(failure));
    await expect(stopAll(background, null)).rejects.toBe(failure);
    expect(calls).toEqual(['abort', 'scheduler.stop', 'db.close']);
  });
});

describe('abortStart', () => {
  it('rejects with the listen error when the cleanup fails, and logs the cleanup error', async () => {
    const listenError = new Error('listen EADDRINUSE');
    const cleanupError = new Error('scheduler did not stop');
    const { background, calls } = fakeBackground(() => Promise.reject(cleanupError));
    const logger = createLogger('silent');
    const errorSpy = vi.spyOn(logger, 'error');
    await expect(abortStart(background, listenError, logger)).rejects.toBe(listenError);
    expect(errorSpy).toHaveBeenCalledWith({ err: cleanupError }, 'cleanup after a failed start failed');
    expect(calls).toContain('db.close');
  });

  it('rejects with the listen error when the cleanup succeeds, after closing the database', async () => {
    const listenError = new Error('listen EADDRINUSE');
    const { background, calls } = fakeBackground();
    await expect(abortStart(background, listenError, createLogger('silent'))).rejects.toBe(listenError);
    expect(calls).toEqual(['abort', 'scheduler.stop', 'pricing.stop', 'db.close']);
  });
});
