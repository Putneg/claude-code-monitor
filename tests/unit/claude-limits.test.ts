import { describe, expect, it } from 'vitest';
import { parseClaudeLimits } from '../../src/server/limits/claude-limits.js';

const window = (used: number, resets: number, observed: number) => ({ used_percentage: used, resets_at: resets, observed_at: observed });
const file = (windows: Record<string, unknown>, version: unknown = 1): string => JSON.stringify({ version, windows });
const iso = (sec: number): string => new Date(sec * 1000).toISOString();

describe('parseClaudeLimits', () => {
  it('orders the windows, converts seconds to ISO and takes the newest observation', () => {
    const text = file({
      spend_limit: window(130, 1_791_000_000, 1_789_980_000),
      five_hour: window(23.5, 1_790_000_000, 1_789_990_000),
      seven_day: window(41, 1_790_500_000, 1_789_985_000),
    });
    expect(parseClaudeLimits(text)).toEqual({
      ok: true,
      limit: {
        windows: [
          { kind: 'five_hour', usedPercent: 23.5, resetsAt: iso(1_790_000_000) },
          { kind: 'seven_day', usedPercent: 41, resetsAt: iso(1_790_500_000) },
          { kind: 'spend_limit', usedPercent: 130, resetsAt: iso(1_791_000_000) },
        ],
        observedAt: iso(1_789_990_000),
      },
    });
  });

  it('gives no reading for a file without windows', () => {
    expect(parseClaudeLimits(file({}))).toEqual({ ok: true, limit: null });
  });

  it('ignores unknown fields and windows', () => {
    const text = JSON.stringify({
      version: 1,
      extra: true,
      windows: { five_hour: { ...window(1, 1_790_000_000, 1_789_990_000), x: 1 }, other: {} },
    });
    expect(parseClaudeLimits(text)).toMatchObject({ ok: true, limit: { windows: [{ kind: 'five_hour', usedPercent: 1 }] } });
  });

  it('reports text that is not JSON', () => {
    expect(parseClaudeLimits('{')).toEqual({ ok: false, reason: 'not JSON' });
  });

  it.each([
    ['a wrong version', file({}, 2)],
    ['a negative percentage', file({ five_hour: window(-1, 1_790_000_000, 1_789_990_000) })],
    ['a percentage above the cap', file({ five_hour: window(10_001, 1_790_000_000, 1_789_990_000) })],
    ['a fractional reset time', file({ five_hour: window(1, 1_790_000_000.5, 1_789_990_000) })],
    ['a reset time in milliseconds', file({ five_hour: window(1, 1_790_000_000_000, 1_789_990_000) })],
    [
      'a missing observation time',
      JSON.stringify({ version: 1, windows: { five_hour: { used_percentage: 1, resets_at: 1_790_000_000 } } }),
    ],
  ])('rejects %s and names the field, not its value', (_name, text) => {
    const result = parseClaudeLimits(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toMatch(/\d{4,}/);
  });

  it('names the invalid field', () => {
    expect(parseClaudeLimits(file({ five_hour: window(-1, 1_790_000_000, 1_789_990_000) }))).toEqual({
      ok: false,
      reason: 'invalid fields: windows.five_hour.used_percentage',
    });
  });
});
