import { describe, expect, it } from 'vitest';
import { emptySession, mergeTouch, projectIdFor, sameSession, withTitle, type SessionRecord } from '../../src/server/db/session-merge.js';

const touch = (overrides: Partial<Parameters<typeof mergeTouch>[1]> = {}) => ({
  sessionId: 's1',
  cwd: '/home/dev/alpha',
  isSidechain: false,
  ts: 1_000,
  ...overrides,
});

describe('projectIdFor', () => {
  it('returns 10 stable hex characters', () => {
    expect(projectIdFor('/home/dev/alpha')).toMatch(/^[0-9a-f]{10}$/);
    expect(projectIdFor('/home/dev/alpha')).toBe(projectIdFor('/home/dev/alpha'));
    expect(projectIdFor('/home/dev/alpha')).not.toBe(projectIdFor('/home/dev/beta'));
  });
});

describe('mergeTouch', () => {
  it('sets the project on an empty session', () => {
    const merged = mergeTouch(emptySession('s1'), touch());
    expect(merged).toEqual({
      sessionId: 's1',
      projectPath: '/home/dev/alpha',
      projectId: projectIdFor('/home/dev/alpha'),
      projectSource: 'main',
      projectTs: 1_000,
      title: null,
    });
  });

  it('keeps the earliest main cwd', () => {
    const first = mergeTouch(emptySession('s1'), touch({ ts: 2_000, cwd: '/later' }));
    const second = mergeTouch(first, touch({ ts: 1_000, cwd: '/earlier' }));
    const third = mergeTouch(second, touch({ ts: 3_000, cwd: '/latest' }));
    expect(third).toMatchObject({ projectPath: '/earlier', projectTs: 1_000 });
  });

  it('lets main rows displace a sidechain project', () => {
    const fromSubagent = mergeTouch(emptySession('s1'), touch({ isSidechain: true, cwd: '/sub', ts: 500 }));
    expect(fromSubagent.projectSource).toBe('sidechain');
    const fromMain = mergeTouch(fromSubagent, touch({ cwd: '/main', ts: 900 }));
    expect(fromMain).toMatchObject({ projectPath: '/main', projectSource: 'main', projectTs: 900 });
  });

  it('never lets a sidechain row displace a main project', () => {
    const fromMain = mergeTouch(emptySession('s1'), touch({ cwd: '/main', ts: 900 }));
    expect(mergeTouch(fromMain, touch({ isSidechain: true, cwd: '/sub', ts: 100 }))).toEqual(fromMain);
  });

  it('leaves the session as it is for a touch without cwd', () => {
    const base = mergeTouch(emptySession('s1'), touch());
    expect(mergeTouch(base, touch({ cwd: null, ts: 42 }))).toEqual(base);
    expect(mergeTouch(emptySession('s2'), touch({ sessionId: 's2', cwd: null }))).toEqual(emptySession('s2'));
  });

  it('does not mutate its input', () => {
    const base = emptySession('s1');
    mergeTouch(base, touch());
    expect(base.projectPath).toBeNull();
  });
});

describe('sameSession', () => {
  const base = mergeTouch(emptySession('s1'), touch());

  it('is true for an equal copy', () => {
    expect(sameSession(base, { ...base })).toBe(true);
  });

  it('tells sessions apart by any field', () => {
    const changes: readonly Partial<SessionRecord>[] = [
      { sessionId: 's2' },
      { projectPath: '/other' },
      { projectId: 'other' },
      { projectSource: 'sidechain' },
      { projectTs: 2 },
      { title: 'x' },
    ];
    expect(changes.map((change) => sameSession(base, { ...base, ...change }))).toEqual([false, false, false, false, false, false]);
  });
});

describe('withTitle', () => {
  it('returns a copy with the title', () => {
    const base = emptySession('s1');
    expect(withTitle(base, 'New title').title).toBe('New title');
    expect(base.title).toBeNull();
  });
});
