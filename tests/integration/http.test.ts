import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { OverviewResponse, SessionsResponse, StatusResponse } from '../../src/shared/api.js';
import { ALLOWED_HOSTNAMES, allowedHostnames, createApp, type AppDeps } from '../../src/server/http/app.js';
import { createLogger } from '../../src/server/logger.js';
import { StatusTracker } from '../../src/server/status.js';
import { createRepos } from '../../src/server/db/repos.js';
import type { PriceTable } from '../../src/server/pricing/types.js';
import { createTestDb } from '../helpers/db.js';
import { makeRow, seedScenario, TEST_PRICES } from '../helpers/seed.js';
import { createTree, type Tree } from '../helpers/tree.js';

const NOW = Date.parse('2026-09-11T12:00:00Z');
/** healthStaleMs for these tests: 10 scan intervals of 60 s. */
const STALE_MS = 600_000;
let tree: Tree | undefined;
afterEach(() => tree?.cleanup());

function setup(overrides: Partial<AppDeps> = {}) {
  const { db, repos } = createTestDb();
  seedScenario(repos);
  const status = new StatusTracker(() => NOW);
  const deps: AppDeps = {
    db,
    repos,
    status,
    pricing: { state: () => ({ source: 'snapshot', fetchedAt: '2026-09-01T00:00:00.000Z', unpricedModels: ['claude-mystery'] }) },
    timeZone: 'UTC',
    now: () => NOW,
    logger: createLogger('silent'),
    webRoot: null,
    healthStaleMs: STALE_MS,
    allowedHosts: [],
    ...overrides,
  };
  const app = createApp(deps);
  const get = async (path: string) => {
    const response = await app.request(path);
    return { response, body: (await response.json()) as unknown };
  };
  return { app, db, status, get };
}

describe('GET /api/status', () => {
  it('reports sync, pricing and data bounds with security headers', async () => {
    const { get } = setup();
    const { response, body } = await get('/api/status');
    expect(response.status).toBe(200);
    expect(body as StatusResponse).toMatchObject({
      now: '2026-09-11T12:00:00.000Z',
      today: '2026-09-11',
      tz: 'UTC',
      sync: { state: 'idle', lastSyncAt: null, lastChangeAt: null },
      pricing: { source: 'snapshot', unpricedModels: ['claude-mystery'] },
      data: { firstDay: '2026-09-09', lastDay: '2026-09-11', rows: 5 },
    });
    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
        "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'none'",
    );
    expect(response.headers.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=()');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('reports the data-quality counters', async () => {
    const { get, status } = setup();
    status.addSkipped(3);
    status.addDroppedIterations(2);
    status.addUsageMismatches(1);
    const { body } = await get('/api/status');
    expect(body).toMatchObject({ sync: { skippedLines: 3, droppedIterations: 2, usageMismatches: 1 } });
  });

  it('returns a generic 500 when a dependency fails', async () => {
    const { get } = setup({
      pricing: {
        state: () => {
          throw new Error('secret detail');
        },
      },
    });
    const { response, body } = await get('/api/status');
    expect(response.status).toBe(500);
    expect(body).toEqual({ error: 'internal_error' });
  });
});

describe('host allowlist', () => {
  it('rejects a request addressed to an unknown Host header', async () => {
    const { app } = setup();
    const response = await app.request('http://evil.example:8739/api/status');
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden_host' });
  });

  it('allows requests addressed to 127.0.0.1 and [::1]', async () => {
    const { app } = setup();
    expect((await app.request('http://127.0.0.1:8739/api/status')).status).toBe(200);
    expect((await app.request('http://[::1]:8739/healthz')).status).toBe(200);
  });

  it('also answers the extra hostnames from allowedHosts, and still the loopback names', async () => {
    const { app } = setup({ allowedHosts: ['monitor.lan'] });
    expect((await app.request('http://monitor.lan:8739/healthz')).status).toBe(200);
    expect((await app.request('http://localhost:8739/healthz')).status).toBe(200);
    const other = await app.request('http://evil.lan:8739/healthz');
    expect(other.status).toBe(403);
    expect(await other.json()).toEqual({ error: 'forbidden_host' });
  });

  it('builds the allowed set from the default names plus the extra ones', () => {
    expect([...allowedHostnames(['monitor.lan'])]).toEqual(['localhost', '127.0.0.1', '[::1]', 'monitor.lan']);
    expect([...ALLOWED_HOSTNAMES]).toEqual(['localhost', '127.0.0.1', '[::1]']);
  });
});

