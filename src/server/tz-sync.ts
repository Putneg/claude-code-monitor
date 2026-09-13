import type { Repos } from './db/repos.js';
import type { Logger } from './logger.js';
import { createLocalDay } from './time.js';

const TZ_KEY = 'tz';

export function syncTimeZone(repos: Pick<Repos, 'meta' | 'usage'>, timeZone: string, logger: Logger): number {
  const stored = repos.meta.get(TZ_KEY);
  if (stored === timeZone) return 0;
  const updated = repos.usage.recomputeLocalDays(createLocalDay(timeZone));
  repos.meta.set(TZ_KEY, timeZone);
  if (updated > 0) logger.info({ from: stored, to: timeZone, rows: updated }, 'recomputed local days for the new time zone');
  return updated;
}
