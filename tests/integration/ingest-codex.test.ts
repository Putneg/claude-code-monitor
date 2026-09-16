import { mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runIngestCycle, type IngestDeps } from '../../src/server/ingest/ingestor.js';
import { claudeRoot, codexRoot } from '../../src/server/ingest/sources.js';
import { createLogger } from '../../src/server/logger.js';
import { StatusTracker } from '../../src/server/status.js';
import { createLocalDay } from '../../src/server/time.js';
import { sessionMetaLine, tokenCountLine, turnContextLine, usageRecordLine } from '../helpers/codex-records.js';
import { createTestDb } from '../helpers/db.js';
import { assistantLine } from '../helpers/records.js';
import { createTree, type Tree } from '../helpers/tree.js';

const NOW = Date.parse('2026-09-11T00:00:00Z');
const MAIN = 'codex/sessions/2026/09/10/rollout-2026-09-10T10-00-00-cx-main.jsonl';
const GUARD = 'codex/sessions/2026/09/10/rollout-2026-09-10T10-05-00-cx-guard.jsonl';
const IMPORTED = 'codex/sessions/2026/09/10/rollout-2026-09-10T09-00-00-cx-imported.jsonl';
const ARCHIVED_MAIN = 'codex/archived_sessions/rollout-2026-09-10T10-00-00-cx-main.jsonl';

const at = (minute: number): string => `2026-09-10T10:${String(minute).padStart(2, '0')}:00.000Z`;
const resetsAt = Date.parse('2026-09-10T15:00:00Z') / 1_000;

const mainHead = [
  sessionMetaLine({ id: 'cx-main', timestamp: at(0) }),
  turnContextLine({ turnId: 't1', model: 'gpt-5.6-sol', timestamp: at(1) }),
];
const mainRecord = usageRecordLine({
  responseId: 'resp_1',
  threadId: 'cx-main',
  turnId: 't1',
  timestamp: at(2),
  input: 1_000,
  cached: 600,
  output: 50,
});
const mainLimits = tokenCountLine({
  timestamp: at(2),
  totalTokens: 1_050,
  rateLimits: { primary: { usedPercent: 10, windowMinutes: 300, resetsAt } },
});
const guardLines = [
  sessionMetaLine({ id: 'cx-guard', sessionId: 'cx-main', subagent: true, timestamp: at(5) }),
  tokenCountLine({ timestamp: at(5), totalTokens: 9_000_000 }),
  turnContextLine({ turnId: 'g1', model: 'codex-auto-review', timestamp: at(5) }),
  usageRecordLine({
    responseId: 'resp_g',
    threadId: 'cx-guard',
    sessionId: 'cx-main',
    turnId: 'g1',
    timestamp: at(6),
    input: 300,
    output: 7,
  }),
];
const importedLines = [sessionMetaLine({ id: 'cx-imported', timestamp: at(0) }), tokenCountLine({ timestamp: at(0), totalTokens: 20_932 })];

let tree: Tree;
afterEach(() => tree.cleanup());

function setup(overrides: Partial<IngestDeps> = {}) {
  tree = createTree();
  const { db, repos } = createTestDb();
  const status = new StatusTracker(() => NOW);
  const deps: IngestDeps = {
    db,
    repos,
    roots: [claudeRoot(tree.path('claude')), codexRoot(tree.path('codex/sessions')), codexRoot(tree.path('codex/archived_sessions'))],
    toLocalDay: createLocalDay('UTC'),
    status,
    logger: createLogger('silent'),
    now: () => NOW,
    ...overrides,
  };
  const rows = () =>
    db
      .prepare(
        `SELECT message_id, client, session_id, agent_id, is_sidechain, model, input, output, cache_read
         FROM usage ORDER BY message_id`,
      )
      .all() as Record<string, unknown>[];
  const stateOf = (rel: string): string | null => repos.files.all().get(tree.path(rel))?.parserState ?? null;
  return { db, repos, status, rows, stateOf, run: (extra: Partial<IngestDeps> = {}) => runIngestCycle({ ...deps, ...extra }) };
}

