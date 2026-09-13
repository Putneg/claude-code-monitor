import { randomUUID } from 'node:crypto';
import type { UsageFilter } from '../../src/server/db/queries/filter-sql.js';
import type { Repos } from '../../src/server/db/repos.js';
import type { UsageRow } from '../../src/server/ingest/parser.js';
import { resolvePriceKey } from '../../src/server/pricing/resolve.js';
import type { PriceTable } from '../../src/server/pricing/types.js';

export const TEST_PRICES: PriceTable = {
  'claude-opus-5': { input: 5e-6, output: 2.5e-5, cacheWrite5m: 6.25e-6, cacheWrite1h: 1e-5, cacheRead: 5e-7, fastMultiplier: 2 },
  'claude-sonnet-5': { input: 2e-6, output: 1e-5, cacheWrite5m: 2.5e-6, cacheWrite1h: 4e-6, cacheRead: 2e-7, fastMultiplier: 1 },
  'claude-fable-5-1': { input: 1e-5, output: 5e-5, cacheWrite5m: 1.25e-5, cacheWrite1h: 2e-5, cacheRead: 2.5e-7, fastMultiplier: 1 },
};

export const ALPHA = '/home/dev/alpha';
export const BETA = '/home/dev/beta';

export function makeRow(overrides: Partial<UsageRow> = {}): UsageRow {
  return {
    messageId: `msg_${randomUUID()}`,
    requestId: 'req',
    kind: 'primary',
    seq: 0,
    sessionId: 'session-a',
    agentId: null,
    isSidechain: false,
    model: 'claude-opus-5',
    speed: 'standard',
    ts: Date.parse('2026-09-10T10:00:00Z'),
    localDay: '2026-09-10',
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    ...overrides,
  };
}

export interface SeedSession {
  readonly sessionId: string;
  readonly cwd: string | null;
  readonly title?: string;
}

export function seed(
  repos: Repos,
  input: { readonly rows: readonly UsageRow[]; readonly sessions?: readonly SeedSession[]; readonly prices?: PriceTable },
): void {
  const prices = input.prices ?? TEST_PRICES;
  const keys = Object.keys(prices);
  repos.prices.replaceAll(prices, 'snapshot', Date.parse('2026-09-01T00:00:00Z'));
  const models = [...new Set(input.rows.map((row) => row.model))];
  repos.prices.setMappings(
    models.map((model) => ({ model, priceKey: resolvePriceKey(model, keys) })),
    0,
  );
  input.rows.forEach((row) => repos.usage.upsert(row));
  (input.sessions ?? []).forEach((session) => {
    const ts = input.rows.find((row) => row.sessionId === session.sessionId)?.ts ?? 0;
    repos.sessions.touch({ sessionId: session.sessionId, cwd: session.cwd, isSidechain: false, ts });
    if (session.title) repos.sessions.setTitle(session.sessionId, session.title);
  });
}

const at = (iso: string) => ({ ts: Date.parse(iso), localDay: iso.slice(0, 10) });

export function seedScenario(repos: Repos): void {
  seed(repos, {
    rows: [
      makeRow({
        messageId: 'r1',
        sessionId: 'alpha-1',
        model: 'claude-opus-5',
        ...at('2026-09-10T10:00:00Z'),
        input: 1_000,
        output: 2_000,
        cacheRead: 10_000,
        cacheWrite5m: 100,
        cacheWrite1h: 200,
      }),
      makeRow({
        messageId: 'r2',
        sessionId: 'alpha-1',
        model: 'claude-sonnet-5',
        agentId: 'agent-1',
        isSidechain: true,
        ...at('2026-09-10T11:00:00Z'),
        output: 1_000,
      }),
      makeRow({
        messageId: 'r3',
        sessionId: 'beta-1',
        model: 'claude-fable-5-1',
        kind: 'advisor',
        seq: 1,
        ...at('2026-09-11T09:00:00Z'),
        input: 75_000,
        output: 2_000,
      }),
      makeRow({ messageId: 'r4', sessionId: 'beta-1', model: 'claude-mystery', ...at('2026-09-11T09:30:00Z'), output: 500 }),
      makeRow({ messageId: 'r5', sessionId: 'orphan-1', model: 'claude-sonnet-5', ...at('2026-09-09T08:00:00Z'), output: 100 }),
    ],
    sessions: [
      { sessionId: 'alpha-1', cwd: ALPHA, title: 'Alpha feature' },
      { sessionId: 'beta-1', cwd: BETA, title: 'Beta research' },
      { sessionId: 'orphan-1', cwd: null },
    ],
  });
}

export function range(from: string, to: string, extra: Partial<UsageFilter> = {}): UsageFilter {
  return { from, to, models: [], projects: [], ...extra };
}
