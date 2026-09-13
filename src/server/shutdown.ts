import type { Logger } from './logger.js';

/** The part of a running service that shutdown needs. */
export interface Stoppable {
  stop(): Promise<void>;
}

export interface ShutdownDeps {
  readonly logger: Logger;
  /** process.exit in production; a fake in tests. */
  readonly exit: (code: number) => void;
}

export interface Shutdown {
  /** SIGTERM/SIGINT handler: the first signal stops the service (now, or once it is attached); a second one exits 1. */
  readonly handle: (signal: NodeJS.Signals) => void;
  /** Hands over the started service; stops it at once when a signal arrived during start-up. */
  attach(service: Stoppable): void;
}

/**
 * Signal handling that can be installed before the service exists, so a SIGTERM during start-up (time zone sync,
 * the first ingest tick, listen) is neither ignored (node as PID 1 without an init) nor turned into an abrupt default
 * exit (behind tini); the service stops once it is up.
 */
export function createShutdown(deps: ShutdownDeps): Shutdown {
  let service: Stoppable | null = null;
  let requested = false;

  const stop = (target: Stoppable): void => {
    target.stop().then(
      () => deps.exit(0),
      (error: unknown) => {
        deps.logger.error({ err: error }, 'shutdown failed');
        deps.exit(1);
      },
    );
  };

  return {
    handle: (signal) => {
      if (requested) {
        deps.logger.warn({ signal }, 'forced exit');
        deps.exit(1);
        return;
      }
      requested = true;
      deps.logger.info({ signal }, 'shutting down');
      if (service !== null) stop(service);
    },
    attach: (started) => {
      service = started;
      if (requested) stop(started);
    },
  };
}
