import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_FILE_BYTES,
  MAX_INPUT_BYTES,
  recordWindows,
  runTap,
  STALE_TEMP_MS,
  sweepStaleTemps,
} from '../../scripts/claude-limits-tap-core.mjs';
import { createTree, type Tree } from '../helpers/tree.js';

const TAP = fileURLToPath(new URL('../../scripts/claude-limits-tap.mjs', import.meta.url));
const NOW_MS = 1_789_990_000_000;
const NOW = NOW_MS / 1000;
const INPUT = JSON.stringify({
  session_id: 's',
  model: { display_name: 'Opus' },
  rate_limits: {
    five_hour: { used_percentage: 23, resets_at: 1_790_000_000 },
    seven_day: { used_percentage: 41, resets_at: 1_790_500_000 },
  },
});
const FIVE_HOUR = { used_percentage: 23, resets_at: 1_790_000_000, observed_at: NOW };
const SEVEN_DAY = { used_percentage: 41, resets_at: 1_790_500_000, observed_at: NOW };

let tree: Tree | undefined;
afterEach(() => tree?.cleanup());

function setupTree(): Tree {
  tree = createTree();
  return tree;
}

const limitsFile = (configDir: string): string => join(configDir, 'claude-code-monitor', 'rate-limits.json');
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

/** runTap's streams, recording what it writes. */
function streams() {
  const out: (string | Uint8Array)[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: { write: (chunk: string | Uint8Array) => out.push(chunk) },
    stderr: { write: (chunk: string) => err.push(chunk) },
  };
}

function run(input: Buffer, configDir: string, args: readonly string[] = []) {
  const io = streams();
  runTap({ input, args, env: { CLAUDE_CONFIG_DIR: configDir }, nowMs: NOW_MS, stdout: io.stdout, stderr: io.stderr });
  return io;
}

