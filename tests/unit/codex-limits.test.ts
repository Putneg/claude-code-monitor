import { describe, expect, it } from 'vitest';
import { toCodexLimit } from '../../src/server/http/codex-limits.js';

describe('toCodexLimit', () => {
  it('lists the windows that are present, with ISO times', () => {
    expect(
      toCodexLimit({
        limitId: 'codex',
        planType: 'plus',
        primary: { usedPercent: 12.5, windowMinutes: 300, resetsAt: Date.parse('2026-09-10T15:00:00Z') },
        secondary: { usedPercent: 40, windowMinutes: 10_080, resetsAt: null },
        credits: { hasCredits: false, unlimited: false, balance: '0' },
        observedAt: Date.parse('2026-09-10T12:00:00Z'),
      }),
    ).toEqual({
      limitId: 'codex',
      planType: 'plus',
      windows: [
        { slot: 'primary', usedPercent: 12.5, windowMinutes: 300, resetsAt: '2026-09-10T15:00:00.000Z' },
        { slot: 'secondary', usedPercent: 40, windowMinutes: 10_080, resetsAt: null },
      ],
      credits: { hasCredits: false, unlimited: false, balance: '0' },
      observedAt: '2026-09-10T12:00:00.000Z',
    });
  });

  it('leaves out a missing primary window', () => {
    const limit = toCodexLimit({
      limitId: 'codex',
      planType: null,
      primary: null,
      secondary: { usedPercent: 1, windowMinutes: 60, resetsAt: null },
      credits: null,
      observedAt: 0,
    });
    expect(limit.windows.map((window) => window.slot)).toEqual(['secondary']);
    expect(limit.credits).toBeNull();
  });
});
