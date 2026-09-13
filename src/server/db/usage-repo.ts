import type { UsageRow } from '../ingest/parser.js';
import type { Db } from './connection.js';

export interface DayBounds {
  readonly firstDay: string | null;
  readonly lastDay: string | null;
}

export interface UsageRepo {
  upsert(row: UsageRow): void;
  count(): number;
  dayBounds(): DayBounds;
  recomputeLocalDays(toLocalDay: (tsMs: number) => string): number;
  distinctModels(): string[];
}

const TOKEN_SUM = (table: string): string =>
  `${table}.input + ${table}.output + ${table}.cache_read + ${table}.cache_write_5m + ${table}.cache_write_1h`;

const UPSERT_SQL = `
INSERT INTO usage (message_id, request_id, kind, seq, session_id, agent_id, is_sidechain, model, speed,
                   ts, local_day, input, output, cache_read, cache_write_5m, cache_write_1h,
                   web_search_requests, web_fetch_requests)
VALUES (@messageId, @requestId, @kind, @seq, @sessionId, @agentId, @isSidechain, @model, @speed,
        @ts, @localDay, @input, @output, @cacheRead, @cacheWrite5m, @cacheWrite1h,
        @webSearchRequests, @webFetchRequests)
ON CONFLICT (message_id, kind, seq) DO UPDATE SET
  request_id = excluded.request_id, session_id = excluded.session_id, agent_id = excluded.agent_id,
  is_sidechain = excluded.is_sidechain, model = excluded.model, speed = excluded.speed, ts = excluded.ts,
  local_day = excluded.local_day, input = excluded.input, output = excluded.output, cache_read = excluded.cache_read,
  cache_write_5m = excluded.cache_write_5m, cache_write_1h = excluded.cache_write_1h,
  web_search_requests = excluded.web_search_requests, web_fetch_requests = excluded.web_fetch_requests
WHERE usage.is_sidechain > excluded.is_sidechain
   OR (usage.is_sidechain = excluded.is_sidechain AND ${TOKEN_SUM('excluded')} > ${TOKEN_SUM('usage')})`;

const RECOMPUTE_BATCH = 5_000;

function toParams(row: UsageRow) {
  return {
    messageId: row.messageId,
    requestId: row.requestId,
    kind: row.kind,
    seq: row.seq,
    sessionId: row.sessionId,
    agentId: row.agentId,
    isSidechain: row.isSidechain ? 1 : 0,
    model: row.model,
    speed: row.speed,
    ts: row.ts,
    localDay: row.localDay,
    input: row.input,
    output: row.output,
    cacheRead: row.cacheRead,
    cacheWrite5m: row.cacheWrite5m,
    cacheWrite1h: row.cacheWrite1h,
    webSearchRequests: row.webSearchRequests,
    webFetchRequests: row.webFetchRequests,
  };
}

export function createUsageRepo(db: Db): UsageRepo {
  const upsert = db.prepare(UPSERT_SQL);
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM usage');
  const boundsStmt = db.prepare('SELECT MIN(local_day) AS firstDay, MAX(local_day) AS lastDay FROM usage');
  const distinctModelsStmt = db.prepare('SELECT DISTINCT model FROM usage ORDER BY model');
  const batchStmt = db.prepare('SELECT rowid AS id, ts FROM usage WHERE rowid > ? ORDER BY rowid LIMIT ?');
  const updateDayStmt = db.prepare('UPDATE usage SET local_day = ? WHERE rowid = ?');
  const updateBatch = db.transaction((rows: readonly { id: number; ts: number }[], toLocalDay: (tsMs: number) => string) => {
    rows.forEach((r) => updateDayStmt.run(toLocalDay(r.ts), r.id));
  });

  return {
    upsert: (row) => {
      upsert.run(toParams(row));
    },
    count: () => (countStmt.get() as { n: number }).n,
    dayBounds: () => boundsStmt.get() as DayBounds,
    distinctModels: () => (distinctModelsStmt.all() as { model: string }[]).map((r) => r.model),
    recomputeLocalDays: (toLocalDay) => {
      let lastId = 0;
      let updated = 0;
      for (;;) {
        const rows = batchStmt.all(lastId, RECOMPUTE_BATCH) as { id: number; ts: number }[];
        if (rows.length === 0) return updated;
        updateBatch(rows, toLocalDay);
        updated += rows.length;
        lastId = rows[rows.length - 1]?.id ?? lastId;
      }
    },
  };
}