describe('recordWindows', () => {
  it('creates the folder and the file, then skips an unchanged reading until it is a minute newer', () => {
    const path = limitsFile(setupTree().root);
    expect(recordWindows(path, { five_hour: FIVE_HOUR })).toBe(true);
    expect(readJson(path)).toEqual({ version: 1, windows: { five_hour: FIVE_HOUR } });
    expect(recordWindows(path, { five_hour: { ...FIVE_HOUR, observed_at: NOW + 59 } })).toBe(false);
    expect(recordWindows(path, { five_hour: { ...FIVE_HOUR, observed_at: NOW + 60 } })).toBe(true);
    expect(readJson(path)).toEqual({ version: 1, windows: { five_hour: { ...FIVE_HOUR, observed_at: NOW + 60 } } });
    expect(readdirSync(dirname(path))).toEqual(['rate-limits.json']);
  });

  it('writes nothing without windows', () => {
    const path = limitsFile(setupTree().root);
    expect(recordWindows(path, {})).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  it('replaces a file that is too large or not a limits file', () => {
    const current = setupTree();
    const path = current.writeRaw('claude-code-monitor/rate-limits.json', 'x'.repeat(MAX_FILE_BYTES + 1));
    expect(recordWindows(path, { five_hour: FIVE_HOUR })).toBe(true);
    expect(readJson(path)).toEqual({ version: 1, windows: { five_hour: FIVE_HOUR } });
    current.writeRaw('claude-code-monitor/rate-limits.json', '{broken');
    expect(recordWindows(path, { five_hour: FIVE_HOUR })).toBe(true);
    expect(readJson(path)).toEqual({ version: 1, windows: { five_hour: FIVE_HOUR } });
  });

  it('replaces a stored window the server would reject', () => {
    const current = setupTree();
    const poisoned = { version: 1, windows: { five_hour: { ...FIVE_HOUR, resets_at: 1_790_000_000_000 } } };
    const path = current.writeRaw('claude-code-monitor/rate-limits.json', JSON.stringify(poisoned));
    expect(recordWindows(path, { five_hour: FIVE_HOUR })).toBe(true);
    expect(readJson(path)).toEqual({ version: 1, windows: { five_hour: FIVE_HOUR } });
  });
});

describe('sweepStaleTemps', () => {
  it('removes only the limits file temporaries older than STALE_TEMP_MS', () => {
    const current = setupTree();
    const now = Date.now();
    const path = current.writeRaw('claude-code-monitor/rate-limits.json', '{}');
    current.writeRaw('claude-code-monitor/rate-limits.json.111.tmp', 'old');
    current.setMtime('claude-code-monitor/rate-limits.json.111.tmp', new Date(now - STALE_TEMP_MS - 1_000));
    current.writeRaw('claude-code-monitor/rate-limits.json.222.tmp', 'in progress');
    current.writeRaw('claude-code-monitor/other.json.333.tmp', 'not ours');
    current.setMtime('claude-code-monitor/other.json.333.tmp', new Date(now - STALE_TEMP_MS - 1_000));
    sweepStaleTemps(path, now);
    expect(readdirSync(dirname(path)).sort()).toEqual(['other.json.333.tmp', 'rate-limits.json', 'rate-limits.json.222.tmp']);
  });
});

describe('runTap', () => {
  it('records the limits and passes the input through unchanged', () => {
    const { root } = setupTree();
    const input = Buffer.from(INPUT);
    const io = run(input, root);
    expect(io.out).toEqual([input]);
    expect(io.err).toEqual([]);
    expect(readJson(limitsFile(root))).toEqual({ version: 1, windows: { five_hour: FIVE_HOUR, seven_day: SEVEN_DAY } });
  });

  it('prints a summary instead of the input with --standalone', () => {
    const { root } = setupTree();
    const io = run(Buffer.from(INPUT), root, ['--standalone']);
    expect(io.out).toEqual(['5h 23% · weekly 41%']);
    expect(io.err).toEqual([]);
    expect(readJson(limitsFile(root))).toEqual({ version: 1, windows: { five_hour: FIVE_HOUR, seven_day: SEVEN_DAY } });
  });

  it('passes input without rate limits through and writes nothing', () => {
    const { root } = setupTree();
    const input = Buffer.from(JSON.stringify({ session_id: 's' }));
    const io = run(input, root);
    expect(io.out).toEqual([input]);
    expect(io.err).toEqual([]);
    expect(existsSync(limitsFile(root))).toBe(false);
  });

  it('reports input that is not JSON and still passes it through', () => {
    const { root } = setupTree();
    const input = Buffer.from('not json');
    const io = run(input, root);
    expect(io.out).toEqual([input]);
    expect(io.err).toEqual(['claude-limits-tap: status line input is not JSON\n']);
    expect(existsSync(limitsFile(root))).toBe(false);
  });

  it('passes oversized input through without parsing it', () => {
    const { root } = setupTree();
    const input = Buffer.from(' '.repeat(MAX_INPUT_BYTES) + INPUT);
    const io = run(input, root);
    expect(io.out).toHaveLength(1);
    expect(io.out[0]).toBe(input);
    expect(io.err).toEqual([]);
    expect(existsSync(limitsFile(root))).toBe(false);
  });

  it('reports a failed write and still passes the input through', () => {
    const current = setupTree();
    const blocker = current.writeRaw('blocker', 'a file where the config folder should be');
    const input = Buffer.from(INPUT);
    const io = run(input, blocker);
    expect(io.out).toEqual([input]);
    expect(io.err).toHaveLength(1);
    expect(io.err[0]).toMatch(/^claude-limits-tap: /);
  });
});

describe('claude-limits-tap.mjs', () => {
  const spawnTap = (input: string, configDir: string, args: readonly string[] = []) =>
    spawnSync(process.execPath, [TAP, ...args], { input, env: { ...process.env, CLAUDE_CONFIG_DIR: configDir }, encoding: 'utf8' });

  it('passes the input through byte for byte and writes the file', () => {
    const { root } = setupTree();
    const input = `${INPUT}\n`;
    const result = spawnTap(input, root);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(input);
    expect(readJson(limitsFile(root))).toMatchObject({
      version: 1,
      windows: { five_hour: { used_percentage: 23 }, seven_day: { used_percentage: 41 } },
    });
  });

  it('prints the summary with --standalone', () => {
    const result = spawnTap(INPUT, setupTree().root, ['--standalone']);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('5h 23% · weekly 41%');
  });
});
