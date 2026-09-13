// Acceptance test against your own Claude Code transcripts, read-only: `pnpm test:acceptance`. It never runs in CI.
// - It reads the first root in CLAUDE_PROJECTS_DIRS, or ~/.claude/projects, and is skipped when that directory does not exist.
// - It ingests into a temporary database and prints a summary of your own usage (files, rows, models, cost per model).
// - It compares the monitor's prices with the cost-state totals Claude Code writes into the transcripts. A failure there can
//   simply mean the embedded price snapshot is out of date: run `pnpm update-prices` before looking for a bug.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../src/server/db/connection.js';
import { migrate } from '../../src/server/db/migrations.js';
import { createRepos, type Repos } from '../../src/server/db/repos.js';
import { runIngestCycle, type CycleResult } from '../../src/server/ingest/ingestor.js';
import { readCompleteLines } from '../../src/server/ingest/reader.js';
import { scanSource } from '../../src/server/ingest/scanner.js';
import { createLogger } from '../../src/server/logger.js';
import { createPricingService } from '../../src/server/pricing/refresher.js';
import { resolvePriceKey } from '../../src/server/pricing/resolve.js';
import { PRICE_SNAPSHOT } from '../../src/server/pricing/snapshot.js';
import { StatusTracker } from '../../src/server/status.js';
import { createLocalDay } from '../../src/server/time.js';

const SOURCE = (process.env.CLAUDE_PROJECTS_DIRS ?? join(homedir(), '.claude', 'projects')).split(',')[0]!.trim();
const logger = createLogger('silent');

const WEB_SEARCH_USD = 0.01; // Anthropic web-search fee per request; token-based pricing (like ccusage) excludes it
const BOUND_TOLERANCE = 0.005;
const PAIR_EXEMPT_USD = 0.05;

interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
  webSearchRequests?: number;
}

interface CostState {
  sessionId: string;
  totalCostUSD: number;
  modelUsage: Record<string, ModelUsage>;
}

const isCostState = (value: unknown): value is CostState =>
  typeof value === 'object' &&
  value !== null &&
  (value as { type?: unknown }).type === 'cost-state' &&
  typeof (value as CostState).sessionId === 'string' &&
  typeof (value as CostState).totalCostUSD === 'number' &&
  typeof (value as CostState).modelUsage === 'object' &&
  (value as CostState).modelUsage !== null;

async function latestCostStates(root: string): Promise<CostState[]> {
  const scan = await scanSource(root);
  const latest = new Map<string, CostState>();
  let invalid = 0;
  for (const file of scan.files) {
    await readCompleteLines(file.path, 0, (raw) => {
      if (!raw.includes('"cost-state"')) return;
      let value: unknown;
      try {
        value = JSON.parse(raw.toString('utf8'));
      } catch {
        invalid += 1;
        return;
      }
      if (!isCostState(value)) return;
      const current = latest.get(value.sessionId);
      if (!current || value.totalCostUSD >= current.totalCostUSD) latest.set(value.sessionId, value);
    });
  }
  if (invalid > 0) console.info(`skipped ${invalid} unparsable cost-state lines`);
  return [...latest.values()];
}

function priceBounds(usage: ModelUsage, model: string): { lo: number; hi: number } | null {
  const key = resolvePriceKey(model, Object.keys(PRICE_SNAPSHOT.prices));
  const price = key === null ? undefined : PRICE_SNAPSHOT.prices[key];
  if (!price) return null;
  const base = usage.inputTokens * price.input + usage.outputTokens * price.output + usage.cacheReadInputTokens * price.cacheRead;
  return {
    lo: base + usage.cacheCreationInputTokens * price.cacheWrite5m,
    hi: base + usage.cacheCreationInputTokens * price.cacheWrite1h,
  };
}

