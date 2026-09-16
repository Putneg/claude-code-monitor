import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collapseRoots, ConfigError, DEFAULT_PRICING_URL, defaultTimeZone, loadConfig } from '../../src/server/config.js';
import { isValidTimeZone } from '../../src/server/time.js';

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig({})).toEqual({
      port: 8739,
      host: '127.0.0.1',
      allowedHosts: [],
      projectsDirs: [join(homedir(), '.claude', 'projects')],
      codexRoots: [join(homedir(), '.codex', 'sessions'), join(homedir(), '.codex', 'archived_sessions')],
      dbPath: join(process.cwd(), 'data', 'monitor.db'),
      scanIntervalMs: 60_000,
      timeZone: defaultTimeZone(),
      pricingUrl: DEFAULT_PRICING_URL,
      pricingRefreshMs: 86_400_000,
      logLevel: 'info',
    });
  });

  it('parses overrides, expands the home directory and resolves the projects directories', () => {
    const config = loadConfig({
      PORT: '9000',
      HOST: '0.0.0.0',
      ALLOWED_HOSTS: 'Monitor.LAN, [FE80:0:0:0:0:0:0:1] ,monitor.lan,',
      CLAUDE_PROJECTS_DIRS: '/claude/projects, ~/other ,',
      CODEX_HOME: '~/codex-a, /codex/b',
      DB_PATH: '/data/monitor.db',
      SCAN_INTERVAL_SEC: '15',
      TZ: 'UTC',
      PRICING_URL: 'https://example.test/prices.json',
      PRICING_REFRESH_HOURS: '6',
      LOG_LEVEL: 'debug',
      UNRELATED_VARIABLE: 'ignored',
    });
    expect(config).toEqual({
      port: 9000,
      host: '0.0.0.0',
      allowedHosts: ['monitor.lan', '[fe80::1]'],
      projectsDirs: [resolve('/claude/projects'), join(homedir(), 'other')],
      codexRoots: [
        join(homedir(), 'codex-a', 'sessions'),
        join(homedir(), 'codex-a', 'archived_sessions'),
        resolve('/codex/b/sessions'),
        resolve('/codex/b/archived_sessions'),
      ],
      dbPath: '/data/monitor.db',
      scanIntervalMs: 15_000,
      timeZone: 'UTC',
      pricingUrl: 'https://example.test/prices.json',
      pricingRefreshMs: 21_600_000,
      logLevel: 'debug',
    });
  });

  it('lists a repeated projects directory once, in first-occurrence order', () => {
    expect(loadConfig({ CLAUDE_PROJECTS_DIRS: '/a, /b,/a' }).projectsDirs).toEqual([resolve('/a'), resolve('/b')]);
  });

  it('resolves a relative projects directory and drops a root inside another root', () => {
    expect(loadConfig({ CLAUDE_PROJECTS_DIRS: 'rel/projects, /data/a/b, /data/a' }).projectsDirs).toEqual([
      resolve('rel/projects'),
      resolve('/data/a'),
    ]);
  });

  it('treats a blank ALLOWED_HOSTS as no extra hostnames', () => {
    expect(loadConfig({ ALLOWED_HOSTS: ' , ' }).allowedHosts).toEqual([]);
  });

  it.each([
    'https://example.test/prices.json',
    'http://127.0.0.1:9/unreachable.json',
    'http://localhost:8080/prices.json',
    'http://[::1]:9/prices.json',
  ])('accepts the pricing URL %s', (url) => {
    expect(loadConfig({ PRICING_URL: url }).pricingUrl).toBe(url);
  });

  it.each([
    [{ PORT: 'abc' }, 'PORT'],
    [{ PORT: '' }, 'PORT'],
    [{ PORT: '70000' }, 'PORT'],
    [{ SCAN_INTERVAL_SEC: '5' }, 'SCAN_INTERVAL_SEC'],
    [{ TZ: 'Mars/Olympus_Mons' }, 'TZ'],
    [{ LOG_LEVEL: 'loud' }, 'LOG_LEVEL'],
    [{ PRICING_URL: 'not a url' }, 'PRICING_URL'],
    [{ PRICING_URL: 'http://example.com/prices.json' }, 'PRICING_URL: must be an https URL (http is allowed only for localhost)'],
    [{ PRICING_URL: 'data:application/json,{}' }, 'PRICING_URL: must be an https URL (http is allowed only for localhost)'],
    [{ PRICING_URL: 'http://127.0.0.1.evil.com/p.json' }, 'PRICING_URL: must be an https URL (http is allowed only for localhost)'],
    [{ PRICING_URL: 'http://localhost@evil.com/p.json' }, 'PRICING_URL: must be an https URL (http is allowed only for localhost)'],
    [{ PRICING_REFRESH_HOURS: '0' }, 'PRICING_REFRESH_HOURS'],
    [{ CLAUDE_PROJECTS_DIRS: ' , ' }, 'CLAUDE_PROJECTS_DIRS'],
    [{ ALLOWED_HOSTS: 'monitor.lan,http://evil.lan' }, 'ALLOWED_HOSTS: "http://evil.lan" is not a hostname'],
    [{ ALLOWED_HOSTS: 'monitor.lan:8739' }, 'ALLOWED_HOSTS: "monitor.lan:8739" is not a hostname'],
    [{ ALLOWED_HOSTS: '[::::]' }, 'ALLOWED_HOSTS: "[::::]" is not a hostname'],
    [{ ALLOWED_HOSTS: 'monitor.lan/x' }, 'ALLOWED_HOSTS: "monitor.lan/x" is not a hostname'],
    [{ ALLOWED_HOSTS: 'user@monitor.lan' }, 'ALLOWED_HOSTS: "user@monitor.lan" is not a hostname'],
  ])('rejects %o', (env, expected) => {
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(expected);
  });

  it('lists every invalid variable at once', () => {
    expect(() => loadConfig({ PORT: 'x', LOG_LEVEL: 'y' })).toThrow(/PORT.*LOG_LEVEL|LOG_LEVEL.*PORT/);
  });

  it('uses ~/.codex when CODEX_HOME is blank', () => {
    expect(loadConfig({ CODEX_HOME: ' , ' }).codexRoots).toEqual([
      join(homedir(), '.codex', 'sessions'),
      join(homedir(), '.codex', 'archived_sessions'),
    ]);
  });

  it('lists a repeated Codex home once', () => {
    expect(loadConfig({ CODEX_HOME: '/codex, /codex' }).codexRoots).toEqual([
      resolve('/codex/sessions'),
      resolve('/codex/archived_sessions'),
    ]);
  });

  it.each([
    ['a Codex folder inside a projects directory', { CLAUDE_PROJECTS_DIRS: '/data', CODEX_HOME: '/data/codex' }],
    ['a projects directory inside a Codex folder', { CLAUDE_PROJECTS_DIRS: '/codex/sessions/claude', CODEX_HOME: '/codex' }],
  ])('rejects %s', (_label, env) => {
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(/CODEX_HOME: .* overlaps a CLAUDE_PROJECTS_DIRS entry/);
  });
});

