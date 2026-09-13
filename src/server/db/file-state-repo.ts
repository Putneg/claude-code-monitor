import type { Db } from './connection.js';

export interface FileState {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
  /** Byte offset just after the last complete line that was ingested. */
  readonly offset: number;
  /** "<len>:<16 hex chars>" hash of the file's first bytes (ingest/fingerprint.ts), or null when unknown (rows from schema v1). */
  readonly fingerprint: string | null;
}

export interface FileStateRepo {
  all(): ReadonlyMap<string, FileState>;
  upsert(state: FileState): void;
  remove(paths: readonly string[]): void;
  count(): number;
}

interface FileStateRow {
  path: string;
  size: number;
  mtime_ms: number;
  read_offset: number;
  fingerprint: string | null;
}

export function createFileStateRepo(db: Db): FileStateRepo {
  const allStmt = db.prepare<[], FileStateRow>('SELECT path, size, mtime_ms, read_offset, fingerprint FROM file_state');
  const upsertStmt = db.prepare(
    `INSERT INTO file_state (path, size, mtime_ms, read_offset, fingerprint)
     VALUES (@path, @size, @mtimeMs, @offset, @fingerprint)
     ON CONFLICT (path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms,
       read_offset = excluded.read_offset, fingerprint = excluded.fingerprint`,
  );
  const removeStmt = db.prepare('DELETE FROM file_state WHERE path = ?');
  const removeMany = db.transaction((paths: readonly string[]) => {
    paths.forEach((path) => removeStmt.run(path));
  });
  const countStmt = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM file_state');

  return {
    all: () =>
      new Map(
        allStmt
          .all()
          .map((row) => [
            row.path,
            { path: row.path, size: row.size, mtimeMs: row.mtime_ms, offset: row.read_offset, fingerprint: row.fingerprint },
          ]),
      ),
    upsert: (state) => {
      upsertStmt.run({ ...state });
    },
    remove: (paths) => {
      if (paths.length > 0) removeMany(paths);
    },
    count: () => countStmt.get()?.n ?? 0,
  };
}
