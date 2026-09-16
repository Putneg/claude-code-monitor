import { describe, expect, it } from 'vitest';
import type { CodexLimitSnapshot } from '../../src/server/db/codex-limits-repo.js';
import { createTestDb } from '../helpers/db.js';

const snapshot = (overrides: Partial<CodexLimitSnapshot> = {}): CodexLimitSnapshot => ({
  limitId: 'codex',
  planType: 'plus',
  primary: { usedPercent: 12.5, windowMinutes: 300, resetsAt: Date.parse('2026-09-10T15:00:00Z') },
  secondary: { usedPercent: 40, windowMinutes: 10_080, resetsAt: null },
  credits: { hasCredits: false, unlimited: false, balance: '0' },
  observedAt: Date.parse('2026-09-10T12:00:00Z'),
  ...overrides,
});

describe('codex limits repo', () => {
  it('stores a snapshot and reads it back', () => {
    const { repos } = createTestDb();
    repos.codexLimits.upsert(snapshot());
    expect(repos.codexLimits.all()).toEqual([snapshot()]);
  });

  it('keeps the newer snapshot when an older one arrives later', () => {
    const { repos } = createTestDb();
    const newer = snapshot({
      primary: { usedPercent: 80, windowMinutes: 300, resetsAt: null },
      observedAt: Date.parse('2026-09-10T13:00:00Z'),
    });
    repos.codexLimits.upsert(newer);
    repos.codexLimits.upsert(snapshot());
    expect(repos.codexLimits.all()).toEqual([newer]);
  });

  it('keeps the stored snapshot when another one has the same time', () => {
    const { repos } = createTestDb();
    repos.codexLimits.upsert(snapshot());
    repos.codexLimits.upsert(snapshot({ planType: 'pro' }));
    expect(repos.codexLimits.all()[0]?.planType).toBe('plus');
  });

  it('replaces the whole snapshot with a newer one, clearing windows and credits it no longer has', () => {
    const { repos } = createTestDb();
    repos.codexLimits.upsert(snapshot());
    const next = snapshot({ planType: null, secondary: null, credits: null, observedAt: Date.parse('2026-09-11T00:00:00Z') });
    repos.codexLimits.upsert(next);
    expect(repos.codexLimits.all()).toEqual([next]);
  });

  it('lists snapshots by limit id', () => {
    const { repos } = createTestDb();
    repos.codexLimits.upsert(snapshot({ limitId: 'premium' }));
    repos.codexLimits.upsert(snapshot({ limitId: 'codex' }));
    expect(repos.codexLimits.all().map((item) => item.limitId)).toEqual(['codex', 'premium']);
  });
});
