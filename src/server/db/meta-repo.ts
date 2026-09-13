import type { Db } from './connection.js';

export interface MetaRepo {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export function createMetaRepo(db: Db): MetaRepo {
  const getStmt = db.prepare('SELECT value FROM meta WHERE key = ?');
  const setStmt = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');
  return {
    get: (key) => (getStmt.get(key) as { value: string } | undefined)?.value ?? null,
    set: (key, value) => {
      setStmt.run(key, value);
    },
  };
}
