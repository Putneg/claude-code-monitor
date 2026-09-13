import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/server/logger.js';
import { syncTimeZone } from '../../src/server/tz-sync.js';
import { createTestDb } from '../helpers/db.js';

const logger = createLogger('silent');

function seedRow(repos: ReturnType<typeof createTestDb>['repos']): void {
  repos.usage.upsert({
    messageId: 'm1',
    requestId: 'r1',
    kind: 'primary',
    seq: 0,
    sessionId: 's1',
    agentId: null,
    isSidechain: false,
    model: 'claude-opus-5',
    speed: 'standard',
    ts: Date.parse('2026-09-10T22:30:00Z'),
    localDay: '2026-09-10',
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
  });
}

describe('syncTimeZone', () => {
  it('records the zone on first start without touching rows', () => {
    const { repos } = createTestDb();
    expect(syncTimeZone(repos, 'UTC', logger)).toBe(0);
    expect(repos.meta.get('tz')).toBe('UTC');
  });

  it('does nothing when the zone is unchanged', () => {
    const { repos } = createTestDb();
    syncTimeZone(repos, 'UTC', logger);
    seedRow(repos);
    expect(syncTimeZone(repos, 'UTC', logger)).toBe(0);
  });

  it('recomputes local days when the zone changes', () => {
    const { db, repos } = createTestDb();
    syncTimeZone(repos, 'UTC', logger);
    seedRow(repos);
    expect(syncTimeZone(repos, 'Europe/Kyiv', logger)).toBe(1);
    expect(repos.meta.get('tz')).toBe('Europe/Kyiv');
    const row = db.prepare('SELECT local_day FROM usage').get() as { local_day: string };
    expect(row.local_day).toBe('2026-09-11');
  });
});