describe('fetch metadata', () => {
  it.each(['cross-site', 'same-site'])('rejects an API request with Sec-Fetch-Site: %s', async (site) => {
    const { app } = setup();
    const response = await app.request('/api/overview', { headers: { 'Sec-Fetch-Site': site } });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden_site' });
  });

  it.each(['same-origin', 'none'])('allows an API request with Sec-Fetch-Site: %s', async (site) => {
    const { app } = setup();
    expect((await app.request('/api/status', { headers: { 'Sec-Fetch-Site': site } })).status).toBe(200);
  });

  it('allows an API request without Sec-Fetch-Site', async () => {
    const { app } = setup();
    expect((await app.request('/api/status')).status).toBe(200);
  });
});

describe('API response cache', () => {
  const OVERVIEW = '/api/overview?from=2026-09-10&to=2026-09-11';
  /** A row stored behind the API's back: the cache only notices it once status.fileDone moves the data version. */
  const lateRow = (messageId: string, sessionId = 'alpha-1') =>
    makeRow({ messageId, sessionId, ts: Date.parse('2026-09-11T10:00:00Z'), localDay: '2026-09-11', output: 1_000 });

  it('serves a repeated request from the cache until a file finishes', async () => {
    const { get, db, status } = setup();
    const first = await get(OVERVIEW);
    expect(first.body).toMatchObject({ totals: { tokensTotal: 91_800 } });
    createRepos(db).usage.upsert(lateRow('late-1'));
    expect((await get(OVERVIEW)).body).toEqual(first.body);
    status.fileDone(0);
    expect((await get(OVERVIEW)).body).toMatchObject({ totals: { tokensTotal: 92_800 } });
  });

  it('recomputes after a price refresh changes the fetch time', async () => {
    let fetchedAt = '2026-09-01T00:00:00.000Z';
    const { get, db } = setup({ pricing: { state: () => ({ source: 'litellm', fetchedAt, unpricedModels: [] }) } });
    const first = await get(OVERVIEW);
    expect(first.body).toMatchObject({ totals: { cost: { total: expect.closeTo(0.922625, 10) } } });
    const doubledOutput: PriceTable = Object.fromEntries(
      Object.entries(TEST_PRICES).map(([key, entry]) => [key, { ...entry, output: entry.output * 2 }]),
    );
    createRepos(db).prices.replaceAll(doubledOutput, 'litellm', Date.parse('2026-09-11T00:00:00Z'));
    expect((await get(OVERVIEW)).body).toEqual(first.body);
    fetchedAt = '2026-09-11T00:00:00.000Z';
    expect((await get(OVERVIEW)).body).toMatchObject({ totals: { cost: { total: expect.closeTo(1.082625, 10) } } });
  });

  it('caches /api/sessions and /api/filters under the same rule', async () => {
    const { get, db, status } = setup();
    const sessions = await get('/api/sessions');
    const filters = await get('/api/filters');
    const repos = createRepos(db);
    repos.usage.upsert(lateRow('late-2', 'gamma-1'));
    repos.prices.setMappings([{ model: 'claude-newcomer', priceKey: null }], 0);
    expect((await get('/api/sessions')).body).toEqual(sessions.body);
    expect((await get('/api/filters')).body).toEqual(filters.body);
    status.fileDone(0);
    expect((await get('/api/sessions')).body).toMatchObject({ total: 4 });
    expect((await get('/api/filters')).body).toMatchObject({
      models: expect.arrayContaining([expect.objectContaining({ id: 'claude-newcomer' })]),
    });
  });

  it('keys a response by its resolved query', async () => {
    const { get, db } = setup();
    await get('/api/overview?from=2026-09-10&to=2026-09-10');
    createRepos(db).usage.upsert(lateRow('late-3'));
    expect((await get(OVERVIEW)).body).toMatchObject({ totals: { tokensTotal: 92_800 } });
  });

  it('recomputes a request without parameters once the local day rolls over', async () => {
    let clock = NOW;
    const { get } = setup({ now: () => clock });
    expect((await get('/api/overview')).body).toMatchObject({ range: { to: '2026-09-11' } });
    clock = Date.parse('2026-09-12T00:30:00Z');
    expect((await get('/api/overview')).body).toMatchObject({ range: { to: '2026-09-12' } });
  });

  it('never caches /api/status', async () => {
    const { get, db } = setup();
    expect((await get('/api/status')).body).toMatchObject({ data: { rows: 5 } });
    createRepos(db).usage.upsert(lateRow('late-4'));
    expect((await get('/api/status')).body).toMatchObject({ data: { rows: 6 } });
  });
});

