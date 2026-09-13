import type { Db } from './connection.js';
import { SCHEMA_V1, SCHEMA_V2 } from './schema.js';

interface Migration {
  readonly version: number;
  readonly sql: string;
}

const MIGRATIONS: readonly Migration[] = [
  { version: 1, sql: SCHEMA_V1 },
  { version: 2, sql: SCHEMA_V2 },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

function readVersion(db: Db): number {
  const row = db.prepare<[], { value: string }>(`SELECT value FROM meta WHERE key = 'schema_version'`).get();
  return row ? Number(row.value) : 0;
}

function writeVersion(db: Db, version: number): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).run(String(version));
}

/**
 * Applies the pending migrations up to `target` in one transaction and returns the stored version.
 * Tests pass an older target to build a database as an earlier release left it.
 */
export function migrate(db: Db, target: number = LATEST_SCHEMA_VERSION): number {
  if (target > LATEST_SCHEMA_VERSION) {
    throw new Error(`cannot migrate to schema version ${target}; this build supports up to ${LATEST_SCHEMA_VERSION}`);
  }
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const stored = readVersion(db);
  if (stored > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `database schema version ${stored} is newer than this build supports (${LATEST_SCHEMA_VERSION}); a newer image is needed`,
    );
  }
  const pending = MIGRATIONS.filter((m) => m.version > stored && m.version <= target);
  const apply = db.transaction((items: readonly Migration[]) => {
    for (const migration of items) {
      db.exec(migration.sql);
      writeVersion(db, migration.version);
    }
  });
  apply(pending);
  return readVersion(db);
}