describe('Codex ingest', () => {
  it('ingests a main thread and a guardian subagent, and nothing from an imported session', async () => {
    const { run, rows, repos, status, stateOf } = setup();
    tree.write(MAIN, [...mainHead, mainRecord, mainLimits]);
    tree.write(GUARD, guardLines);
    tree.write(IMPORTED, importedLines);
    const result = await run();
    expect(result.rows).toBe(2);
    expect(rows()).toEqual([
      {
        message_id: 'resp_1',
        client: 'codex',
        session_id: 'cx-main',
        agent_id: null,
        is_sidechain: 0,
        model: 'gpt-5.6-sol',
        input: 400,
        output: 50,
        cache_read: 600,
      },
      {
        message_id: 'resp_g',
        client: 'codex',
        session_id: 'cx-main',
        agent_id: 'cx-guard',
        is_sidechain: 1,
        model: 'codex-auto-review',
        input: 300,
        output: 7,
        cache_read: 0,
      },
    ]);
    expect(repos.sessions.get('cx-main')).toMatchObject({ projectPath: '/home/dev/gamma', projectSource: 'main' });
    expect(repos.sessions.get('cx-imported')).toBeUndefined();
    expect(repos.codexLimits.all()).toEqual([
      expect.objectContaining({ limitId: 'codex', primary: { usedPercent: 10, windowMinutes: 300, resetsAt: resetsAt * 1_000 } }),
    ]);
    expect(JSON.parse(stateOf(MAIN) ?? 'null')).toMatchObject({ model: 'gpt-5.6-sol', cwd: '/home/dev/gamma' });
    expect(result.models).toEqual(new Set(['gpt-5.6-sol', 'codex-auto-review']));
    expect(status.snapshot().sources.map((source) => [source.client, source.required, source.present, source.ok])).toEqual([
      ['claude', true, false, false],
      ['codex', false, true, true],
      ['codex', false, false, false],
    ]);
  });

  it('resolves the model of a record whose turn_context was read in an earlier cycle', async () => {
    const { run, rows, stateOf } = setup();
    tree.write(MAIN, mainHead);
    await run();
    expect(rows()).toEqual([]);
    expect(stateOf(MAIN)).not.toBeNull();
    tree.write(MAIN, [mainRecord], { append: true });
    await run();
    expect(rows()).toEqual([expect.objectContaining({ message_id: 'resp_1', model: 'gpt-5.6-sol' })]);
  });

  it('reads a Codex file again from the start when its stored parser state is unusable', async () => {
    const logger = createLogger('silent');
    const info = vi.spyOn(logger, 'info');
    const { run, rows, repos, stateOf } = setup({ logger });
    tree.write(MAIN, [...mainHead, mainRecord]);
    await run();
    const stored = repos.files.all().get(tree.path(MAIN));
    if (!stored) throw new Error('expected a stored file state');
    repos.files.upsert({ ...stored, parserState: 'garbage' });
    tree.write(MAIN, [usageRecordLine({ responseId: 'resp_2', threadId: 'cx-main', turnId: 't1', timestamp: at(9), output: 1 })], {
      append: true,
    });
    await run();
    expect(rows().map((row) => [row.message_id, row.model])).toEqual([
      ['resp_1', 'gpt-5.6-sol'],
      ['resp_2', 'gpt-5.6-sol'],
    ]);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ offset: stored.offset }),
      'transcript parser state is missing or invalid; reading the file again from the start',
    );
    expect(JSON.parse(stateOf(MAIN) ?? 'null')).toMatchObject({ model: 'gpt-5.6-sol' });
  });

  it('counts a file that Codex moved to archived_sessions once', async () => {
    const { run, rows, repos } = setup();
    tree.write(MAIN, [...mainHead, mainRecord]);
    tree.write(GUARD, guardLines);
    await run();
    mkdirSync(dirname(tree.path(ARCHIVED_MAIN)), { recursive: true });
    renameSync(tree.path(MAIN), tree.path(ARCHIVED_MAIN));
    await run();
    expect(rows()).toHaveLength(2);
    const paths = [...repos.files.all().keys()];
    expect(paths).toContain(tree.path(ARCHIVED_MAIN));
    expect(paths).not.toContain(tree.path(MAIN));
  });

  it('keeps Claude and Codex rows apart in one cycle and stores no parser state for Claude files', async () => {
    const { run, db, stateOf } = setup();
    tree.write('claude/-home-dev-alpha/s1.jsonl', [
      assistantLine({ messageId: 'm1', model: 'claude-opus-5', sessionId: 's1', timestamp: at(3), usage: { output: 5 } }),
    ]);
    tree.write(MAIN, [...mainHead, mainRecord]);
    await run();
    expect(db.prepare('SELECT client, COUNT(*) AS n FROM usage GROUP BY client ORDER BY client').all()).toEqual([
      { client: 'claude', n: 1 },
      { client: 'codex', n: 1 },
    ]);
    expect(stateOf('claude/-home-dev-alpha/s1.jsonl')).toBeNull();
  });

  it('keeps the newest rate-limit reading when an older file is read later', async () => {
    const { run, repos } = setup();
    const newer = tokenCountLine({
      timestamp: '2026-09-10T11:00:00.000Z',
      rateLimits: { primary: { usedPercent: 50, windowMinutes: 300 } },
    });
    const older = tokenCountLine({
      timestamp: '2026-09-10T10:00:00.000Z',
      rateLimits: { primary: { usedPercent: 20, windowMinutes: 300 } },
    });
    tree.write('codex/sessions/a.jsonl', [newer]);
    tree.write('codex/sessions/b.jsonl', [older]);
    // Files are read oldest mtime first, so the file with the newer reading is read first.
    tree.setMtime('codex/sessions/a.jsonl', new Date('2026-09-10T09:00:00Z'));
    tree.setMtime('codex/sessions/b.jsonl', new Date('2026-09-10T12:00:00Z'));
    await run();
    expect(repos.codexLimits.all().map((snapshot) => snapshot.primary?.usedPercent)).toEqual([50]);
  });

  it('counts a record without a known model as a skipped line', async () => {
    const { run, rows, status } = setup();
    tree.write(MAIN, [sessionMetaLine({ id: 'cx-main' }), mainRecord]);
    const result = await run();
    expect(rows()).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(status.snapshot().sync.skippedLines).toBe(1);
  });
});
