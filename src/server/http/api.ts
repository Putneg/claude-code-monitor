import { Hono, type Context } from 'hono';
import type { FiltersResponse, OverviewResponse, SessionsResponse, StatusResponse } from '../../shared/api.js';
import type { Db } from '../db/connection.js';
import { queryFilters } from '../db/queries/filters.js';
import { queryOverview } from '../db/queries/overview.js';
import { querySessions } from '../db/queries/sessions.js';
import type { Repos } from '../db/repos.js';
import type { Logger } from '../logger.js';
import type { PricingService } from '../pricing/refresher.js';
import type { StatusTracker } from '../status.js';
import { createLocalDay, daysInclusive } from '../time.js';
import { overviewQuerySchema, parseQuery, QueryError, resolveBucket, resolveFilter, sessionsQuerySchema } from './params.js';
import { createResponseCache } from './response-cache.js';

export interface ApiDeps {
  readonly db: Db;
  readonly repos: Repos;
  readonly status: StatusTracker;
  readonly pricing: Pick<PricingService, 'state'>;
  readonly timeZone: string;
  /** Real clock: sync and health ages. */
  readonly now: () => number;
  /** Clock behind "today", the presets and status.now; defaults to `now`. The E2E server freezes it (scripts/e2e-server.ts). */
  readonly calendarNow?: () => number;
  readonly logger: Logger;
}

/** Entries of the in-process /api response cache. */
export const API_CACHE_ENTRIES = 16;

type CachedResponse = FiltersResponse | OverviewResponse | SessionsResponse;
type Responder = (route: string, query: unknown, compute: () => CachedResponse) => CachedResponse;

/**
 * Serves repeated GETs from a small LRU. Besides the route and the resolved query, the key holds everything a response
 * depends on: StatusTracker.dataVersion(), which ingest bumps after every committed file with no await in between (so
 * a response is never cached under a version that does not match its data), and the price table's source and fetch
 * time.
 */
function createResponder(deps: Pick<ApiDeps, 'status' | 'pricing'>): Responder {
  const cache = createResponseCache<CachedResponse>(API_CACHE_ENTRIES);
  return (route, query, compute) => {
    const pricing = deps.pricing.state();
    const key = [route, JSON.stringify(query), deps.status.dataVersion(), pricing.source, pricing.fetchedAt].join('|');
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const value = compute();
    cache.set(key, value);
    return value;
  };
}

export function handleError(logger: Logger) {
  return (error: Error, c: Context): Response => {
    if (error instanceof QueryError) return c.json({ error: 'invalid_query', details: error.details }, 400);
    logger.error({ err: error, path: c.req.path }, 'request failed');
    return c.json({ error: 'internal_error' }, 500);
  };
}

/** The clock behind "today", the presets and status.now: the calendar clock when one is set, else the real clock. */
const calendarClock = (deps: ApiDeps): (() => number) => deps.calendarNow ?? deps.now;

function buildStatus(deps: ApiDeps, toLocalDay: (tsMs: number) => string): StatusResponse {
  const snapshot = deps.status.snapshot();
  const bounds = deps.repos.usage.dayBounds();
  const nowMs = calendarClock(deps)();
  return {
    now: new Date(nowMs).toISOString(),
    today: toLocalDay(nowMs),
    tz: deps.timeZone,
    sync: snapshot.sync,
    backfill: snapshot.backfill,
    sources: snapshot.sources,
    pricing: deps.pricing.state(),
    data: { firstDay: bounds.firstDay, lastDay: bounds.lastDay, rows: deps.repos.usage.count() },
  };
}

export function createApi(deps: ApiDeps): Hono {
  const api = new Hono();
  const toLocalDay = createLocalDay(deps.timeZone);
  const today = (): string => toLocalDay(calendarClock(deps)());
  const respond = createResponder(deps);
  api.onError(handleError(deps.logger));
  api.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });

  api.get('/status', (c) => c.json(buildStatus(deps, toLocalDay)));
  api.get('/filters', (c) => c.json(respond('filters', null, () => queryFilters(deps.db, deps.repos))));
  api.get('/overview', (c) => {
    const query = parseQuery(overviewQuerySchema, c.req.query());
    const filter = resolveFilter(query, today());
    const bucket = resolveBucket(query.bucket, daysInclusive(filter.from, filter.to));
    const options = { bucket, stack: query.stack };
    return c.json(
      respond('overview', { filter, ...options }, () => {
        const dataFirstDay = deps.repos.usage.dayBounds().firstDay;
        return queryOverview(deps.db, filter, { ...options, timeZone: deps.timeZone, dataFirstDay });
      }),
    );
  });
  api.get('/sessions', (c) => {
    const query = parseQuery(sessionsQuerySchema, c.req.query());
    const filter = resolveFilter(query, today());
    const options = { sort: query.sort, limit: query.limit };
    return c.json(respond('sessions', { filter, ...options }, () => querySessions(deps.db, filter, options)));
  });
  api.all('*', (c) => c.json({ error: 'not_found' }, 404));
  return api;
}
