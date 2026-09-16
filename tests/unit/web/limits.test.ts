import { describe, expect, it } from 'vitest';
import type { CodexLimit } from '../../../src/shared/api.js';
import { limitViews, windowLabel } from '../../../src/web/lib/limits.js';

const NOW = '2026-09-16T08:13:00.000Z';

const limit = (overrides: Partial<CodexLimit> = {}): CodexLimit => ({
  limitId: 'codex',
  planType: 'prolite',
  windows: [
    { slot: 'primary', usedPercent: 66.4, windowMinutes: 10_080, resetsAt: '2026-09-18T09:30:00.000Z' },
    { slot: 'secondary', usedPercent: 1, windowMinutes: 300, resetsAt: '2026-09-16T12:21:00.000Z' },
  ],
  credits: { hasCredits: false, unlimited: false, balance: '0' },
  observedAt: '2026-09-16T08:12:00.000Z',
  ...overrides,
});

describe('windowLabel', () => {
  it.each([
    [300, '5h'],
    [60, '1h'],
    [10_080, 'weekly'],
    [1_440, '1d'],
    [4_320, '3d'],
    [90, '90m'],
  ])('%i minutes -> %s', (minutes, label) => {
    expect(windowLabel(minutes)).toBe(label);
  });
});

describe('limitViews', () => {
  it('builds the title, the reading time and one line per window', () => {
    expect(limitViews([limit()], NOW, 'UTC')).toEqual([
      {
        id: 'codex',
        title: 'codex limits · prolite',
        asOf: 'as of 08:12',
        windows: [
          { key: 'primary', label: 'weekly', bar: '▓▓▓▓▓▓▓░░░', percent: '66%', resets: 'resets 09-18 09:30', stale: false },
          { key: 'secondary', label: '5h', bar: '░░░░░░░░░░', percent: '1%', resets: 'resets 12:21', stale: false },
        ],
        credits: null,
      },
    ]);
  });

  it('marks a window whose reset time has passed as stale', () => {
    const view = limitViews(
      [limit({ windows: [{ slot: 'primary', usedPercent: 90, windowMinutes: 300, resetsAt: '2026-09-16T08:00:00.000Z' }] })],
      NOW,
      'UTC',
    );
    expect(view[0]?.windows).toEqual([
      { key: 'primary', label: '5h', bar: '░░░░░░░░░░', percent: '', resets: 'reset · no newer data', stale: true },
    ]);
  });

  it('leaves the reset text empty when Codex did not report one', () => {
    const view = limitViews([limit({ windows: [{ slot: 'primary', usedPercent: 10, windowMinutes: 60, resetsAt: null }] })], NOW, 'UTC');
    expect(view[0]?.windows[0]).toMatchObject({ resets: '', stale: false, percent: '10%' });
  });

  it('names a non-default limit and an older reading, and leaves out a missing plan', () => {
    const view = limitViews([limit({ limitId: 'premium', planType: null, observedAt: '2026-09-14T08:49:51.000Z' })], NOW, 'UTC');
    expect(view[0]).toMatchObject({ id: 'premium', title: 'codex limits · premium', asOf: 'as of 09-14 08:49' });
  });

  it('shows the time zone of the server', () => {
    expect(limitViews([limit()], NOW, 'Asia/Tokyo')[0]).toMatchObject({ asOf: 'as of 17:12' });
  });

  it.each([
    [{ hasCredits: false, unlimited: true, balance: null }, 'credits unlimited'],
    [{ hasCredits: true, unlimited: false, balance: '12.50' }, 'credits 12.50'],
    [{ hasCredits: true, unlimited: false, balance: null }, 'credits ?'],
    [{ hasCredits: false, unlimited: false, balance: '0' }, null],
    [null, null],
  ])('shows credits %j as %s', (credits, text) => {
    expect(limitViews([limit({ credits })], NOW, 'UTC')[0]?.credits).toBe(text);
  });
});