describe('calendar clock', () => {
  const CALENDAR_NOW = Date.parse('2026-03-15T12:00:00.000Z');

  it('drives today, status.now and the default range', async () => {
    const { get } = setup({ calendarNow: () => CALENDAR_NOW });
    expect((await get('/api/status')).body).toMatchObject({ now: '2026-03-15T12:00:00.000Z', today: '2026-03-15' });
    expect((await get('/api/overview')).body).toMatchObject({
      range: { from: '2026-02-14', to: '2026-03-15', days: 30, bucket: 'day' },
    });
  });

  it('leaves health and sync ages on the real clock', async () => {
    const { get, status } = setup({ calendarNow: () => CALENDAR_NOW });
    status.beginCycle({ backfill: false, filesTotal: 0, bytesTotal: 0 });
    status.endCycle({ changed: false });
    const health = await get('/healthz');
    expect(health.response.status).toBe(200);
    expect(health.body).toEqual({ ok: true, lastSyncAgeSec: 0 });
  });
});

describe('GET /api/filters', () => {
  it('lists models and projects', async () => {
    const { body } = await setup().get('/api/filters');
    expect((body as { models: unknown[] }).models).toHaveLength(4);
    expect((body as { projects: unknown[] }).projects).toHaveLength(2);
  });
});

