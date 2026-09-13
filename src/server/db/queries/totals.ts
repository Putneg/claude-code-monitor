import type { CostBreakdown, ModelBreakdown, ProjectBreakdown, TokenBreakdown } from '../../../shared/api.js';
import { modelColor, modelLabel, projectLabel } from '../../../shared/models.js';
import type { Db } from '../connection.js';
import { buildWhere, type SqlFragment, type UsageFilter } from './filter-sql.js';

// Aggregates use TOTAL(): it returns REAL and never raises "integer overflow", which SUM does past 2^63.

export const TOKENS_SUM_SQL = 'input + output + cache_read + cache_write_5m + cache_write_1h';
/** Subagent spend: sidechain rows, including older in-file Task transcripts that carry no agentId, and agent rows. */
export const SUBAGENT_COST_SQL = 'TOTAL(CASE WHEN is_sidechain = 1 OR agent_id IS NOT NULL THEN cost ELSE 0 END)';

const SUMS_SQL = `
  TOTAL(input) AS input, TOTAL(output) AS output,
  TOTAL(cache_read) AS cache_read, TOTAL(cache_write_5m) AS cache_write_5m,
  TOTAL(cache_write_1h) AS cache_write_1h,
  TOTAL(cost_input) AS cost_input, TOTAL(cost_output) AS cost_output,
  TOTAL(cost_cache_read) AS cost_cache_read, TOTAL(cost_cache_write) AS cost_cache_write,
  TOTAL(web_search_requests) AS web_search_requests, TOTAL(web_fetch_requests) AS web_fetch_requests,
  TOTAL(cost_web_search) AS cost_web_search,
  TOTAL(cost) AS cost`;

interface SumsRow {
  input: number;
  output: number;
  cache_read: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cost_input: number;
  cost_output: number;
  cost_cache_read: number;
  cost_cache_write: number;
  web_search_requests: number;
  web_fetch_requests: number;
  cost_web_search: number;
  cost: number;
}

export interface TotalsCore {
  readonly cost: CostBreakdown;
  readonly tokens: TokenBreakdown;
  readonly tokensTotal: number;
  readonly sessions: number;
  readonly projects: number;
  readonly subagentCost: number;
  readonly advisorCost: number;
  readonly webSearchRequests: number;
  readonly webFetchRequests: number;
}

const toTokens = (row: SumsRow): TokenBreakdown => ({
  input: row.input,
  output: row.output,
  cacheRead: row.cache_read,
  cacheWrite5m: row.cache_write_5m,
  cacheWrite1h: row.cache_write_1h,
});

const toCost = (row: SumsRow): CostBreakdown => ({
  input: row.cost_input,
  output: row.cost_output,
  cacheRead: row.cost_cache_read,
  cacheWrite: row.cost_cache_write,
  webSearch: row.cost_web_search,
  total: row.cost,
});

const sumTokens = (t: TokenBreakdown): number => t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;

export function queryTotals(db: Db, filter: UsageFilter): TotalsCore {
  const where = buildWhere(filter);
  const row = db
    .prepare(
      `SELECT ${SUMS_SQL},
         COUNT(DISTINCT session_id) AS sessions, COUNT(DISTINCT project_id) AS projects,
         ${SUBAGENT_COST_SQL} AS subagent_cost,
         TOTAL(CASE WHEN kind = 'advisor' THEN cost ELSE 0 END) AS advisor_cost
       FROM usage_costed WHERE ${where.sql}`,
    )
    .get(where.params) as SumsRow & { sessions: number; projects: number; subagent_cost: number; advisor_cost: number };
  const tokens = toTokens(row);
  return {
    cost: toCost(row),
    tokens,
    tokensTotal: sumTokens(tokens),
    sessions: row.sessions,
    projects: row.projects,
    subagentCost: row.subagent_cost,
    advisorCost: row.advisor_cost,
    webSearchRequests: row.web_search_requests,
    webFetchRequests: row.web_fetch_requests,
  };
}

export function queryByModel(db: Db, filter: UsageFilter, totalCost: number): ModelBreakdown[] {
  const where = buildWhere(filter);
  const rows = db
    .prepare(
      `SELECT model, MAX(priced) AS priced, ${SUMS_SQL}
       FROM usage_costed WHERE ${where.sql}
       GROUP BY model ORDER BY cost DESC, model`,
    )
    .all(where.params) as (SumsRow & { model: string; priced: number })[];
  return rows.map((row) => {
    const tokens = toTokens(row);
    const tokensTotal = sumTokens(tokens);
    const priced = row.priced === 1;
    return {
      model: row.model,
      label: modelLabel(row.model),
      color: modelColor(row.model),
      priced,
      tokens,
      tokensTotal,
      cost: row.cost,
      share: totalCost > 0 ? row.cost / totalCost : 0,
      costPerMTok: priced && tokensTotal > 0 ? (row.cost - row.cost_web_search) / (tokensTotal / 1_000_000) : null,
    };
  });
}

export function queryByProject(db: Db, filter: UsageFilter): ProjectBreakdown[] {
  const where = buildWhere(filter);
  const rows = db
    .prepare(
      `SELECT project_id, MAX(project_path) AS project_path, TOTAL(${TOKENS_SUM_SQL}) AS tokens,
              TOTAL(cost) AS cost, COUNT(DISTINCT session_id) AS sessions
       FROM usage_costed WHERE ${where.sql} AND project_id IS NOT NULL
       GROUP BY project_id ORDER BY cost DESC, project_id`,
    )
    .all(where.params) as { project_id: string; project_path: string; tokens: number; cost: number; sessions: number }[];
  return rows.map((row) => ({
    id: row.project_id,
    path: row.project_path,
    label: projectLabel(row.project_path),
    tokensTotal: row.tokens,
    cost: row.cost,
    sessions: row.sessions,
  }));
}

export function queryPeriodCost(db: Db, filter: UsageFilter): number {
  const where = buildWhere(filter);
  const row = db
    .prepare<SqlFragment['params'], { cost: number }>(`SELECT TOTAL(cost) AS cost FROM usage_costed WHERE ${where.sql}`)
    .get(where.params);
  return row?.cost ?? 0;
}
