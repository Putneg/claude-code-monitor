import { describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../src/server/db/connection.js';
import { LATEST_SCHEMA_VERSION, migrate } from '../../src/server/db/migrations.js';

function freshDb() {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

function v1Db(): Db {
  const db = openDatabase(':memory:');
  expect(migrate(db, 1)).toBe(1);
  return db;
}

interface ColumnInfo {
  readonly name: string;
  readonly pk: number;
}

const columns = (db: Db, table: string): ColumnInfo[] => db.prepare<[], ColumnInfo>(`PRAGMA table_info(${table})`).all();
const columnNames = (db: Db, table: string): string[] => columns(db, table).map((column) => column.name);
const primaryKey = (db: Db, table: string): string[] =>
  columns(db, table)
    .filter((column) => column.pk > 0)
    .toSorted((a, b) => a.pk - b.pk)
    .map((column) => column.name);

interface V1Usage {
  readonly messageId: string;
  readonly requestId: string;
  readonly output: number;
  readonly kind?: string;
  readonly seq?: number;
  readonly sessionId?: string;
  readonly isSidechain?: 0 | 1;
}

function insertV1Usage(db: Db, row: V1Usage): void {
  db.prepare(
    `INSERT INTO usage (message_id, request_id, kind, seq, session_id, agent_id, is_sidechain, model, speed, ts, local_day,
                        input, output, cache_read, cache_write_5m, cache_write_1h)
     VALUES (@messageId, @requestId, @kind, @seq, @sessionId, NULL, @isSidechain, 'claude-opus-5', 'standard', 0,
             '2026-09-10', 0, @output, 0, 0, 0)`,
  ).run({ kind: 'primary', seq: 0, sessionId: 'session-a', isSidechain: 0, ...row });
}

interface CollapsedRow {
  readonly message_id: string;
  readonly request_id: string;
  readonly kind: string;
  readonly session_id: string;
  readonly is_sidechain: number;
  readonly output: number;
}

/** Every column of a schema v1 usage row. */
interface V1UsageColumns {
  readonly message_id: string;
  readonly request_id: string;
  readonly kind: string;
  readonly seq: number;
  readonly session_id: string;
  readonly agent_id: string | null;
  readonly is_sidechain: number;
  readonly model: string;
  readonly speed: string;
  readonly ts: number;
  readonly local_day: string;
  readonly input: number;
  readonly output: number;
  readonly cache_read: number;
  readonly cache_write_5m: number;
  readonly cache_write_1h: number;
}

interface V2UsageColumns extends V1UsageColumns {
  readonly web_search_requests: number;
  readonly web_fetch_requests: number;
}

function insertPrice(db: ReturnType<typeof freshDb>): void {
  db.prepare(
    `INSERT INTO prices (price_key, input, output, cache_write_5m, cache_write_1h, cache_read, fast_multiplier, source, fetched_at)
     VALUES ('claude-opus-5', 5e-6, 2.5e-5, 6.25e-6, 1e-5, 5e-7, 2, 'snapshot', 0)`,
  ).run();
  db.prepare(`INSERT INTO model_price_map (model, price_key, resolved_at) VALUES ('claude-opus-5', 'claude-opus-5', 0)`).run();
  db.prepare(`INSERT INTO model_price_map (model, price_key, resolved_at) VALUES ('claude-mystery', NULL, 0)`).run();
}

function insertUsage(db: ReturnType<typeof freshDb>, id: string, model: string, speed: string): void {
  db.prepare(
    `INSERT INTO usage (message_id, request_id, kind, seq, session_id, agent_id, is_sidechain, model, speed, ts, local_day,
                        input, output, cache_read, cache_write_5m, cache_write_1h)
     VALUES (?, 'req', 'primary', 0, 'session-a', NULL, 0, ?, ?, 0, '2026-09-10', 1000, 2000, 10000, 100, 200)`,
  ).run(id, model, speed);
}

describe('migrate', () => {
  it('creates the schema and records the version', () => {
    const db = freshDb();
    const names = db
      .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name`)
      .all()
      .map((row) => (row as { name: string }).name);
    expect(names).toEqual(expect.arrayContaining(['file_state', 'meta', 'model_price_map', 'prices', 'sessions', 'usage', 'usage_costed']));
    const version = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string };
    expect(Number(version.value)).toBe(LATEST_SCHEMA_VERSION);
    expect(LATEST_SCHEMA_VERSION).toBe(3);
  });

  it('creates the latest schema on a fresh database', () => {
    const db = freshDb();
    expect(primaryKey(db, 'usage')).toEqual(['message_id', 'kind', 'seq']);
    expect(columnNames(db, 'usage')).toEqual(expect.arrayContaining(['request_id', 'web_search_requests', 'web_fetch_requests', 'client']));
    expect(columnNames(db, 'sessions')).toEqual(['session_id', 'project_path', 'project_id', 'project_source', 'project_ts', 'title']);
    expect(columnNames(db, 'file_state')).toEqual(['path', 'size', 'mtime_ms', 'read_offset', 'fingerprint', 'parser_state']);
    expect(primaryKey(db, 'codex_rate_limits')).toEqual(['limit_id']);
    expect(columnNames(db, 'usage_costed')).toEqual(expect.arrayContaining(['cost_web_search', 'cost']));
    const indexes = db.prepare<[], { name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'usage'`).all();
    expect(indexes.map((index) => index.name)).toContain('usage_day_model');
  });

  it('refuses a target version this build does not know', () => {
    const target = LATEST_SCHEMA_VERSION + 1;
    expect(() => migrate(openDatabase(':memory:'), target)).toThrow(
      `cannot migrate to schema version ${target}; this build supports up to ${LATEST_SCHEMA_VERSION}`,
    );
  });

  it('is idempotent', () => {
    const db = freshDb();
    expect(() => migrate(db)).not.toThrow();
    expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
  });

  it('uses WAL-compatible pragmas', () => {
    const db = freshDb();
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('refuses to run on a newer schema version', () => {
    const db = openDatabase(':memory:');
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const newer = LATEST_SCHEMA_VERSION + 1;
    db.prepare(
      `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    ).run(String(newer));
    expect(() => migrate(db)).toThrow(
      `database schema version ${newer} is newer than this build supports (${LATEST_SCHEMA_VERSION}); a newer image is needed`,
    );
  });
});

describe('usage_costed view', () => {
  it('prices standard rows per token type', () => {
    const db = freshDb();
    insertPrice(db);
    insertUsage(db, 'm1', 'claude-opus-5', 'standard');
    const row = db.prepare(`SELECT * FROM usage_costed WHERE message_id = 'm1'`).get() as Record<string, number>;
    expect(row.priced).toBe(1);
    expect(row.cost_input).toBeCloseTo(0.005, 12);
    expect(row.cost_output).toBeCloseTo(0.05, 12);
    expect(row.cost_cache_read).toBeCloseTo(0.005, 12);
    expect(row.cost_cache_write).toBeCloseTo(0.000625 + 0.002, 12);
    expect(row.cost).toBeCloseTo(0.062625, 12);
  });

  it('applies the fast multiplier', () => {
    const db = freshDb();
    insertPrice(db);
    insertUsage(db, 'm2', 'claude-opus-5', 'fast');
    const row = db.prepare(`SELECT cost FROM usage_costed WHERE message_id = 'm2'`).get() as { cost: number };
    expect(row.cost).toBeCloseTo(0.12525, 12);
  });

  it('returns zero cost for unpriced models', () => {
    const db = freshDb();
    insertPrice(db);
    insertUsage(db, 'm3', 'claude-mystery', 'standard');
    insertUsage(db, 'm4', 'claude-never-mapped', 'standard');
    const rows = db.prepare(`SELECT message_id, priced, cost FROM usage_costed WHERE message_id IN ('m3', 'm4') ORDER BY message_id`).all();
    expect(rows).toEqual([
      { message_id: 'm3', priced: 0, cost: 0 },
      { message_id: 'm4', priced: 0, cost: 0 },
    ]);
  });

  it('exposes session project and title', () => {
    const db = freshDb();
    insertPrice(db);
    insertUsage(db, 'm5', 'claude-opus-5', 'standard');
    db.prepare(
      `INSERT INTO sessions (session_id, project_path, project_id, project_source, project_ts, title)
       VALUES ('session-a', '/home/dev/alpha', 'abc1234567', 'main', 0, 'Alpha work')`,
    ).run();
    const row = db.prepare(`SELECT project_id, project_path, session_title FROM usage_costed WHERE message_id = 'm5'`).get();
    expect(row).toEqual({ project_id: 'abc1234567', project_path: '/home/dev/alpha', session_title: 'Alpha work' });
  });

  it('adds $0.01 per web search request to the cost, also for unpriced models', () => {
    const db = freshDb();
    insertPrice(db);
    insertUsage(db, 'w1', 'claude-opus-5', 'fast');
    insertUsage(db, 'w2', 'claude-mystery', 'standard');
    db.prepare('UPDATE usage SET web_search_requests = 3, web_fetch_requests = 4').run();
    const rows = db
      .prepare<[], { message_id: string; priced: number; cost_web_search: number; cost: number }>(
        'SELECT message_id, priced, cost_web_search, cost FROM usage_costed ORDER BY message_id',
      )
      .all();
    expect(rows.map((row) => [row.message_id, row.priced])).toEqual([
      ['w1', 1],
      ['w2', 0],
    ]);
    expect(rows[0]?.cost_web_search).toBeCloseTo(0.03, 12);
    // The fast multiplier (2) applies to token prices only, never to the per-request fee.
    expect(rows[0]?.cost).toBeCloseTo(0.12525 + 0.03, 12);
    expect(rows[1]?.cost_web_search).toBeCloseTo(0.03, 12);
    expect(rows[1]?.cost).toBeCloseTo(0.03, 12);
  });
});

describe('migration from v1 to v2', () => {
  it('collapses rows that collide under the new key by the upsert rule', () => {
    const db = v1Db();
    // Same side, differing only in request id: the copy with more tokens wins.
    insertV1Usage(db, { messageId: 'm1', requestId: '', output: 10 });
    insertV1Usage(db, { messageId: 'm1', requestId: 'req_1', output: 900 });
    // Main over sidechain, whichever came first.
    insertV1Usage(db, { messageId: 'm2', requestId: 'req_a', isSidechain: 1, output: 5_000 });
    insertV1Usage(db, { messageId: 'm2', requestId: 'req_b', output: 10 });
    insertV1Usage(db, { messageId: 'm3', requestId: 'req_a', output: 10 });
    insertV1Usage(db, { messageId: 'm3', requestId: 'req_b', isSidechain: 1, output: 5_000 });
    // Same side and the fuller copy first: it stays. A tie keeps the earlier copy.
    insertV1Usage(db, { messageId: 'm4', requestId: 'req_a', output: 900 });
    insertV1Usage(db, { messageId: 'm4', requestId: 'req_b', output: 10 });
    insertV1Usage(db, { messageId: 'm5', requestId: 'req_a', sessionId: 'first', output: 50 });
    insertV1Usage(db, { messageId: 'm5', requestId: 'req_b', sessionId: 'second', output: 50 });
    // An advisor row of the same message has its own key and is kept.
    insertV1Usage(db, { messageId: 'm1', requestId: 'req_1', kind: 'advisor', seq: 1, output: 7 });

    expect(migrate(db, 2)).toBe(2);
    const rows = db
      .prepare<[], CollapsedRow>(
        'SELECT message_id, request_id, kind, session_id, is_sidechain, output FROM usage ORDER BY message_id, kind',
      )
      .all();
    expect(rows).toEqual([
      { message_id: 'm1', request_id: 'req_1', kind: 'advisor', session_id: 'session-a', is_sidechain: 0, output: 7 },
      { message_id: 'm1', request_id: 'req_1', kind: 'primary', session_id: 'session-a', is_sidechain: 0, output: 900 },
      { message_id: 'm2', request_id: 'req_b', kind: 'primary', session_id: 'session-a', is_sidechain: 0, output: 10 },
      { message_id: 'm3', request_id: 'req_a', kind: 'primary', session_id: 'session-a', is_sidechain: 0, output: 10 },
      { message_id: 'm4', request_id: 'req_a', kind: 'primary', session_id: 'session-a', is_sidechain: 0, output: 900 },
      { message_id: 'm5', request_id: 'req_a', kind: 'primary', session_id: 'first', is_sidechain: 0, output: 50 },
    ]);
    expect(db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM usage WHERE web_search_requests = 0').get()?.n).toBe(6);
  });

  it('keeps sessions without their time columns and gives old file states no fingerprint', () => {
    const db = v1Db();
    db.prepare(
      `INSERT INTO sessions (session_id, project_path, project_id, project_source, project_ts, title, first_ts, last_ts)
       VALUES ('s1', '/home/dev/alpha', 'abc1234567', 'main', 5, 'Alpha work', 1, 9)`,
    ).run();
    db.prepare(`INSERT INTO file_state (path, size, mtime_ms, read_offset) VALUES ('/p/s1.jsonl', 10, 1.5, 10)`).run();
    migrate(db, 2);
    expect(db.prepare('SELECT * FROM sessions').all()).toEqual([
      {
        session_id: 's1',
        project_path: '/home/dev/alpha',
        project_id: 'abc1234567',
        project_source: 'main',
        project_ts: 5,
        title: 'Alpha work',
      },
    ]);
    expect(db.prepare('SELECT * FROM file_state').all()).toEqual([
      { path: '/p/s1.jsonl', size: 10, mtime_ms: 1.5, read_offset: 10, fingerprint: null },
    ]);
  });

  it('leaves the v1 database as it was when the migration fails part-way', () => {
    const db = v1Db();
    insertV1Usage(db, { messageId: 'm1', requestId: 'req_1', output: 10 });
    db.prepare(
      `INSERT INTO sessions (session_id, project_path, project_id, project_source, project_ts, title, first_ts, last_ts)
       VALUES ('s1', '/home/dev/alpha', 'abc1234567', 'main', 5, 'Alpha work', 1, 9)`,
    ).run();
    // A table with the rebuild's name makes the migration fail after it has already dropped the view.
    db.exec('CREATE TABLE usage_v2 (x INTEGER)');

    expect(() => migrate(db)).toThrow('table usage_v2 already exists');
    const version = db.prepare<[], { value: string }>(`SELECT value FROM meta WHERE key = 'schema_version'`).get();
    expect(Number(version?.value)).toBe(1);
    const views = db.prepare<[], { name: string }>(`SELECT name FROM sqlite_master WHERE type = 'view'`).all();
    expect(views.map((view) => view.name)).toEqual(['usage_costed']);
    expect(columnNames(db, 'sessions')).toContain('first_ts');
    expect(db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM usage').get()?.n).toBe(1);
  });

  it('keeps every column of a usage row in its place', () => {
    const db = v1Db();
    // Every value differs from the others, so two columns swapped by the rebuild would show.
    const v1Row: V1UsageColumns = {
      message_id: 'msg_all',
      request_id: 'req_all',
      kind: 'fallback_attempt',
      seq: 2,
      session_id: 'session-all',
      agent_id: 'agent-all',
      is_sidechain: 1,
      model: 'claude-opus-5',
      speed: 'fast',
      ts: 1_789_000_000_000,
      local_day: '2026-09-10',
      input: 11,
      output: 22,
      cache_read: 33,
      cache_write_5m: 44,
      cache_write_1h: 55,
    };
    db.prepare(
      `INSERT INTO usage (message_id, request_id, kind, seq, session_id, agent_id, is_sidechain, model, speed, ts, local_day,
                          input, output, cache_read, cache_write_5m, cache_write_1h)
       VALUES (@message_id, @request_id, @kind, @seq, @session_id, @agent_id, @is_sidechain, @model, @speed, @ts, @local_day,
               @input, @output, @cache_read, @cache_write_5m, @cache_write_1h)`,
    ).run(v1Row);

    expect(migrate(db, 2)).toBe(2);
    expect(db.prepare<[], V2UsageColumns>('SELECT * FROM usage').all()).toEqual([
      { ...v1Row, web_search_requests: 0, web_fetch_requests: 0 },
    ]);
  });
});

function v2Db(): Db {
  const db = openDatabase(':memory:');
  expect(migrate(db, 2)).toBe(2);
  return db;
}

describe('migration from v2 to v3', () => {
  it('marks existing usage rows as Claude Code rows and shows the client through usage_costed', () => {
    const db = v2Db();
    insertV1Usage(db, { messageId: 'm1', requestId: 'req_1', output: 5 });
    expect(migrate(db)).toBe(3);
    expect(db.prepare('SELECT message_id, client, output FROM usage').all()).toEqual([{ message_id: 'm1', client: 'claude', output: 5 }]);
    expect(db.prepare('SELECT message_id, client, cost FROM usage_costed').all()).toEqual([
      { message_id: 'm1', client: 'claude', cost: 0 },
    ]);
  });

  it('refuses an unknown client', () => {
    const db = freshDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO usage (message_id, kind, session_id, is_sidechain, model, ts, local_day, client)
           VALUES ('m1', 'primary', 's1', 0, 'gpt-5.6-sol', 0, '2026-09-10', 'other')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it('gives existing file states no parser state', () => {
    const db = v2Db();
    db.prepare(`INSERT INTO file_state (path, size, mtime_ms, read_offset, fingerprint) VALUES ('/p/a.jsonl', 10, 1.5, 10, NULL)`).run();
    migrate(db);
    expect(db.prepare('SELECT path, parser_state FROM file_state').all()).toEqual([{ path: '/p/a.jsonl', parser_state: null }]);
  });

  it('creates an empty rate-limit table', () => {
    const db = v2Db();
    migrate(db);
    expect(columnNames(db, 'codex_rate_limits')).toEqual([
      'limit_id',
      'plan_type',
      'primary_used_percent',
      'primary_window_minutes',
      'primary_resets_at',
      'secondary_used_percent',
      'secondary_window_minutes',
      'secondary_resets_at',
      'credits_has',
      'credits_unlimited',
      'credits_balance',
      'observed_at',
    ]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM codex_rate_limits').get()).toEqual({ n: 0 });
  });
});
