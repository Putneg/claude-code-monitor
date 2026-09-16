import { describe, expect, it } from 'vitest';
import { createUsageRepo } from '../../src/server/db/usage-repo.js';
import type { UsageRow } from '../../src/server/ingest/parser.js';
import { createMigratedDb } from '../helpers/db.js';

const row = (overrides: Partial<UsageRow> = {}): UsageRow => ({
  messageId: 'msg_1',
  requestId: 'req_1',
  kind: 'primary',
  seq: 0,
  sessionId: 'session-a',
  agentId: null,
  isSidechain: false,
  model: 'claude-opus-5',
  speed: 'standard',
  ts: Date.parse('2026-09-10T12:00:00Z'),
  localDay: '2026-09-10',
  input: 1,
  output: 10,
  cacheRead: 100,
  cacheWrite5m: 0,
  cacheWrite1h: 5,
  webSearchRequests: 0,
  webFetchRequests: 0,
  client: 'claude',
  ...overrides,
});

function setup() {
  const db = createMigratedDb();
  const repo = createUsageRepo(db);
  const read = () => db.prepare('SELECT * FROM usage ORDER BY message_id, kind, seq').all() as Record<string, unknown>[];
  return { db, repo, read };
}

describe('usage repo upsert', () => {
  it('inserts a row with snake_case columns', () => {
    const { repo, read } = setup();
    repo.upsert(row());
    expect(read()).toEqual([
      expect.objectContaining({
        message_id: 'msg_1',
        request_id: 'req_1',
        kind: 'primary',
        seq: 0,
        session_id: 'session-a',
        agent_id: null,
        is_sidechain: 0,
        model: 'claude-opus-5',
        speed: 'standard',
        local_day: '2026-09-10',
        input: 1,
        output: 10,
        cache_read: 100,
        cache_write_5m: 0,
        cache_write_1h: 5,
        client: 'claude',
      }),
    ]);
  });

  it('replaces a partial streaming copy with the fuller one', () => {
    const { repo, read } = setup();
    repo.upsert(row({ output: 10 }));
    repo.upsert(row({ output: 900 }));
    repo.upsert(row({ output: 50 }));
    expect(read()).toHaveLength(1);
    expect(read()[0]?.output).toBe(900);
  });

  it('collapses a copy without a request id into the copy that has one', () => {
    const { repo, read } = setup();
    repo.upsert(row({ requestId: '', output: 10 }));
    repo.upsert(row({ requestId: 'req_1', output: 900 }));
    expect(read()).toHaveLength(1);
    expect(read()[0]).toMatchObject({ request_id: 'req_1', output: 900 });
  });

  it('keeps the first copy on ties so resumed sessions keep the original owner', () => {
    const { repo, read } = setup();
    repo.upsert(row({ sessionId: 'original' }));
    repo.upsert(row({ sessionId: 'resumed-copy' }));
    expect(read()[0]?.session_id).toBe('original');
  });

  it('prefers a main-branch copy over a sidechain copy', () => {
    const { repo, read } = setup();
    repo.upsert(row({ isSidechain: true, agentId: 'agent-1', output: 999 }));
    repo.upsert(row({ isSidechain: false, agentId: null, output: 10 }));
    expect(read()[0]).toMatchObject({ is_sidechain: 0, agent_id: null, output: 10 });
    repo.upsert(row({ isSidechain: true, agentId: 'agent-1', output: 5000 }));
    expect(read()[0]).toMatchObject({ is_sidechain: 0, output: 10 });
  });

  it('stores web search and fetch requests and takes them from the fuller copy', () => {
    const { repo, read } = setup();
    repo.upsert(row({ output: 10 }));
    repo.upsert(row({ output: 900, webSearchRequests: 3, webFetchRequests: 1 }));
    expect(read()).toEqual([expect.objectContaining({ output: 900, web_search_requests: 3, web_fetch_requests: 1 })]);
  });

  it('stores advisor rows separately from the primary row', () => {
    const { repo, read } = setup();
    repo.upsert(row());
    repo.upsert(row({ kind: 'advisor', seq: 1, model: 'claude-fable-5-1', input: 75_000 }));
    expect(read().map((r) => [r.kind, r.model])).toEqual([
      ['advisor', 'claude-fable-5-1'],
      ['primary', 'claude-opus-5'],
    ]);
  });

  it('stores the client of a row', () => {
    const { repo, read } = setup();
    repo.upsert(row({ messageId: 'resp_1', client: 'codex', model: 'gpt-5.6-sol' }));
    expect(read()).toEqual([expect.objectContaining({ message_id: 'resp_1', client: 'codex', model: 'gpt-5.6-sol' })]);
  });
});

describe('usage repo queries', () => {
  it('counts rows and reports day bounds', () => {
    const { repo } = setup();
    expect(repo.dayBounds()).toEqual({ firstDay: null, lastDay: null });
    repo.upsert(row({ messageId: 'a', localDay: '2026-09-01' }));
    repo.upsert(row({ messageId: 'b', localDay: '2026-09-11' }));
    expect(repo.count()).toBe(2);
    expect(repo.dayBounds()).toEqual({ firstDay: '2026-09-01', lastDay: '2026-09-11' });
  });

  it('recomputes local days in batches', () => {
    const { repo, read } = setup();
    repo.upsert(row({ messageId: 'a', ts: Date.parse('2026-09-10T22:30:00Z'), localDay: '2026-09-10' }));
    const updated = repo.recomputeLocalDays(() => '2030-01-01');
    expect(updated).toBe(1);
    expect(read()[0]?.local_day).toBe('2030-01-01');
  });

  it('lists distinct models sorted, deduplicated', () => {
    const { repo } = setup();
    repo.upsert(row({ messageId: 'a', model: 'b' }));
    repo.upsert(row({ messageId: 'b', model: 'a' }));
    repo.upsert(row({ messageId: 'c', model: 'a' }));
    expect(repo.distinctModels()).toEqual(['a', 'b']);
  });

  it('returns an empty array when the database is empty', () => {
    const { repo } = setup();
    expect(repo.distinctModels()).toEqual([]);
  });
});
