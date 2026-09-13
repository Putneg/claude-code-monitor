import type { Db } from './connection.js';
import { emptySession, mergeTouch, sameSession, withTitle, type SessionRecord, type SessionTouch } from './session-merge.js';

export interface SessionRepo {
  get(sessionId: string): SessionRecord | undefined;
  touch(touch: SessionTouch): void;
  setTitle(sessionId: string, title: string): void;
}

interface SessionRow {
  session_id: string;
  project_path: string | null;
  project_id: string | null;
  project_source: 'main' | 'sidechain' | null;
  project_ts: number | null;
  title: string | null;
}

const fromRow = (row: SessionRow): SessionRecord => ({
  sessionId: row.session_id,
  projectPath: row.project_path,
  projectId: row.project_id,
  projectSource: row.project_source,
  projectTs: row.project_ts,
  title: row.title,
});

const PUT_SQL = `
INSERT INTO sessions (session_id, project_path, project_id, project_source, project_ts, title)
VALUES (@sessionId, @projectPath, @projectId, @projectSource, @projectTs, @title)
ON CONFLICT (session_id) DO UPDATE SET
  project_path = excluded.project_path, project_id = excluded.project_id,
  project_source = excluded.project_source, project_ts = excluded.project_ts, title = excluded.title`;

export function createSessionRepo(db: Db): SessionRepo {
  const getStmt = db.prepare<[string], SessionRow>(
    'SELECT session_id, project_path, project_id, project_source, project_ts, title FROM sessions WHERE session_id = ?',
  );
  const putStmt = db.prepare(PUT_SQL);
  const get = (sessionId: string): SessionRecord | undefined => {
    const row = getStmt.get(sessionId);
    return row ? fromRow(row) : undefined;
  };
  /** Most usage lines change nothing about their session; those skip the write. */
  const update = (sessionId: string, change: (current: SessionRecord) => SessionRecord): void => {
    const current = get(sessionId) ?? emptySession(sessionId);
    const next = change(current);
    if (!sameSession(current, next)) putStmt.run({ ...next });
  };

  return {
    get,
    touch: (touch) => update(touch.sessionId, (current) => mergeTouch(current, touch)),
    setTitle: (sessionId, title) => update(sessionId, (current) => withTitle(current, title)),
  };
}
