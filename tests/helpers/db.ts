import { openDatabase, type Db } from '../../src/server/db/connection.js';
import { migrate } from '../../src/server/db/migrations.js';
import { createRepos, type Repos } from '../../src/server/db/repos.js';

export function createMigratedDb(): Db {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

export function createTestDb(): { readonly db: Db; readonly repos: Repos } {
  const db = createMigratedDb();
  return { db, repos: createRepos(db) };
}
