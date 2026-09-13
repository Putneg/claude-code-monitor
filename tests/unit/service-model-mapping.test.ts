import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../src/server/logger.js';
import { mapModelsOnCommit } from '../../src/server/service.js';

const FAILURE_MESSAGE = 'failed to map models to prices; they stay unpriced until another file or a restart maps them';

describe('mapModelsOnCommit', () => {
  it('passes the models of a committed file to the pricing service', () => {
    const ensureMapped = vi.fn();
    const logger = createLogger('silent');
    const warn = vi.spyOn(logger, 'warn');
    const models = new Set(['claude-opus-5', 'claude-sonnet-5']);
    mapModelsOnCommit({ ensureMapped }, logger)(models);
    expect(ensureMapped).toHaveBeenCalledTimes(1);
    expect(ensureMapped).toHaveBeenCalledWith(models);
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs a mapping failure once instead of throwing it', () => {
    const failure = new Error('database is locked');
    const ensureMapped = vi.fn(() => {
      throw failure;
    });
    const logger = createLogger('silent');
    const warn = vi.spyOn(logger, 'warn');
    const onFileCommitted = mapModelsOnCommit({ ensureMapped }, logger);
    expect(() => onFileCommitted(new Set(['claude-opus-5', 'claude-sonnet-5']))).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith({ err: failure, models: ['claude-opus-5', 'claude-sonnet-5'] }, FAILURE_MESSAGE);
  });
});