describe.skipIf(!existsSync(SOURCE))('real transcripts', () => {
  let tmp: string;
  let db: Db;
  let repos: Repos;
  let first: CycleResult;
  const startedAt = Date.now();

  const cycle = () =>
    runIngestCycle({ db, repos, roots: [SOURCE], toLocalDay: createLocalDay('UTC'), status: new StatusTracker(), logger });

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'claude-code-monitor-acceptance-'));
    db = openDatabase(join(tmp, 'monitor.db'));
    migrate(db);
    repos = createRepos(db);
    const pricing = createPricingService({
      prices: repos.prices,
      fetchPayload: async () => {
        throw new Error('acceptance tests use the embedded snapshot');
      },
      snapshot: PRICE_SNAPSHOT,
      logger,
      now: Date.now,
      refreshMs: 1,
      retryMs: 1,
    });
    pricing.ensureLoaded();
    first = await cycle();
    pricing.ensureMapped(first.models);
  });

  afterAll(() => {
    db?.close();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('ingests usage rows from the transcripts', () => {
    expect(first.rows).toBeGreaterThan(0);
    expect(repos.usage.count()).toBeGreaterThan(0);
    console.info(
      `ingested ${first.files} files, ${repos.usage.count()} billing rows, skipped ${first.skipped}, models: ${[...first.models].sort().join(', ')}`,
    );
  });

  it('does not change existing rows on a second cycle', async () => {
    // A live Claude Code session may still append fuller copies of messages that started just before
    // the test; rows older than this cutoff are final and must be identical after a second cycle.
    const cutoff = startedAt - 15 * 60_000;
    const snapshot = () =>
      db
        .prepare(
          `SELECT COUNT(*) AS n, SUM(input + output + cache_read + cache_write_5m + cache_write_1h) AS tokens
           FROM usage WHERE ts < ?`,
        )
        .get(cutoff);
    const before = snapshot() as { n: number; tokens: number };
    expect(before.n).toBeGreaterThan(0);
    await cycle();
    expect(snapshot()).toEqual(before);
  });

  it('matches Claude Code cost-state prices per model', async () => {
    const states = await latestCostStates(SOURCE);
    const perModel = new Map<string, { cc: number; lo: number; hi: number }>();
    const pairFailures: string[] = [];
    const unpricedModels = new Set<string>();
    for (const state of states) {
      for (const [model, usage] of Object.entries(state.modelUsage)) {
        const bounds = priceBounds(usage, model);
        if (!bounds) {
          unpricedModels.add(model);
          continue;
        }
        const cc = usage.costUSD - (usage.webSearchRequests ?? 0) * WEB_SEARCH_USD;
        const acc = perModel.get(model) ?? { cc: 0, lo: 0, hi: 0 };
        perModel.set(model, { cc: acc.cc + cc, lo: acc.lo + bounds.lo, hi: acc.hi + bounds.hi });
        const inside = cc >= bounds.lo * (1 - BOUND_TOLERANCE) && cc <= bounds.hi * (1 + BOUND_TOLERANCE);
        if (!inside && cc > PAIR_EXEMPT_USD) {
          pairFailures.push(
            `${model} session ${state.sessionId.slice(0, 8)}: cc ${cc.toFixed(4)} not in [${bounds.lo.toFixed(4)}, ${bounds.hi.toFixed(4)}]`,
          );
        }
      }
    }
    if (unpricedModels.size > 0) {
      console.info(`skipped ${unpricedModels.size} unpriced models: ${[...unpricedModels].sort().join(', ')}`);
    }
    const modelFailures = [...perModel.entries()]
      .filter(([, v]) => v.cc < v.lo * (1 - BOUND_TOLERANCE) || v.cc > v.hi * (1 + BOUND_TOLERANCE))
      .map(([model, v]) => `${model}: cc ${v.cc.toFixed(2)} not in [${v.lo.toFixed(2)}, ${v.hi.toFixed(2)}]`);
    console.info(
      [...perModel.entries()].map(([m, v]) => `${m}: cc $${v.cc.toFixed(2)} in [$${v.lo.toFixed(2)}, $${v.hi.toFixed(2)}]`).join('\n'),
    );
    expect(states.length).toBeGreaterThan(0);
    expect(modelFailures).toEqual([]);
    expect(pairFailures).toEqual([]);
  });
});
