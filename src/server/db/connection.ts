import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

/** Owner-only modes for what openDatabase creates: the database holds session titles and project paths. POSIX only. */
const DB_DIR_MODE = 0o700;
const DB_FILE_MODE = 0o600;

const isAlreadyThere = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'EEXIST';

/**
 * Creates `path` as an empty file with the owner-only mode, or leaves whatever is already there alone. O_EXCL makes
 * the check and the creation one step; an existing entry, a symlink included, is left as it is and opened by SQLite.
 */
function createDatabaseFile(path: string): void {
  try {
    closeSync(openSync(path, 'wx', DB_FILE_MODE));
  } catch (error) {
    if (!isAlreadyThere(error)) throw error;
  }
}

/**
 * Opens the database, creating it and its directory when missing. Only what this call creates gets the owner-only
 * mode, so an existing file owned by someone else keeps its mode and never fails with EPERM. An empty file is a valid
 * empty database, and SQLite creates -wal and -shm with the database file's mode.
 */
export function openDatabase(path: string): Db {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true, mode: DB_DIR_MODE });
    createDatabaseFile(path);
  }
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  return db;
}
