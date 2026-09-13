import type { StatusResponse } from '../../shared/api.js';

/** The dashboard polls the status endpoint every 30 seconds. */
export const POLL_INTERVAL_MS = 30_000;

export interface PollOptions {
  readonly intervalMs: number;
  readonly tick: () => Promise<void>;
  readonly onError: (error: unknown) => void;
}

export interface Poller {
  stop(): void;
  /** Runs a tick now (the tab became visible) unless one is running; the interval restarts after it. */
  runNow(): void;
}

/** Runs `tick` now and then `intervalMs` after each tick settles, so ticks never overlap. */
export function startPolling(options: PollOptions): Poller {
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async (): Promise<void> => {
    running = true;
    try {
      await options.tick();
    } catch (error) {
      options.onError(error);
    } finally {
      running = false;
    }
    if (!stopped) timer = setTimeout(() => void run(), options.intervalMs);
  };
  void run();
  return {
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
    runNow: () => {
      if (stopped || running) return;
      clearTimeout(timer);
      void run();
    },
  };
}

/** Moves when overview and sessions may have changed: new transcript lines, new rows or a price refresh. */
export function changeKey(status: StatusResponse): string {
  return [status.sync.lastChangeAt ?? '-', status.data.rows, status.pricing.source, status.pricing.fetchedAt ?? '-'].join('|');
}

export interface LoadMark {
  /** DataRequest.key: which filters the data was loaded for. */
  readonly key: string;
  /** Bumped by the poller when changeKey moves. */
  readonly version: number;
}

export type LoadDecision = 'load' | 'defer' | 'skip';

/**
 * User-driven changes (a new key) always load. A background refresh (same key, newer version)
 * waits while the pointer is on the chart, so an open tooltip is not redrawn under the cursor.
 */
export function decideLoad(last: LoadMark | null, next: LoadMark, pointerOnChart: boolean): LoadDecision {
  if (last === null || last.key !== next.key) return 'load';
  if (last.version === next.version) return 'skip';
  return pointerOnChart ? 'defer' : 'load';
}
