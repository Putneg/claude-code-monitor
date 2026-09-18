import { mkdirSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../src/server/logger.js';
import { createClaudeLimitsSource, MAX_LIMITS_FILE_BYTES } from '../../src/server/limits/claude-limits-source.js';
import { createTree, type Tree } from '../helpers/tree.js';

const REL = 'claude-code-monitor/rate-limits.json';
const fileText = (used: number): string =>
  JSON.stringify({ version: 1, windows: { five_hour: { used_percentage: used, resets_at: 1_790_000_000, observed_at: 1_789_990_000 } } });
const reading = (used: number) => ({
  windows: [{ kind: 'five_hour', usedPercent: used, resetsAt: new Date(1_790_000_000_000).toISOString() }],
  observedAt: new Date(1_789_990_000_000).toISOString(),
});

let tree: Tree | undefined;
afterEach(() => tree?.cleanup());

function setup() {
  tree = createTree();
  const logger = createLogger('silent');
  const warn = vi.spyOn(logger, 'warn');
  return { tree, warn, source: createClaudeLimitsSource(tree.path(REL), logger) };
}

describe('createClaudeLimitsSource', () => {
  it('reports nothing and logs nothing without a file', () => {
    const { source, warn } = setup();
    expect(source.read()).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads the file', () => {
    const { tree, source } = setup();
    tree.writeRaw(REL, fileText(23));
    expect(source.read()).toEqual(reading(23));
  });

  it('serves the cached reading until the modification time or size changes', () => {
    const { tree, source } = setup();
    const when = new Date('2026-09-18T10:00:00.000Z');
    tree.writeRaw(REL, fileText(23));
    tree.setMtime(REL, when);
    expect(source.read()).toEqual(reading(23));
    tree.writeRaw(REL, fileText(24));
    tree.setMtime(REL, when);
    expect(source.read()).toEqual(reading(23));
    tree.setMtime(REL, new Date(when.getTime() + 1_000));
    expect(source.read()).toEqual(reading(24));
    tree.writeRaw(REL, fileText(100));
    tree.setMtime(REL, new Date(when.getTime() + 1_000));
    expect(source.read()).toEqual(reading(100));
  });

  it('logs an invalid file once and recovers when it is replaced', () => {
    const { tree, source, warn } = setup();
    tree.writeRaw(REL, '{broken');
    expect(source.read()).toBeNull();
    expect(source.read()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith({ path: tree.path(REL), reason: 'not JSON' }, 'Claude limits file is not valid; ignored');
    tree.writeRaw(REL, fileText(30));
    tree.setMtime(REL, new Date(Date.now() + 5_000));
    expect(source.read()).toEqual(reading(30));
  });

  it('ignores a file that is too large', () => {
    const { tree, source, warn } = setup();
    tree.writeRaw(REL, 'x'.repeat(MAX_LIMITS_FILE_BYTES + 1));
    expect(source.read()).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      { path: tree.path(REL), size: MAX_LIMITS_FILE_BYTES + 1 },
      'Claude limits file is too large; ignored',
    );
  });

  it('ignores a path that is not a file and logs it once', () => {
    const { tree, source, warn } = setup();
    mkdirSync(tree.path(REL), { recursive: true });
    expect(source.read()).toBeNull();
    expect(source.read()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith({ path: tree.path(REL) }, 'Claude limits path is not a file; ignored');
  });

  it('logs a problem again when it returns after a good reading', () => {
    const { tree, source, warn } = setup();
    mkdirSync(tree.path(REL), { recursive: true });
    expect(source.read()).toBeNull();
    rmSync(tree.path(REL), { recursive: true });
    tree.writeRaw(REL, fileText(23));
    expect(source.read()).toEqual(reading(23));
    rmSync(tree.path(REL));
    mkdirSync(tree.path(REL));
    expect(source.read()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
