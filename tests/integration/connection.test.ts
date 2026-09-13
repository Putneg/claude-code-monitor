import { chmodSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../src/server/db/connection.js';
import { createTree, type Tree } from '../helpers/tree.js';

/** POSIX permission bits; Windows has no equivalent, so those assertions are skipped there. */
const ON_WINDOWS = process.platform === 'win32';
const modeOf = (path: string): number => statSync(path).mode & 0o777;

let tree: Tree | undefined;
let db: Db | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
  tree?.cleanup();
  tree = undefined;
});

describe('openDatabase', () => {
  it('creates a missing parent directory and opens the database in WAL mode', () => {
    tree = createTree();
    const path = tree.path('nested/deeper/monitor.db');
    db = openDatabase(path);
    expect(existsSync(path)).toBe(true);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
  });

  it.skipIf(ON_WINDOWS)('creates the directory as 0700 and the database, WAL and shared-memory files as 0600', () => {
    tree = createTree();
    const path = tree.path('data/monitor.db');
    db = openDatabase(path);
    db.exec('CREATE TABLE probe (x INTEGER)');
    expect(modeOf(tree.path('data'))).toBe(0o700);
    expect(modeOf(path)).toBe(0o600);
    expect(modeOf(`${path}-wal`)).toBe(0o600);
    expect(modeOf(`${path}-shm`)).toBe(0o600);
  });

  it.skipIf(ON_WINDOWS)('keeps the mode of an existing database file', () => {
    tree = createTree();
    const path = tree.path('monitor.db');
    writeFileSync(path, '');
    chmodSync(path, 0o644);
    db = openDatabase(path);
    expect(modeOf(path)).toBe(0o644);
  });
});
