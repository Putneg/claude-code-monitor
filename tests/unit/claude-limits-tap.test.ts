import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultLimitsPath,
  mergeWindow,
  mergeWindows,
  shouldWrite,
  summaryLine,
  windowsFromFile,
  windowsFromInput,
} from '../../scripts/claude-limits-tap-core.mjs';

const NOW = 1_789_990_000;
const reading = (used: number, resets: number, observed = NOW) => ({ used_percentage: used, resets_at: resets, observed_at: observed });

describe('windowsFromInput', () => {
  it('reads the five-hour, weekly and spend windows', () => {
    const input = {
      session_id: 's',
      rate_limits: {
        five_hour: { used_percentage: 23.5, resets_at: 1_790_000_000 },
        seven_day: { used_percentage: 41, resets_at: 1_790_500_000 },
        spend_limit: { used_percentage: 130, resets_at: 1_791_000_000 },
      },
    };
    expect(windowsFromInput(input, NOW)).toEqual({
      five_hour: reading(23.5, 1_790_000_000),
      seven_day: reading(41, 1_790_500_000),
      spend_limit: reading(130, 1_791_000_000),
    });
  });

  it('returns no windows when rate_limits is absent or not an object', () => {
    expect(windowsFromInput({ session_id: 's' }, NOW)).toEqual({});
    expect(windowsFromInput({ rate_limits: [1] }, NOW)).toEqual({});
    expect(windowsFromInput(null, NOW)).toEqual({});
  });

  it('skips windows without a usable percentage or reset time, and unknown windows', () => {
    const input = {
      rate_limits: {
        five_hour: { used_percentage: -1, resets_at: 1_790_000_000 },
        seven_day: { used_percentage: '41', resets_at: 1_790_500_000 },
        spend_limit: { used_percentage: 5, resets_at: 0 },
        seven_day_opus: { used_percentage: 5, resets_at: 1_790_500_000 },
      },
    };
    expect(windowsFromInput(input, NOW)).toEqual({});
    expect(windowsFromInput({ rate_limits: { five_hour: { used_percentage: null, resets_at: 1_790_000_000 } } }, NOW)).toEqual({});
  });

  it('drops the fraction of a reset time', () => {
    expect(windowsFromInput({ rate_limits: { five_hour: { used_percentage: 1, resets_at: 1_790_000_000.9 } } }, NOW)).toEqual({
      five_hour: reading(1, 1_790_000_000),
    });
  });

  it('skips readings outside the bounds the server accepts', () => {
    const input = {
      rate_limits: {
        five_hour: { used_percentage: 10_001, resets_at: 1_790_000_000 },
        seven_day: { used_percentage: 1, resets_at: 1_790_000_000_000 },
        spend_limit: { used_percentage: 1, resets_at: 999_999_999 },
      },
    };
    expect(windowsFromInput(input, NOW)).toEqual({});
  });
});

describe('mergeWindow', () => {
  const stored = reading(40, 1_790_000_000, NOW - 600);

  it('takes the incoming reading when nothing is stored', () => {
    expect(mergeWindow(undefined, reading(10, 1_790_000_000))).toEqual(reading(10, 1_790_000_000));
  });

  it('keeps the higher usage, the later reset and the newer observation within one window', () => {
    expect(mergeWindow(stored, reading(35, 1_790_000_030))).toEqual(reading(40, 1_790_000_030, NOW));
    expect(mergeWindow(stored, reading(45, 1_789_999_970))).toEqual(reading(45, 1_790_000_000, NOW));
  });

  it('takes a new window even when its usage is lower', () => {
    expect(mergeWindow(stored, reading(2, 1_790_018_000))).toEqual(reading(2, 1_790_018_000));
  });

  it('ignores a reading from an older window', () => {
    expect(mergeWindow(stored, reading(90, 1_789_982_000))).toEqual(stored);
  });
});

