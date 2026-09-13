import type { SessionSort, SessionsResponse, SessionSummary } from '../../../shared/api.js';
import { projectLabel } from '../../../shared/models.js';
import type { Db } from '../connection.js';
import { buildIn, buildWhere, type UsageFilter } from './filter-sql.js';
import { SUBAGENT_COST_SQL, TOKENS_SUM_SQL } from './totals.js';

export interface SessionsOptions {
  readonly sort: SessionSort;
  readonly limit: number;
}

interface SessionRow {
  session_id: string;
  title: string | null;
  project_id: string | null;
  project_path: string | null;
  first_ts: number;
  last_ts: number;
  tokens: number;
  cost: number;
  subagent_cost: number;
}

const ORDER_BY: Readonly<Record<SessionSort, string>> = {
  cost: 'cost DESC, session_id',
  recent: 'last_ts DESC, session_id',
};

function modelsBySession(db: Db, filter: UsageFilter, ids: readonly string[]): Map<string, string[]> {
  const where = buildWhere(filter);
  const inIds = buildIn('session_id', 'session', ids);
  if (!inIds) return new Map();
  const rows = db
    .prepare(
      `SELECT session_id, model, TOTAL(cost) AS cost
       FROM usage_costed WHERE ${where.sql} AND ${inIds.sql}
       GROUP BY session_id, model ORDER BY session_id, cost DESC, model`,
    )
    .all({ ...where.params, ...inIds.params }) as { session_id: string; model: string }[];
  return rows.reduce((acc, row) => acc.set(row.session_id, [...(acc.get(row.session_id) ?? []), row.model]), new Map<string, string[]>());
}

const toSummary = (row: SessionRow, models: readonly string[]): SessionSummary => ({
  id: row.session_id,
  title: row.title,
  projectId: row.project_id,
  projectLabel: row.project_path === null ? null : projectLabel(row.project_path),
  firstTs: new Date(row.first_ts).toISOString(),
  lastTs: new Date(row.last_ts).toISOString(),
  models,
  tokensTotal: row.tokens,
  cost: row.cost,
  subagentCost: row.subagent_cost,
});

export function querySessions(db: Db, filter: UsageFilter, options: SessionsOptions): SessionsResponse {
  const where = buildWhere(filter);
  const total = (
    db.prepare(`SELECT COUNT(DISTINCT session_id) AS n FROM usage_costed WHERE ${where.sql}`).get(where.params) as {
      n: number;
    }
  ).n;
  const rows = db
    .prepare(
      `SELECT session_id, MAX(session_title) AS title, MAX(project_id) AS project_id, MAX(project_path) AS project_path,
              MIN(ts) AS first_ts, MAX(ts) AS last_ts, TOTAL(${TOKENS_SUM_SQL}) AS tokens,
              TOTAL(cost) AS cost,
              ${SUBAGENT_COST_SQL} AS subagent_cost
       FROM usage_costed WHERE ${where.sql}
       GROUP BY session_id ORDER BY ${ORDER_BY[options.sort]} LIMIT @limit`,
    )
    .all({ ...where.params, limit: options.limit }) as SessionRow[];
  const models = modelsBySession(
    db,
    filter,
    rows.map((row) => row.session_id),
  );
  return { total, sessions: rows.map((row) => toSummary(row, models.get(row.session_id) ?? [])) };
}
