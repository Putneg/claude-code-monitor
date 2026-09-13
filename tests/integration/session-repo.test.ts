import { describe, expect, it } from 'vitest';
import { projectIdFor } from '../../src/server/db/session-merge.js';
import { createSessionRepo } from '../../src/server/db/session-repo.js';
import { createMigratedDb } from '../helpers/db.js';

function setup() {
  const db = createMigratedDb();
  const changes = (): number => db.prepare<[], { n: number }>('SELECT total_changes() AS n').get()?.n ?? 0;
  return { repo: createSessionRepo(db), changes };
}

describe('session repo', () => {
  it('creates and merges sessions from touches', () => {
    const { repo } = setup();
    repo.touch({ sessionId: 's1', cwd: '/home/dev/alpha', isSidechain: false, ts: 2_000 });
    repo.touch({ sessionId: 's1', cwd: '/home/dev/other', isSidechain: false, ts: 3_000 });
    repo.touch({ sessionId: 's1', cwd: '/home/dev/sub', isSidechain: true, ts: 1_000 });
    expect(repo.get('s1')).toEqual({
      sessionId: 's1',
      projectPath: '/home/dev/alpha',
      projectId: projectIdFor('/home/dev/alpha'),
      projectSource: 'main',
      projectTs: 2_000,
      title: null,
    });
  });

  it('stores the latest title, even before any usage', () => {
    const { repo } = setup();
    repo.setTitle('s2', 'First title');
    repo.setTitle('s2', 'Renamed');
    expect(repo.get('s2')).toMatchObject({ title: 'Renamed', projectPath: null });
    repo.touch({ sessionId: 's2', cwd: '/x', isSidechain: false, ts: 5 });
    expect(repo.get('s2')).toMatchObject({ title: 'Renamed', projectPath: '/x', projectTs: 5 });
  });

  it('skips the write when a touch or a title changes nothing', () => {
    const { repo, changes } = setup();
    repo.touch({ sessionId: 's3', cwd: '/home/dev/alpha', isSidechain: false, ts: 1_000 });
    repo.setTitle('s3', 'Same title');
    const before = changes();
    repo.touch({ sessionId: 's3', cwd: '/home/dev/alpha', isSidechain: false, ts: 5_000 });
    repo.touch({ sessionId: 's3', cwd: null, isSidechain: false, ts: 6_000 });
    repo.setTitle('s3', 'Same title');
    expect(changes()).toBe(before);
    repo.setTitle('s3', 'New title');
    expect(changes()).toBe(before + 1);
  });

  it('stores nothing for a touch without cwd on an unknown session', () => {
    const { repo } = setup();
    repo.touch({ sessionId: 's4', cwd: null, isSidechain: false, ts: 1 });
    expect(repo.get('s4')).toBeUndefined();
  });

  it('returns undefined for unknown sessions', () => {
    expect(setup().repo.get('missing')).toBeUndefined();
  });
});