describe('mergeWindows', () => {
  it('merges each incoming window and keeps the stored windows the input left out', () => {
    const stored = { five_hour: reading(40, 1_790_000_000, NOW - 600), seven_day: reading(50, 1_790_500_000, NOW - 600) };
    expect(mergeWindows(stored, { five_hour: reading(45, 1_790_000_000) })).toEqual({
      five_hour: reading(45, 1_790_000_000),
      seven_day: reading(50, 1_790_500_000, NOW - 600),
    });
  });

  it('leaves its inputs unchanged', () => {
    const stored = { five_hour: reading(40, 1_790_000_000, NOW - 600) };
    mergeWindows(stored, { five_hour: reading(45, 1_790_000_000) });
    expect(stored).toEqual({ five_hour: reading(40, 1_790_000_000, NOW - 600) });
  });
});

describe('shouldWrite', () => {
  const stored = { five_hour: reading(40, 1_790_000_000, NOW - 30) };

  it('writes a first reading', () => {
    expect(shouldWrite({}, stored)).toBe(true);
  });

  it('writes when a usage, a reset time or the set of windows changed', () => {
    expect(shouldWrite(stored, { five_hour: reading(41, 1_790_000_000, NOW - 30) })).toBe(true);
    expect(shouldWrite(stored, { five_hour: reading(40, 1_790_000_030, NOW - 30) })).toBe(true);
    expect(shouldWrite(stored, { ...stored, seven_day: reading(1, 1_790_500_000, NOW - 30) })).toBe(true);
  });

  it('rewrites an unchanged reading only once its newest observation is a minute newer', () => {
    expect(shouldWrite(stored, { five_hour: reading(40, 1_790_000_000, NOW + 29) })).toBe(false);
    expect(shouldWrite(stored, { five_hour: reading(40, 1_790_000_000, NOW + 30) })).toBe(true);
  });
});

describe('windowsFromFile', () => {
  const windows = { five_hour: reading(40, 1_790_000_000), seven_day: reading(50, 1_790_500_000) };

  it('reads a version 1 file', () => {
    expect(windowsFromFile(JSON.stringify({ version: 1, windows }))).toEqual(windows);
  });

  it('drops malformed and unknown windows', () => {
    const text = JSON.stringify({
      version: 1,
      windows: {
        five_hour: { used_percentage: 40, resets_at: 1.5, observed_at: NOW },
        seven_day: windows.seven_day,
        other: reading(1, 1, 1),
      },
    });
    expect(windowsFromFile(text)).toEqual({ seven_day: windows.seven_day });
  });

  it.each(['', 'not json', '[]', JSON.stringify({ version: 2, windows }), JSON.stringify({ version: 1 })])('treats %j as empty', (text) => {
    expect(windowsFromFile(text)).toEqual({});
  });

  it('drops a stored window outside the bounds the server accepts', () => {
    const text = JSON.stringify({
      version: 1,
      windows: { five_hour: reading(40, 1_790_000_000_000), seven_day: reading(10_001, 1_790_500_000) },
    });
    expect(windowsFromFile(text)).toEqual({});
  });
});

describe('summaryLine', () => {
  it('lists the windows in display order with rounded percentages', () => {
    expect(summaryLine({ seven_day: reading(41.6, 1), five_hour: reading(23.4, 1), spend_limit: reading(130, 1) })).toBe(
      '5h 23% · weekly 42% · spend 130%',
    );
  });

  it('is empty without windows', () => {
    expect(summaryLine({})).toBe('');
  });
});

describe('defaultLimitsPath', () => {
  it('uses CLAUDE_CONFIG_DIR, else ~/.claude', () => {
    const home = join(homedir(), '.claude', 'claude-code-monitor', 'rate-limits.json');
    expect(defaultLimitsPath({ CLAUDE_CONFIG_DIR: ' /cfg ' })).toBe(join('/cfg', 'claude-code-monitor', 'rate-limits.json'));
    expect(defaultLimitsPath({ CLAUDE_CONFIG_DIR: '  ' })).toBe(home);
    expect(defaultLimitsPath({})).toBe(home);
  });
});
