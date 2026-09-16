import type { OverviewResponse, OverviewSeries, StatusResponse } from '../../../src/shared/api.js';

export function makeStatus(overrides: Partial<StatusResponse> = {}): StatusResponse {
  return {
    now: '2026-09-11T12:00:00.000Z',
    today: '2026-09-11',
    tz: 'UTC',
    sync: {
      state: 'idle',
      lastSyncAt: '2026-09-11T11:59:00.000Z',
      lastChangeAt: '2026-09-11T11:59:00.000Z',
      lastDurationMs: 40,
      skippedLines: 0,
      droppedIterations: 0,
      usageMismatches: 0,
    },
    backfill: { active: false, filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0 },
    sources: [{ path: '/claude/projects', ok: true, files: 3, bytes: 4_096, error: null, client: 'claude', required: true, present: true }],
    pricing: { source: 'litellm', fetchedAt: '2026-09-11T06:00:00.000Z', unpricedModels: [] },
    data: { firstDay: '2026-08-01', lastDay: '2026-09-11', rows: 10 },
    codexLimits: [],
    ...overrides,
  };
}

/** Three day buckets, two models. Bucket totals: $3, $5, $0 and 150, 1100, 0 tokens. */
export const SERIES: OverviewSeries = {
  stack: 'model',
  buckets: ['2026-03-01', '2026-03-02', '2026-03-03'],
  keys: [
    { key: 'claude-opus-5', label: 'opus-5', color: '#FFB000' },
    { key: 'claude-sonnet-5', label: 'sonnet-5', color: '#8BD450' },
  ],
  cost: [
    [1, 4, 0],
    [2, 1, 0],
  ],
  tokens: [
    [100, 400, 0],
    [50, 700, 0],
  ],
};

export function makeOverview(overrides: Partial<OverviewResponse> = {}): OverviewResponse {
  return {
    range: { from: '2026-03-01', to: '2026-03-03', days: 3, bucket: 'day' },
    totals: {
      cost: { input: 0.5, output: 3, cacheRead: 3, cacheWrite: 1.5, webSearch: 0, total: 8 },
      tokens: { input: 100, output: 150, cacheRead: 900, cacheWrite5m: 50, cacheWrite1h: 50 },
      tokensTotal: 1_250,
      avgCostPerDay: 8 / 3,
      peak: { bucket: '2026-03-02', cost: 5 },
      prevPeriodCost: 4,
      sessions: 3,
      projects: 2,
      subagentCost: 2,
      advisorCost: 0.4,
      webSearchRequests: 0,
      webFetchRequests: 0,
    },
    series: SERIES,
    byModel: [],
    byProject: [],
    byClient: [{ client: 'claude', label: 'claude code', color: '#FFB000', tokensTotal: 1_250, cost: 8, share: 1 }],
    ...overrides,
  };
}
