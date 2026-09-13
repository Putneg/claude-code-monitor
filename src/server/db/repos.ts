import type { Db } from './connection.js';
import { createFileStateRepo, type FileStateRepo } from './file-state-repo.js';
import { createMetaRepo, type MetaRepo } from './meta-repo.js';
import { createPriceRepo, type PriceRepo } from './price-repo.js';
import { createSessionRepo, type SessionRepo } from './session-repo.js';
import { createUsageRepo, type UsageRepo } from './usage-repo.js';

export interface Repos {
  readonly usage: UsageRepo;
  readonly sessions: SessionRepo;
  readonly files: FileStateRepo;
  readonly meta: MetaRepo;
  readonly prices: PriceRepo;
}

export function createRepos(db: Db): Repos {
  return {
    usage: createUsageRepo(db),
    sessions: createSessionRepo(db),
    files: createFileStateRepo(db),
    meta: createMetaRepo(db),
    prices: createPriceRepo(db),
  };
}