describe('GET /api/overview', () => {
  it('uses hourly buckets for a two-day range', async () => {
    const { body } = await setup().get('/api/overview?from=2026-09-10&to=2026-09-11');
    const overview = body as OverviewResponse;
    expect(overview.range).toEqual({ from: '2026-09-10', to: '2026-09-11', days: 2, bucket: 'hour' });
    expect(overview.series.buckets).toHaveLength(48);
    expect(overview.totals.cost.total).toBeCloseTo(0.922625, 10);
  });

  it('defaults to the last 30 days with daily buckets', async () => {
    const { body } = await setup().get('/api/overview');
    const overview = body as OverviewResponse;
    expect(overview.range).toEqual({ from: '2026-08-13', to: '2026-09-11', days: 30, bucket: 'day' });
    expect(overview.series.buckets).toHaveLength(30);
  });

  it('applies model filters and stack selection', async () => {
    const { body } = await setup().get('/api/overview?from=2026-09-09&to=2026-09-11&models=claude-opus-5&stack=type');
    const overview = body as OverviewResponse;
    expect(overview.totals.cost.total).toBeCloseTo(0.062625, 10);
    expect(overview.series.stack).toBe('type');
  });

  it.each([
    ['/api/overview?from=2026-02-30'],
    ['/api/overview?from=2026-09-11&to=2026-09-01'],
    ['/api/overview?bucket=hour'],
    ['/api/overview?stack=bogus'],
    ['/api/overview?from=9999-12-31&to=9999-12-31'],
  ])('rejects %s with 400', async (path) => {
    const { response, body } = await setup().get(path);
    expect(response.status).toBe(400);
    expect(body).toMatchObject({ error: 'invalid_query' });
  });

  it('marks error responses as not cacheable', async () => {
    const { get } = setup();
    const { response } = await get('/api/overview?from=2026-01-01&to=2026-02-01&bucket=hour');
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('GET /api/sessions', () => {
  it('limits the list and reports the total', async () => {
    const { body } = await setup().get('/api/sessions?limit=1');
    const sessions = body as SessionsResponse;
    expect(sessions.total).toBe(3);
    expect(sessions.sessions.map((s) => s.id)).toEqual(['beta-1']);
  });

  it('rejects an invalid limit', async () => {
    const { response } = await setup().get('/api/sessions?limit=0');
    expect(response.status).toBe(400);
  });
});

describe('health and fallbacks', () => {
  it('reports health and the age of the last sync', async () => {
    const { get, status } = setup();
    expect((await get('/healthz')).body).toEqual({ ok: true, lastSyncAgeSec: null });
    status.beginCycle({ backfill: false, filesTotal: 0, bytesTotal: 0 });
    status.endCycle({ changed: false });
    expect((await get('/healthz')).body).toEqual({ ok: true, lastSyncAgeSec: 0 });
  });

  it('returns 503 when the database is unavailable', async () => {
    const { get, db } = setup();
    db.close();
    const { response, body } = await get('/healthz');
    expect(response.status).toBe(503);
    expect(body).toEqual({ ok: false, lastSyncAgeSec: null });
  });

  it('stays healthy before the first ingest cycle starts, however much time has passed', async () => {
    const { get } = setup({ now: () => NOW + 10 * STALE_MS });
    const { response, body } = await get('/healthz');
    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, lastSyncAgeSec: null });
  });

  it('returns 503 when the first ingest cycle has not started within healthStaleMs of start-up', async () => {
    let now = NOW;
    const { get } = setup({ now: () => now });
    now = NOW + STALE_MS;
    const atLimit = await get('/healthz');
    expect(atLimit.response.status).toBe(200);
    expect(atLimit.body).toEqual({ ok: true, lastSyncAgeSec: null });
    now = NOW + STALE_MS + 1;
    const stale = await get('/healthz');
    expect(stale.response.status).toBe(503);
    expect(stale.body).toEqual({ ok: false, lastSyncAgeSec: null });
  });

  it('stays healthy while the last ingest progress is exactly healthStaleMs old', async () => {
    const { get, status } = setup({ now: () => NOW + STALE_MS });
    status.beginCycle({ backfill: false, filesTotal: 0, bytesTotal: 0 });
    status.endCycle({ changed: false });
    const { response, body } = await get('/healthz');
    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, lastSyncAgeSec: 600 });
  });

  it('returns 503 once ingest has made no progress for longer than healthStaleMs', async () => {
    const { get, status } = setup({ now: () => NOW + STALE_MS + 1_000 });
    status.beginCycle({ backfill: false, filesTotal: 0, bytesTotal: 0 });
    status.endCycle({ changed: false });
    const { response, body } = await get('/healthz');
    expect(response.status).toBe(503);
    expect(body).toEqual({ ok: false, lastSyncAgeSec: 601 });
  });

  it('returns 503 when a cycle started and then stalled', async () => {
    const { get, status } = setup({ now: () => NOW + STALE_MS + 1 });
    status.beginCycle({ backfill: true, filesTotal: 3, bytesTotal: 300 });
    const { response, body } = await get('/healthz');
    expect(response.status).toBe(503);
    expect(body).toEqual({ ok: false, lastSyncAgeSec: null });
  });

  it('returns JSON 404 for unknown API routes', async () => {
    const { response, body } = await setup().get('/api/nope');
    expect(response.status).toBe(404);
    expect(body).toEqual({ error: 'not_found' });
  });

  /** A built web root as Vite writes it: index.html plus one hashed bundle under assets/. */
  function writeSpaRoot(): string {
    tree = createTree();
    mkdirSync(join(tree.root, 'assets'), { recursive: true });
    writeFileSync(join(tree.root, 'index.html'), '<!doctype html><title>claude-code-monitor</title>');
    writeFileSync(join(tree.root, 'assets', 'app.js'), 'console.log("ok");');
    return tree.root;
  }

  it('serves the SPA when a built web root exists', async () => {
    const { app } = setup({ webRoot: writeSpaRoot() });
    const index = await app.request('/');
    expect(index.status).toBe(200);
    expect(await index.text()).toContain('<title>claude-code-monitor</title>');
    expect(await (await app.request('/some/client/route')).text()).toContain('<title>claude-code-monitor</title>');
    expect(await (await app.request('/assets/app.js')).text()).toContain('console.log');
    const api404 = await app.request('/api/nope');
    expect(api404.status).toBe(404);
    expect(await api404.json()).toEqual({ error: 'not_found' });
  });

  it('revalidates index.html, caches hashed assets for a year and answers a missing asset with 404', async () => {
    const root = writeSpaRoot();
    writeFileSync(join(root, 'assets', '.secret'), 'top secret');
    const { app } = setup({ webRoot: root });
    const index = await app.request('/');
    expect(index.headers.get('cache-control')).toBe('no-cache');
    expect(await index.text()).toContain('<title>claude-code-monitor</title>');
    const fallback = await app.request('/some/client/route');
    expect(fallback.headers.get('cache-control')).toBe('no-cache');
    expect(await fallback.text()).toContain('<title>claude-code-monitor</title>');
    const bundle = await app.request('/assets/app.js');
    expect(bundle.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await bundle.text()).toContain('console.log');
    const missing = await app.request('/assets/missing.js');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found' });
    const dotFile = await app.request('/assets/.secret');
    expect(dotFile.status).toBe(404);
    expect(await dotFile.json()).toEqual({ error: 'not_found' });
  });

  it('serves no static files when the web root has no index.html', async () => {
    tree = createTree();
    writeFileSync(join(tree.root, 'other.txt'), 'not an app');
    const { app } = setup({ webRoot: tree.root });
    const response = await app.request('/');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
  });

  it('does not serve the SPA index for POST /', async () => {
    tree = createTree();
    writeFileSync(join(tree.root, 'index.html'), '<!doctype html><title>claude-code-monitor</title>');
    const { app } = setup({ webRoot: tree.root });
    const response = await app.request('/', { method: 'POST' });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
  });

  it('does not serve dot-files or dot-directories from the web root', async () => {
    tree = createTree();
    writeFileSync(join(tree.root, 'index.html'), '<!doctype html><title>claude-code-monitor</title>');
    writeFileSync(join(tree.root, '.secret'), 'top secret');
    const { app } = setup({ webRoot: tree.root });
    const plain = await (await app.request('/.secret')).text();
    const encoded = await (await app.request('/%2esecret')).text();
    expect(plain).toContain('<title>claude-code-monitor</title>');
    expect(plain).not.toContain('top secret');
    expect(encoded).toContain('<title>claude-code-monitor</title>');
    expect(encoded).not.toContain('top secret');
  });

  it('does not serve files outside the web root via path traversal', async () => {
    tree = createTree();
    writeFileSync(join(tree.root, 'index.html'), '<!doctype html><title>claude-code-monitor</title>');
    const secretPath = join(dirname(tree.root), 'secret.txt');
    writeFileSync(secretPath, 'do not leak');
    try {
      const { app } = setup({ webRoot: tree.root });
      const dotDotSlashEncoded = await (await app.request('/..%2fsecret.txt')).text();
      const fullyEncoded = await (await app.request('/%2e%2e/secret.txt')).text();
      expect(dotDotSlashEncoded).not.toContain('do not leak');
      expect(fullyEncoded).not.toContain('do not leak');
    } finally {
      rmSync(secretPath, { force: true });
    }
  });
});
