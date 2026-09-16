import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryTotals } from '../../src/server/db/queries/totals.js';
import { runIngestCycle, type IngestDeps } from '../../src/server/ingest/ingestor.js';
import { FINGERPRINT_BYTES, readFingerprint } from '../../src/server/ingest/fingerprint.js';
import { createNotices } from '../../src/server/ingest/notices.js';
import type { RootScan } from '../../src/server/ingest/scanner.js';
import { claudeRoot, codexRoot } from '../../src/server/ingest/sources.js';
import { createLogger } from '../../src/server/logger.js';
import { StatusTracker } from '../../src/server/status.js';
import { createLocalDay } from '../../src/server/time.js';
import { createTestDb } from '../helpers/db.js';
import { assistantLine, titleLine, userLine } from '../helpers/records.js';
import { range } from '../helpers/seed.js';
import { createTree, type Tree } from '../helpers/tree.js';

let tree: Tree;
afterEach(() => tree.cleanup());

function setup(overrides: Partial<IngestDeps> = {}) {
  tree = createTree();
  const { db, repos } = createTestDb();
  const status = new StatusTracker(() => Date.parse('2026-09-11T00:00:00Z'));
  const deps: IngestDeps = {
    db,
    repos,
    roots: [claudeRoot(tree.root)],
    toLocalDay: createLocalDay('UTC'),
    status,
    logger: createLogger('silent'),
    now: () => Date.parse('2026-09-11T00:00:00Z'),
    ...overrides,
  };
  const rows = () =>
    db
      .prepare('SELECT message_id, kind, session_id, agent_id, is_sidechain, model, output FROM usage ORDER BY message_id, kind')
      .all() as Record<string, unknown>[];
  return { db, repos, status, deps, rows, run: () => runIngestCycle(deps) };
}

const line = (id: string, overrides: Partial<Parameters<typeof assistantLine>[0]> = {}) =>
  assistantLine({
    messageId: id,
    model: 'claude-opus-5',
    sessionId: 's1',
    timestamp: '2026-09-10T10:00:00.000Z',
    cwd: '/home/dev/alpha',
    usage: { output: 100, cacheRead: 1_000 },
    ...overrides,
  });

