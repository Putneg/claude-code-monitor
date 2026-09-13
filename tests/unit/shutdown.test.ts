import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../src/server/logger.js';
import { createShutdown } from '../../src/server/shutdown.js';

/** Lets pending promise callbacks (stop().then) run. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function setup(stop: () => Promise<void> = () => Promise.resolve()) {
  const logger = createLogger('silent');
  const exit = vi.fn<(code: number) => void>();
  const service = { stop: vi.fn(stop) };
  const shutdown = createShutdown({ logger, exit });
  return { logger, exit, service, shutdown };
}

describe('createShutdown', () => {
  it('stops an attached service on the first signal and exits 0', async () => {
    const { logger, exit, service, shutdown } = setup();
    const info = vi.spyOn(logger, 'info');
    shutdown.attach(service);
    expect(service.stop).not.toHaveBeenCalled();
    shutdown.handle('SIGTERM');
    await settle();
    expect(info).toHaveBeenCalledWith({ signal: 'SIGTERM' }, 'shutting down');
    expect(service.stop).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('remembers a signal that arrives during start-up and stops the service once it is attached', async () => {
    const { exit, service, shutdown } = setup();
    shutdown.handle('SIGTERM');
    await settle();
    expect(exit).not.toHaveBeenCalled();
    shutdown.attach(service);
    await settle();
    expect(service.stop).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('forces exit 1 on a second signal while the service is still stopping', () => {
    const { logger, exit, service, shutdown } = setup(() => new Promise<void>(() => {}));
    const warn = vi.spyOn(logger, 'warn');
    shutdown.attach(service);
    shutdown.handle('SIGTERM');
    shutdown.handle('SIGINT');
    expect(warn).toHaveBeenCalledWith({ signal: 'SIGINT' }, 'forced exit');
    expect(service.stop).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('forces exit 1 on a second signal during start-up', () => {
    const { exit, shutdown } = setup();
    shutdown.handle('SIGINT');
    shutdown.handle('SIGINT');
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('logs a failed stop and exits 1', async () => {
    const failure = new Error('database is locked');
    const { logger, exit, service, shutdown } = setup(() => Promise.reject(failure));
    const error = vi.spyOn(logger, 'error');
    shutdown.attach(service);
    shutdown.handle('SIGTERM');
    await settle();
    expect(error).toHaveBeenCalledWith({ err: failure }, 'shutdown failed');
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});
