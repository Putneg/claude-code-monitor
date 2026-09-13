import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type MiddlewareHandler } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import type { HealthResponse } from '../../shared/api.js';
import { createApi, handleError, type ApiDeps } from './api.js';

export interface AppDeps extends ApiDeps {
  /** Directory with the built dashboard. Static serving is skipped when it has no index.html. */
  readonly webRoot: string | null;
  /** Hostnames answered besides localhost, 127.0.0.1 and [::1] (Config.allowedHosts). */
  readonly allowedHosts: readonly string[];
  /** /healthz answers 503 after this long without ingest progress, counted from app creation until the first cycle. */
  readonly healthStaleMs: number;
}

export const CONTENT_SECURITY_POLICY = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  // 'unsafe-inline' only because the ECharts tooltip builds its HTML with style="" attributes.
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", 'data:'],
  fontSrc: ["'self'"],
  connectSrc: ["'self'"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  frameAncestors: ["'none'"],
  formAction: ["'none'"],
};

/** Browser features the dashboard never uses. hono renders `false` as `feature=()`, which denies it to every origin. */
export const PERMISSIONS_POLICY = {
  camera: false,
  microphone: false,
  geolocation: false,
  payment: false,
  usb: false,
  fullscreen: false,
};

/** Hostnames this server always answers. Blocks DNS rebinding: a page on an attacker's domain cannot point its Host header at 127.0.0.1 to read the API. */
export const ALLOWED_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The default hostnames plus `extra` (Config.allowedHosts, already lower-case): extra names extend the set, never replace it. */
export function allowedHostnames(extra: readonly string[]): ReadonlySet<string> {
  return new Set([...ALLOWED_HOSTNAMES, ...extra]);
}

/** 403 unless the request's hostname is allowed. Not access control: any client that reaches the port can send Host: localhost. */
function createHostCheck(allowed: ReadonlySet<string>): MiddlewareHandler {
  return async (c, next) => {
    const hostname = new URL(c.req.url).hostname;
    if (!allowed.has(hostname)) return c.json({ error: 'forbidden_host' }, 403);
    return next();
  };
}

/** Sec-Fetch-Site values a browser sends for requests that another site's page started. */
const FOREIGN_SITES: ReadonlySet<string> = new Set(['cross-site', 'same-site']);

/**
 * Refuses API requests that another site's page started. Their responses are unreadable anyway (no CORS), but the
 * queries still cost CPU. Requests without the header (non-browser clients such as curl and scripts) pass.
 */
const checkFetchSite: MiddlewareHandler = async (c, next) => {
  const site = c.req.header('sec-fetch-site');
  if (site !== undefined && FOREIGN_SITES.has(site)) return c.json({ error: 'forbidden_site' }, 403);
  return next();
};

/** True when any path segment starts with '.' (dot-files/dot-directories such as .env or .git). */
const hasDotSegment = (path: string): boolean => path.split('/').some((segment) => segment.startsWith('.'));

/** index.html and other unhashed files: revalidate, so a rebuilt image never serves a page that points at missing bundles. */
const REVALIDATE_CACHE_CONTROL = 'no-cache';
/** Vite's hashed bundles under /assets/: the name changes with the content, so they never go stale. */
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * Sets Cache-Control on the files the static handlers serve; a 404 keeps no cache header. A middleware, because
 * serveStatic's onFound runs after the response is built, so a header set there never reaches the client.
 */
const staticCacheControl: MiddlewareHandler = async (c, next) => {
  await next();
  if (c.res.ok) c.header('Cache-Control', c.req.path.startsWith('/assets/') ? IMMUTABLE_CACHE_CONTROL : REVALIDATE_CACHE_CONTROL);
};

/**
 * Mounts SPA static serving: real files under webRoot for GET, index.html as the client-routing fallback.
 * Dot-paths never reach the filesystem, and a missing file under /assets/ is a 404 rather than index.html.
 */
function mountStatic(app: Hono, webRoot: string): void {
  const assets = serveStatic({ root: webRoot });
  const index = serveStatic({ root: webRoot, path: 'index.html' });
  app.get('*', staticCacheControl);
  app.get('*', (c, next) => (hasDotSegment(c.req.path) ? next() : assets(c, next)));
  app.get('/assets/*', (c) => c.notFound());
  app.get('*', index);
}

function health(deps: AppDeps, startedAt: number): { body: HealthResponse; status: 200 | 503 } {
  try {
    deps.db.prepare('SELECT 1').get();
  } catch (error) {
    deps.logger.error({ err: error }, 'health check failed');
    return { body: { ok: false, lastSyncAgeSec: null }, status: 503 };
  }
  const lastSyncAt = deps.status.snapshot().sync.lastSyncAt;
  const lastSyncAgeSec = lastSyncAt === null ? null : Math.round((deps.now() - Date.parse(lastSyncAt)) / 1_000);
  // Until the first cycle starts, staleness counts from app creation, so a first scan that never begins is reported.
  const progressAt = deps.status.lastProgressAt() ?? startedAt;
  const stalled = deps.now() - progressAt > deps.healthStaleMs;
  if (stalled) return { body: { ok: false, lastSyncAgeSec }, status: 503 };
  return { body: { ok: true, lastSyncAgeSec }, status: 200 };
}

export function createApp(deps: AppDeps): Hono {
  const startedAt = deps.now();
  const app = new Hono();
  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: CONTENT_SECURITY_POLICY,
      xContentTypeOptions: true,
      referrerPolicy: 'no-referrer',
      strictTransportSecurity: false,
      permissionsPolicy: PERMISSIONS_POLICY,
    }),
  );
  app.use('*', createHostCheck(allowedHostnames(deps.allowedHosts)));
  app.use('/api/*', checkFetchSite);
  app.onError(handleError(deps.logger));
  app.get('/healthz', (c) => {
    const result = health(deps, startedAt);
    return c.json(result.body, result.status);
  });
  app.route('/api', createApi(deps));
  if (deps.webRoot !== null && existsSync(join(deps.webRoot, 'index.html'))) {
    mountStatic(app, deps.webRoot);
  }
  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  return app;
}