describe('runIngestCycle', () => {
  it('advances lastChangeAt only for cycles that read transcript files', async () => {
    let now = Date.parse('2026-09-11T00:00:00Z');
    const status = new StatusTracker(() => now);
    const { run } = setup({ status });
    tree.write('-home-dev-alpha/s1.jsonl', [line('m1')]);
    await run();
    expect(status.snapshot().sync.lastChangeAt).toBe('2026-09-11T00:00:00.000Z');

    now += 60_000;
    await run();
    expect(status.snapshot().sync).toMatchObject({
      lastSyncAt: '2026-09-11T00:01:00.000Z',
      lastChangeAt: '2026-09-11T00:00:00.000Z',
    });

    now += 60_000;
    tree.write('-home-dev-alpha/s1.jsonl', [line('m2')], { append: true });
    await run();
    expect(status.snapshot().sync.lastChangeAt).toBe('2026-09-11T00:02:00.000Z');
  });

  it('ingests main and subagent transcripts with titles and projects', async () => {
    const { run, rows, repos, status } = setup();
    tree.write('-home-dev-alpha/s1.jsonl', [userLine('s1', 'hello'), line('m1'), titleLine('s1', 'Alpha feature')]);
    tree.write('-home-dev-alpha/s1/subagents/agent-a1.jsonl', [
      line('m2', { model: 'claude-sonnet-5', cwd: '/home/dev/alpha/sub', isSidechain: true, agentId: 'a1', usage: { output: 50 } }),
    ]);
    const result = await run();
    expect(result).toMatchObject({ files: 2, rows: 2, skipped: 0, backfill: true });
    expect([...result.models].sort()).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    expect(rows()).toEqual([
      { message_id: 'm1', kind: 'primary', session_id: 's1', agent_id: null, is_sidechain: 0, model: 'claude-opus-5', output: 100 },
      { message_id: 'm2', kind: 'primary', session_id: 's1', agent_id: 'a1', is_sidechain: 1, model: 'claude-sonnet-5', output: 50 },
    ]);
    expect(repos.sessions.get('s1')).toMatchObject({ projectPath: '/home/dev/alpha', projectSource: 'main', title: 'Alpha feature' });
    expect(status.snapshot().backfill).toMatchObject({ active: false, filesDone: 2, filesTotal: 2 });
    expect(status.snapshot().sources).toEqual([
      { path: tree.root, ok: true, files: 2, bytes: expect.any(Number), error: null, client: 'claude', required: true, present: true },
    ]);
  });

  it('is idempotent when nothing changed', async () => {
    const { run, rows } = setup();
    tree.write('p/s1.jsonl', [line('m1')]);
    await run();
    const before = rows();
    const second = await run();
    expect(second).toMatchObject({ files: 0, rows: 0, backfill: false });
    expect(rows()).toEqual(before);
  });

  it('keeps only the fullest streaming copy of a message', async () => {
    const { run, rows } = setup();
    tree.write('p/s1.jsonl', [line('m1', { usage: { output: 10 } }), line('m1', { usage: { output: 500 } })]);
    await run();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.output).toBe(500);
  });

  it('reads only appended bytes on the next cycle', async () => {
    const { run, rows, repos } = setup();
    const file = tree.write('p/s1.jsonl', [line('m1')]);
    await run();
    tree.write('p/s1.jsonl', [line('m2')], { append: true });
    const second = await run();
    expect(second).toMatchObject({ files: 1, rows: 1, backfill: false });
    expect(rows()).toHaveLength(2);
    const stateAfter = repos.files.all().get(file);
    expect(stateAfter?.offset).toBe(stateAfter?.size);
  });

  it('waits for an unterminated last line to be completed', async () => {
    const { run, rows } = setup();
    tree.write('p/s1.jsonl', [line('m1'), line('m2')], { trailingNewline: false });
    await run();
    expect(rows().map((r) => r.message_id)).toEqual(['m1']);
    tree.writeRaw('p/s1.jsonl', '\n', { append: true });
    await run();
    expect(rows().map((r) => r.message_id)).toEqual(['m1', 'm2']);
  });

  it('re-reads a rewritten (shrunk) file from the start without duplicates', async () => {
    const { run, rows, repos } = setup();
    const file = tree.write('p/s1.jsonl', [line('m1'), line('m2'), line('m3')]);
    await run();
    tree.write('p/s1.jsonl', [line('m1')]);
    await run();
    expect(rows()).toHaveLength(3);
    expect(repos.files.all().get(file)?.offset).toBe(Buffer.byteLength(`${line('m1')}\n`));
  });

  it('reads a replaced file again from the start when its head changed', async () => {
    const { run, rows, repos } = setup();
    const file = tree.write('p/s1.jsonl', [line('m1')]);
    await run();
    expect(repos.files.all().get(file)?.fingerprint).toMatch(/^\d+:[0-9a-f]{16}$/);
    // Same path, a new first line and more bytes: resuming at the old offset would skip m2.
    tree.write('p/s1.jsonl', [line('m2'), line('m3')]);
    await run();
    expect(rows().map((row) => row.message_id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('reads a same-size replacement from the start', async () => {
    const { run, rows } = setup();
    tree.write('p/s1.jsonl', [line('m1')]);
    tree.setMtime('p/s1.jsonl', new Date('2026-09-10T00:00:00Z'));
    await run();
    tree.write('p/s1.jsonl', [line('m2')]);
    tree.setMtime('p/s1.jsonl', new Date('2026-09-10T00:01:00Z'));
    await run();
    expect(rows().map((row) => row.message_id)).toEqual(['m1', 'm2']);
  });

  it('resumes a file stored without a fingerprint and stores one', async () => {
    const { run, repos } = setup();
    const file = tree.write('p/s1.jsonl', [line('m1')]);
    await run();
    const stored = repos.files.all().get(file);
    if (stored === undefined) throw new Error('the first cycle stored no file state');
    repos.files.upsert({ ...stored, fingerprint: null });
    tree.write('p/s1.jsonl', [line('m2')], { append: true });
    const second = await run();
    expect(second.rows).toBe(1);
    expect(repos.files.all().get(file)?.fingerprint).toMatch(/^\d+:[0-9a-f]{16}$/);
  });

  it('widens a fingerprint taken while the file was shorter than its head', async () => {
    const { run, repos } = setup();
    const file = tree.write('p/s1.jsonl', [line('m1')]);
    const short = Buffer.byteLength(`${line('m1')}\n`);
    expect(short).toBeLessThan(FINGERPRINT_BYTES);
    await run();
    expect(repos.files.all().get(file)?.fingerprint).toBe(await readFingerprint(file, short));
    tree.write('p/s1.jsonl', [line('m2')], { append: true });
    await run();
    expect(repos.files.all().get(file)?.fingerprint).toBe(await readFingerprint(file, FINGERPRINT_BYTES));
    expect(repos.files.all().get(file)?.fingerprint).toMatch(/^1024:/);
  });

  it('keeps usage when a transcript file is deleted', async () => {
    const { run, rows, repos } = setup();
    tree.write('p/s1.jsonl', [line('m1')]);
    tree.write('p/s2.jsonl', [line('m2', { sessionId: 's2' })]);
    await run();
    tree.remove('p/s1.jsonl');
    await run();
    expect(repos.files.count()).toBe(1);
    expect(rows()).toHaveLength(2);
  });

  it('attributes a message copied into a resumed session to the original session', async () => {
    const { run, rows } = setup();
    tree.write('p/original.jsonl', [line('m1', { sessionId: 'original' })]);
    tree.write('p/resumed.jsonl', [line('m1', { sessionId: 'resumed' })]);
    tree.setMtime('p/original.jsonl', new Date('2026-09-01T00:00:00Z'));
    tree.setMtime('p/resumed.jsonl', new Date('2026-09-02T00:00:00Z'));
    await run();
    expect(rows()).toEqual([expect.objectContaining({ message_id: 'm1', session_id: 'original' })]);
  });

  it('prefers the main-branch copy over a sidechain copy', async () => {
    const { run, rows } = setup();
    tree.write('p/s1/subagents/agent-x.jsonl', [line('m5', { isSidechain: true, agentId: 'x', usage: { output: 999 } })]);
    tree.write('p/s1.jsonl', [line('m5', { usage: { output: 10 } })]);
    tree.setMtime('p/s1/subagents/agent-x.jsonl', new Date('2026-09-01T00:00:00Z'));
    tree.setMtime('p/s1.jsonl', new Date('2026-09-02T00:00:00Z'));
    await run();
    expect(rows()).toEqual([expect.objectContaining({ message_id: 'm5', is_sidechain: 0, output: 10 })]);
  });

  it('stores advisor iterations as separate rows', async () => {
    const { run, rows } = setup();
    tree.write('p/s1.jsonl', [
      line('m1', {
        usage: {
          output: 5,
          iterations: [
            { type: 'message', output: 5 },
            { type: 'advisor_message', model: 'claude-fable-5-1', input: 75_000 },
          ],
        },
      }),
    ]);
    const result = await run();
    expect(result.models.has('claude-fable-5-1')).toBe(true);
    expect(rows().map((r) => [r.kind, r.model])).toEqual([
      ['advisor', 'claude-fable-5-1'],
      ['primary', 'claude-opus-5'],
    ]);
  });

  it('stores server tool requests and charges the web search fee even without a token price', async () => {
    const { run, db } = setup();
    tree.write('p/s1.jsonl', [line('m1', { usage: { output: 100, webSearchRequests: 3, webFetchRequests: 2 } })]);
    await run();
    const totals = queryTotals(db, range('2026-09-10', '2026-09-10'));
    expect(totals).toMatchObject({ webSearchRequests: 3, webFetchRequests: 2 });
    expect(totals.cost.webSearch).toBeCloseTo(0.03, 10);
    expect(totals.cost.total).toBeCloseTo(0.03, 10);
  });

  it('counts skipped lines in the result and the status', async () => {
    const { run, status } = setup();
    tree.write('p/s1.jsonl', ['{"usage":{ broken', line('m1')]);
    const result = await run();
    expect(result.skipped).toBe(1);
    expect(status.snapshot().sync.skippedLines).toBe(1);
  });

  it('counts a line over the line size cap as skipped in the result and the status', async () => {
    const fits = line('m1');
    const { run, rows, status } = setup({ maxLineBytes: Buffer.byteLength(fits) });
    tree.write('p/s1.jsonl', [fits, line('m2', { cwd: `/home/dev/alpha/${'x'.repeat(64)}` })]);
    const result = await run();
    expect(result).toMatchObject({ rows: 1, skipped: 1 });
    expect(rows().map((row) => row.message_id)).toEqual(['m1']);
    expect(status.snapshot().sync.skippedLines).toBe(1);
  });

  it('skips lines stamped more than a day after the clock', async () => {
    const { run, rows, status } = setup({ now: () => Date.parse('2026-09-01T00:00:00Z') });
    tree.write('p/s1.jsonl', [line('m1')]);
    const result = await run();
    expect(result).toMatchObject({ rows: 0, skipped: 1 });
    expect(rows()).toEqual([]);
    expect(status.snapshot().sync.skippedLines).toBe(1);
  });

  it('counts dropped iterations and advisor usage mismatches, and warns once per cycle', async () => {
    const logger = createLogger('silent');
    const warn = vi.spyOn(logger, 'warn');
    const { run, status } = setup({ logger });
    const advisor = { type: 'advisor_message', model: 'claude-fable-5-1', input: 7 };
    tree.write('p/s1.jsonl', [
      line('m1', {
        usage: {
          output: 5,
          iterations: [
            { type: 'message', output: 5 },
            { ...advisor, input: -1 },
          ],
        },
      }),
      line('m2', { usage: { output: 9, iterations: [{ type: 'message', output: 5 }, advisor] } }),
      line('m3', { usage: { output: 9, iterations: [{ type: 'message', output: 5 }, advisor] } }),
    ]);
    const result = await run();
    expect(result).toMatchObject({ rows: 5, droppedIterations: 1, usageMismatches: 2 });
    expect(status.snapshot().sync).toMatchObject({ droppedIterations: 1, usageMismatches: 2 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith({ lines: 2 }, 'advisor usage check failed: top-level usage differs from the message iterations');
  });

  it('rolls back partial writes when a later row in the same file fails', async () => {
    const { deps, repos, rows, status } = setup();
    tree.write('p/s1.jsonl', [line('m1'), line('m2', { sessionId: 's2' })]);
    let calls = 0;
    const throwingUsage = {
      ...repos.usage,
      upsert: (row: Parameters<typeof repos.usage.upsert>[0]) => {
        calls += 1;
        if (calls === 2) throw new Error('boom');
        repos.usage.upsert(row);
      },
    };
    const throwingDeps: IngestDeps = { ...deps, repos: { ...repos, usage: throwingUsage } };
    const result = await runIngestCycle(throwingDeps);
    expect(result.files).toBe(0);
    expect(rows()).toHaveLength(0);
    expect(repos.files.count()).toBe(0);
    expect(status.snapshot().backfill.filesDone).toBe(1);
  });

  it('keeps file state and usage rows when the transcript root disappears', async () => {
    const { run, rows, repos, deps } = setup();
    tree.write('p/s1.jsonl', [line('m1')]);
    await run();
    expect(repos.files.count()).toBe(1);
    const before = rows();
    tree.cleanup();
    const result = await runIngestCycle(deps);
    expect(result.files).toBe(0);
    expect(repos.files.count()).toBe(1);
    expect(rows()).toEqual(before);
  });

  it('reports a missing source without throwing', async () => {
    const { run, status } = setup({ roots: [claudeRoot(join(tmpdir(), 'claude-code-monitor-root-that-does-not-exist'))] });
    const result = await run();
    expect(result.files).toBe(0);
    expect(status.snapshot().sources[0]).toMatchObject({ ok: false, files: 0 });
  });

  it('warns once about a missing source and notes its return', async () => {
    const logger = createLogger('silent');
    const warn = vi.spyOn(logger, 'warn');
    const info = vi.spyOn(logger, 'info');
    const { deps } = setup({ logger, notices: createNotices() });
    const root = tree.path('later');
    const cycle = () => runIngestCycle({ ...deps, roots: [claudeRoot(root)] });
    await cycle();
    await cycle();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith({ root, error: 'not accessible: ENOENT' }, 'transcript source unavailable');
    tree.write('later/p/s1.jsonl', [line('m1')]);
    await cycle();
    expect(info).toHaveBeenCalledWith({ root }, 'transcript source available again');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns once about a file that keeps failing, then logs it at debug level', async () => {
    const logger = createLogger('silent');
    const warn = vi.spyOn(logger, 'warn');
    const debug = vi.spyOn(logger, 'debug');
    const missing = join(tmpdir(), 'claude-code-monitor-missing-file.jsonl');
    const scan = async (): Promise<RootScan[]> => [
      {
        root: tmpdir(),
        ok: true,
        error: null,
        files: [{ path: missing, size: 10, mtimeMs: 1 }],
        unreadable: [],
        client: 'claude',
        required: true,
      },
    ];
    const { run } = setup({ logger, notices: createNotices(), scan });
    await run();
    await run();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ file: missing, code: 'ENOENT' }), 'failed to ingest file');
    expect(debug).toHaveBeenCalledWith(expect.objectContaining({ file: missing, code: 'ENOENT' }), 'failed to ingest file again');
  });

  it('warns once per unreadable entry under a source', async () => {
    const logger = createLogger('silent');
    const warn = vi.spyOn(logger, 'warn');
    const scan = async (): Promise<RootScan[]> => [
      { root: tree.root, ok: true, error: null, files: [], unreadable: [tree.path('locked')], client: 'claude', required: true },
    ];
    const { run } = setup({ logger, notices: createNotices(), scan });
    await run();
    await run();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith({ path: tree.path('locked') }, 'skipping an unreadable entry under a transcript source');
  });

  it('stops processing further files once shouldStop signals a stop', async () => {
    const { deps, repos, status } = setup();
    tree.write('p/s1.jsonl', [line('m1')]);
    tree.write('p/s2.jsonl', [line('m2', { sessionId: 's2' })]);
    tree.write('p/s3.jsonl', [line('m3', { sessionId: 's3' })]);
    const stopDeps: IngestDeps = { ...deps, shouldStop: () => repos.files.count() >= 1 };
    const result = await runIngestCycle(stopDeps);
    expect(result.files).toBe(1);
    expect(repos.files.count()).toBe(1);
    expect(status.snapshot().backfill.active).toBe(false);
    const second = await runIngestCycle(deps);
    expect(second.files).toBe(2);
    expect(repos.files.count()).toBe(3);
  });

  it('continues with other files when one cannot be read', async () => {
    const good = createTree();
    const goodFile = good.write('p/s1.jsonl', [line('m1')]);
    const { run, rows, status } = setup({
      scan: async () => [
        {
          root: good.root,
          ok: true,
          error: null,
          files: [
            { path: join(good.root, 'vanished.jsonl'), size: 10, mtimeMs: 1 },
            { path: goodFile, size: Buffer.byteLength(`${line('m1')}\n`), mtimeMs: 2 },
          ],
          unreadable: [],
          client: 'claude',
          required: true,
        },
      ],
    });
    await run();
    expect(rows()).toHaveLength(1);
    expect(status.snapshot().backfill.filesDone).toBe(2);
    good.cleanup();
  });

  it('reports a missing optional Codex root without a warning, and a missing required root with one', async () => {
    const logger = createLogger('silent');
    const warn = vi.spyOn(logger, 'warn');
    tree = createTree();
    const { db, repos } = createTestDb();
    const status = new StatusTracker(() => Date.parse('2026-09-11T00:00:00Z'));
    tree.write('-home-dev-alpha/s1.jsonl', [line('m1')]);
    const base: IngestDeps = {
      db,
      repos,
      roots: [claudeRoot(tree.root), codexRoot(tree.path('codex/sessions'))],
      toLocalDay: createLocalDay('UTC'),
      status,
      logger,
      now: () => Date.parse('2026-09-11T00:00:00Z'),
    };
    await runIngestCycle(base);
    expect(warn).not.toHaveBeenCalled();
    expect(status.snapshot().sources).toEqual([
      expect.objectContaining({ path: tree.root, client: 'claude', required: true, present: true, ok: true, files: 1 }),
      expect.objectContaining({ path: tree.path('codex/sessions'), client: 'codex', required: false, present: false, ok: false }),
    ]);
    await runIngestCycle({ ...base, roots: [claudeRoot(tree.path('claude-missing'))] });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
