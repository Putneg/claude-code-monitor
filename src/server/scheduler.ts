import type { Logger } from './logger.js';

export interface Scheduler {
  stop(): Promise<void>;
}

export interface SchedulerOptions {
  readonly intervalMs: number;
  readonly task: () => Promise<void>;
  readonly logger: Logger;
}

/** Runs `task` now and then `intervalMs` after each completion; runs never overlap. */
export function startScheduler(options: SchedulerOptions): Scheduler {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();

  const tick = (): void => {
    inFlight = options
      .task()
      .catch((error: unknown) => {
        options.logger.error({ err: error }, 'scheduled task failed');
      })
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, options.intervalMs);
      });
  };

  tick();

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
  };
}
