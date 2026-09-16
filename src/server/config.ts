import { homedir } from 'node:os';
import { join, resolve as resolvePath, sep } from 'node:path';
import { z } from 'zod';
import { isValidTimeZone } from './time.js';

export const DEFAULT_PRICING_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
  readonly port: number;
  readonly host: string;
  /** Extra hostnames the HTTP server answers besides localhost, 127.0.0.1 and [::1]; lower-case, no port. */
  readonly allowedHosts: readonly string[];
  readonly projectsDirs: readonly string[];
  /** Codex rollout folders: <home>/sessions and <home>/archived_sessions for every CODEX_HOME entry. Optional sources. */
  readonly codexRoots: readonly string[];
  readonly dbPath: string;
  readonly scanIntervalMs: number;
  readonly timeZone: string;
  readonly pricingUrl: string;
  readonly pricingRefreshMs: number;
  readonly logLevel: LogLevel;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

const hostTimeZone = (): string | undefined => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The host zone, or 'UTC' when the runtime reports none or an invalid one. */
export function defaultTimeZone(resolve: () => string | undefined = hostTimeZone): string {
  const zone = resolve();
  return zone !== undefined && isValidTimeZone(zone) ? zone : 'UTC';
}

/** Plain http is accepted only from these hosts: tests and the e2e server use a loopback price URL. */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);
export const PRICING_URL_RULE = 'must be an https URL (http is allowed only for localhost)';

/** https, or http on a loopback host. Must not throw: zod runs this refinement even after z.url() has rejected the value. */
export function isAllowedPricingUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(url.hostname));
}

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(8739),
  HOST: z.string().trim().min(1).default('127.0.0.1'),
  ALLOWED_HOSTS: z.string().optional(),
  CLAUDE_PROJECTS_DIRS: z.string().optional(),
  CODEX_HOME: z.string().optional(),
  DB_PATH: z.string().trim().min(1).optional(),
  SCAN_INTERVAL_SEC: z.coerce.number().int().min(10).max(3_600).default(60),
  TZ: z
    .string()
    .trim()
    .refine(isValidTimeZone, 'must be a valid IANA time zone')
    .default(() => defaultTimeZone()),
  PRICING_URL: z.url().refine(isAllowedPricingUrl, PRICING_URL_RULE).default(DEFAULT_PRICING_URL),
  PRICING_REFRESH_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
});

/** A DNS name (labels of letters, digits and inner hyphens) or a bracketed IPv6 literal, checked after lower-casing. */
const HOSTNAME_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const IPV6_LITERAL_PATTERN = /^\[[0-9a-f:.]+\]$/;

/** The name as the host check sees it (WHATWG URL form, e.g. [fe80::1]), or null when `item` is not a hostname. */
function canonicalHostname(item: string): string | null {
  const lower = item.toLowerCase();
  if (!HOSTNAME_PATTERN.test(lower) && !IPV6_LITERAL_PATTERN.test(lower)) return null;
  const url = `http://${lower}/`;
  return URL.canParse(url) ? new URL(url).hostname : null;
}

/** Comma-separated extra hostnames, each listed once. They extend the loopback names and never replace them. */
function parseAllowedHosts(value: string | undefined): string[] {
  const hosts = (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((item) => {
      const host = canonicalHostname(item);
      if (host === null) throw new ConfigError(`Invalid configuration: ALLOWED_HOSTS: "${item}" is not a hostname`);
      return host;
    });
  return [...new Set(hosts)];
}

const expandHome = (path: string): string => (path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);

/** True when `child` is `parent` or lies below it. */
const isWithin = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/**
 * Drops repeated roots and roots inside another root, keeping the rest in first-occurrence order: a nested root would
 * be scanned twice per cycle. Expects resolved paths; compares them case-insensitively when asked (win32).
 */
export function collapseRoots(dirs: readonly string[], caseInsensitive: boolean): string[] {
  const keyOf = (dir: string): string => (caseInsensitive ? dir.toLowerCase() : dir);
  const keys = dirs.map(keyOf);
  return dirs.filter((dir, index) => {
    const key = keyOf(dir);
    return !keys.some((other, at) => at !== index && isWithin(key, other) && (key !== other || at < index));
  });
}

/** Comma-separated paths with `~` expanded, resolved to absolute paths; blank entries are dropped. */
function splitPaths(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => resolvePath(expandHome(part)));
}

const CASE_INSENSITIVE_PATHS = process.platform === 'win32';

/** Comma-separated roots, resolved to absolute paths; see collapseRoots for repeated and nested ones. */
function parseDirs(value: string | undefined): string[] {
  const dirs = splitPaths(value ?? join(homedir(), '.claude', 'projects'));
  if (dirs.length === 0) throw new ConfigError('Invalid configuration: CLAUDE_PROJECTS_DIRS must contain at least one path');
  return collapseRoots(dirs, CASE_INSENSITIVE_PATHS);
}

/** The folders below a Codex home that hold rollout files. */
export const CODEX_SESSION_FOLDERS = ['sessions', 'archived_sessions'] as const;

/** The rollout folders of every CODEX_HOME entry, or of ~/.codex when CODEX_HOME is unset or blank. */
function parseCodexRoots(value: string | undefined): string[] {
  const listed = splitPaths(value ?? '');
  const homes = listed.length > 0 ? listed : [join(homedir(), '.codex')];
  const roots = homes.flatMap((home) => CODEX_SESSION_FOLDERS.map((folder) => join(home, folder)));
  return collapseRoots(roots, CASE_INSENSITIVE_PATHS);
}

/** A file under both a Claude root and a Codex root would reach the wrong parser, so the two sets must not overlap. */
function assertSeparateRoots(claudeDirs: readonly string[], codexRoots: readonly string[]): void {
  const key = (path: string): string => (CASE_INSENSITIVE_PATHS ? path.toLowerCase() : path);
  const overlaps = (a: string, b: string): boolean => isWithin(key(a), key(b)) || isWithin(key(b), key(a));
  const clash = codexRoots.find((root) => claudeDirs.some((dir) => overlaps(root, dir)));
  if (clash !== undefined) {
    throw new ConfigError(`Invalid configuration: CODEX_HOME: ${clash} overlaps a CLAUDE_PROJECTS_DIRS entry`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new ConfigError(`Invalid configuration: ${details}`);
  }
  const values = parsed.data;
  const projectsDirs = parseDirs(values.CLAUDE_PROJECTS_DIRS);
  const codexRoots = parseCodexRoots(values.CODEX_HOME);
  assertSeparateRoots(projectsDirs, codexRoots);
  return {
    port: values.PORT,
    host: values.HOST,
    allowedHosts: parseAllowedHosts(values.ALLOWED_HOSTS),
    projectsDirs,
    codexRoots,
    dbPath: values.DB_PATH ?? join(process.cwd(), 'data', 'monitor.db'),
    scanIntervalMs: values.SCAN_INTERVAL_SEC * 1_000,
    timeZone: values.TZ,
    pricingUrl: values.PRICING_URL,
    pricingRefreshMs: values.PRICING_REFRESH_HOURS * 3_600_000,
    logLevel: values.LOG_LEVEL,
  };
}