describe('defaultTimeZone', () => {
  it('returns the zone the runtime reports', () => {
    expect(defaultTimeZone(() => 'America/New_York')).toBe('America/New_York');
  });

  it.each([[undefined], [''], ['Mars/Olympus_Mons']])('falls back to UTC when the runtime reports %o', (zone) => {
    expect(defaultTimeZone(() => zone)).toBe('UTC');
  });

  it('uses the host zone by default', () => {
    const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(defaultTimeZone()).toBe(isValidTimeZone(host) ? host : 'UTC');
  });
});

describe('collapseRoots', () => {
  const base = resolve('roots');

  it('drops repeated roots and roots inside another root, keeping first-occurrence order', () => {
    const a = join(base, 'a');
    const c = join(base, 'c');
    expect(collapseRoots([join(a, 'b'), a, c, a, join(c, 'd', 'e')], false)).toEqual([a, c]);
  });

  it('keeps sibling roots that only share a name prefix', () => {
    const roots = [join(base, 'app'), join(base, 'app-data')];
    expect(collapseRoots(roots, false)).toEqual(roots);
  });

  it('compares case-insensitively only when asked, as on Windows', () => {
    const roots = [join(base, 'Projects'), join(base, 'projects', 'Sub'), join(base, 'PROJECTS')];
    expect(collapseRoots(roots, true)).toEqual([join(base, 'Projects')]);
    expect(collapseRoots(roots, false)).toEqual(roots);
  });

  it('treats a filesystem root as containing every other root', () => {
    const top = resolve('/');
    expect(collapseRoots([join(base, 'a'), top], false)).toEqual([top]);
  });
});
