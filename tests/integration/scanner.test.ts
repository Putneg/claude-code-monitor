import { chmodSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FileState } from '../../src/server/db/file-state-repo.js';
import { planWork, scanRoot, scanSource, scanSources, type RootScan, type SourceScan } from '../../src/server/ingest/scanner.js';
import { claudeRoot, codexRoot } from '../../src/server/ingest/sources.js';
import { createTree, type Tree } from '../helpers/tree.js';

let tree: Tree;
afterEach(() => tree?.cleanup());

describe('scanSource', () => {
  it('finds jsonl files recursively, including subagent transcripts', async () => {
    tree = createTree();
    tree.write('proj-a/s1.jsonl', ['{}']);
    tree.write('proj-a/s1/subagents/agent-x.jsonl', ['{}']);
    tree.write('proj-a/notes.txt', ['ignore me']);
    const scan = await scanSource(tree.root);
    expect(scan.ok).toBe(true);
    expect(scan.error).toBeNull();
    expect(scan.files.map((f) => f.path).sort()).toEqual(
      [tree.path('proj-a/s1.jsonl'), tree.path('proj-a/s1/subagents/agent-x.jsonl')].sort(),
    );
    expect(scan.files[0]?.size).toBe(3);
    expect(scan.unreadable).toEqual([]);
  });

  it('does not follow directory links', async () => {
    tree = createTree();
    tree.write('proj-a/s1.jsonl', ['{}']);
    const outside = createTree();
    try {
      outside.write('elsewhere/x.jsonl', ['{}']);
      // A junction on Windows and a directory symlink elsewhere; neither needs elevated rights.
      symlinkSync(outside.path('elsewhere'), tree.path('linked'), 'junction');
      const scan = await scanSource(tree.root);
      expect(scan.files.map((f) => f.path)).toEqual([tree.path('proj-a/s1.jsonl')]);
      expect(scan.unreadable).toEqual([]);
    } finally {
      outside.cleanup();
    }
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('skips an unreadable subdirectory and reports it', async () => {
    tree = createTree();
    tree.write('proj-a/s1.jsonl', ['{}']);
    tree.write('locked/s2.jsonl', ['{}']);
    chmodSync(tree.path('locked'), 0o000);
    try {
      const scan = await scanSource(tree.root);
      expect(scan).toMatchObject({ ok: true, error: null });
      expect(scan.files.map((f) => f.path)).toEqual([tree.path('proj-a/s1.jsonl')]);
      expect(scan.unreadable).toEqual([tree.path('locked')]);
    } finally {
      chmodSync(tree.path('locked'), 0o700);
    }
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('skips a file it cannot stat and reports it', async () => {
    tree = createTree();
    tree.write('proj-a/s1.jsonl', ['{}']);
    tree.write('no-search/s2.jsonl', ['{}']);
    // Readable but not searchable: the directory lists its entries, and stat of an entry fails with EACCES.
    chmodSync(tree.path('no-search'), 0o444);
    try {
      const scan = await scanSource(tree.root);
      expect(scan).toMatchObject({ ok: true, error: null });
      expect(scan.files.map((f) => f.path)).toEqual([tree.path('proj-a/s1.jsonl')]);
      expect(scan.unreadable).toEqual([tree.path('no-search/s2.jsonl')]);
    } finally {
      chmodSync(tree.path('no-search'), 0o700);
    }
  });

  it('reports a missing root as not ok', async () => {
    tree = createTree();
    const scan = await scanSource(join(tree.root, 'does-not-exist'));
    expect(scan.ok).toBe(false);
    expect(scan.error).toMatch(/not accessible/);
  });

  it('reports a root without transcripts as not ok', async () => {
    tree = createTree();
    const scan = await scanSource(tree.root);
    expect(scan).toMatchObject({ ok: false, files: [] });
    expect(scan.error).toMatch(/no \.jsonl files/);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'keeps the unreadable entries of a source without readable transcripts',
    async () => {
      tree = createTree();
      tree.write('locked/s1.jsonl', ['{}']);
      chmodSync(tree.path('locked'), 0o000);
      try {
        expect(await scanSource(tree.root)).toEqual({
          root: tree.root,
          ok: false,
          error: 'no readable .jsonl files (unreadable entries: 1)',
          files: [],
          unreadable: [tree.path('locked')],
        });
      } finally {
        chmodSync(tree.path('locked'), 0o700);
      }
    },
  );

  it('scans several roots independently', async () => {
    tree = createTree();
    tree.write('a/s.jsonl', ['{}']);
    const scans = await scanSources([join(tree.root, 'a'), join(tree.root, 'missing')].map(claudeRoot));
    expect(scans.map((s) => s.ok)).toEqual([true, false]);
  });
});

const file = (path: string, size: number, mtimeMs: number) => ({ path, size, mtimeMs });
const okScan = (root: string, files: SourceScan['files'], client: RootScan['client'] = 'claude'): RootScan => ({
  root,
  ok: true,
  error: null,
  files,
  unreadable: [],
  client,
  required: client === 'claude',
});
const state = (path: string, size: number, mtimeMs: number, offset: number): FileState => ({
  path,
  size,
  mtimeMs,
  offset,
  fingerprint: null,
  parserState: null,
});

describe('planWork', () => {
  const root = join('/data', 'projects');
  const p = (name: string) => join(root, name);

  it('decides start offsets per file', () => {
    const known = new Map([
      [p('same.jsonl'), state(p('same.jsonl'), 100, 5, 100)],
      [p('grown.jsonl'), state(p('grown.jsonl'), 100, 5, 90)],
      [p('shrunk.jsonl'), state(p('shrunk.jsonl'), 100, 5, 100)],
    ]);
    const scans = [
      okScan(root, [
        file(p('same.jsonl'), 100, 5),
        file(p('grown.jsonl'), 150, 6),
        file(p('shrunk.jsonl'), 40, 7),
        file(p('new.jsonl'), 10, 1),
      ]),
    ];
    const plan = planWork(scans, known);
    expect(plan.work.map((w) => [w.file.path, w.startOffset])).toEqual([
      [p('new.jsonl'), 0],
      [p('grown.jsonl'), 90],
      [p('shrunk.jsonl'), 0],
    ]);
    expect(plan.pendingBytes).toBe(10 + 60 + 40);
    expect(plan.removed).toEqual([]);
  });

  it('removes state for files that disappeared under an OK root', () => {
    const known = new Map([[p('gone.jsonl'), state(p('gone.jsonl'), 1, 1, 1)]]);
    const plan = planWork([okScan(root, [file(p('other.jsonl'), 1, 1)])], known);
    expect(plan.removed).toEqual([p('gone.jsonl')]);
  });

  it('keeps state for files under a root that failed to scan', () => {
    const known = new Map([[p('kept.jsonl'), state(p('kept.jsonl'), 1, 1, 1)]]);
    const failed: RootScan = {
      root,
      ok: false,
      error: 'not accessible: ENOENT',
      files: [],
      unreadable: [],
      client: 'claude',
      required: true,
    };
    expect(planWork([failed], known).removed).toEqual([]);
  });

  it('keeps state for files under an unreadable entry of an OK root', () => {
    const known = new Map([
      [p('locked/s1.jsonl'), state(p('locked/s1.jsonl'), 1, 1, 1)],
      [p('denied.jsonl'), state(p('denied.jsonl'), 1, 1, 1)],
      [p('locked-other/s2.jsonl'), state(p('locked-other/s2.jsonl'), 1, 1, 1)],
    ]);
    const scan: RootScan = { ...okScan(root, [file(p('other.jsonl'), 1, 1)]), unreadable: [p('locked'), p('denied.jsonl')] };
    const plan = planWork([scan], known);
    // Only whole path segments count: a sibling that merely shares the unreadable directory's name prefix is gone.
    expect(plan.removed).toEqual([p('locked-other/s2.jsonl')]);
    expect(plan.work.map((w) => w.file.path)).toEqual([p('other.jsonl')]);
  });

  it('carries the stored fingerprint only for files it resumes', () => {
    const fingerprint = '100:0123456789abcdef';
    const known = new Map([
      [p('grown.jsonl'), { ...state(p('grown.jsonl'), 100, 5, 90), fingerprint }],
      [p('shrunk.jsonl'), { ...state(p('shrunk.jsonl'), 100, 5, 100), fingerprint }],
    ]);
    const scans = [okScan(root, [file(p('grown.jsonl'), 150, 6), file(p('shrunk.jsonl'), 40, 7), file(p('new.jsonl'), 10, 1)])];
    expect(planWork(scans, known).work.map((w) => [w.file.path, w.startOffset, w.fingerprint])).toEqual([
      [p('new.jsonl'), 0, null],
      [p('grown.jsonl'), 90, fingerprint],
      [p('shrunk.jsonl'), 0, null],
    ]);
  });

  it('orders work by modification time', () => {
    const scans = [okScan(root, [file(p('late.jsonl'), 1, 30), file(p('early.jsonl'), 1, 10)])];
    expect(planWork(scans, new Map()).work.map((w) => w.file.path)).toEqual([p('early.jsonl'), p('late.jsonl')]);
  });

  it('orders files with the same modification time by path', () => {
    const scans = [okScan(root, [file(p('b.jsonl'), 1, 10), file(p('a.jsonl'), 1, 10)])];
    expect(planWork(scans, new Map()).work.map((w) => w.file.path)).toEqual([p('a.jsonl'), p('b.jsonl')]);
  });
});

describe('root absence', () => {
  it('marks a root that does not exist as missing', async () => {
    tree = createTree();
    const scan = await scanSource(tree.path('nope'));
    expect(scan).toMatchObject({ ok: false, absence: 'missing' });
  });

  it('marks a root without transcripts as empty', async () => {
    tree = createTree();
    tree.write('notes/readme.txt', ['x']);
    expect(await scanSource(tree.root)).toMatchObject({
      ok: false,
      absence: 'empty',
      error: 'no .jsonl files found (check the mount path)',
    });
  });

  it('gives a root that is a file no absence', async () => {
    tree = createTree();
    const file = tree.write('file.jsonl', ['{}']);
    const scan = await scanSource(file);
    expect(scan).toMatchObject({ ok: false, error: 'not a directory' });
    expect(scan.absence).toBeUndefined();
  });

  it('gives a listed root no absence', async () => {
    tree = createTree();
    tree.write('a.jsonl', ['{}']);
    expect((await scanSource(tree.root)).absence).toBeUndefined();
  });
});

describe('scanRoot', () => {
  it('tags the scan with the client and whether the root is required', async () => {
    tree = createTree();
    tree.write('sessions/2026/09/10/rollout-a.jsonl', ['{}']);
    const scan = await scanRoot(codexRoot(tree.path('sessions')));
    expect(scan).toMatchObject({ ok: true, client: 'codex', required: false });
    expect(scan.files.map((file) => file.path)).toEqual([tree.path('sessions/2026/09/10/rollout-a.jsonl')]);
  });
});

describe('planWork with clients', () => {
  it('gives each work item the client of its root and the stored parser state only when resuming', () => {
    const p = (name: string): string => join('/root', name);
    const known = new Map([
      [
        p('grown.jsonl'),
        { path: p('grown.jsonl'), size: 10, mtimeMs: 1, offset: 10, fingerprint: '10:0123456789abcdef', parserState: '{"v":1}' },
      ],
      [p('shrunk.jsonl'), { path: p('shrunk.jsonl'), size: 50, mtimeMs: 1, offset: 50, fingerprint: null, parserState: '{"v":1}' }],
    ]);
    const plan = planWork(
      [
        okScan('/root', [file(p('grown.jsonl'), 20, 2), file(p('shrunk.jsonl'), 5, 3)], 'codex'),
        okScan('/other', [file('/other/new.jsonl', 1, 4)]),
      ],
      known,
    );
    expect(plan.work.map((item) => [item.file.path, item.client, item.startOffset, item.parserState])).toEqual([
      [p('grown.jsonl'), 'codex', 10, '{"v":1}'],
      [p('shrunk.jsonl'), 'codex', 0, null],
      ['/other/new.jsonl', 'claude', 0, null],
    ]);
  });
});
