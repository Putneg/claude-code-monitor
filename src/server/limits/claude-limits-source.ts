import { readFileSync, statSync } from 'node:fs';
import type { ClaudeLimit } from '../../shared/api.js';
import type { Logger } from '../logger.js';
import { parseClaudeLimits } from './claude-limits.js';

/** A larger file is not read: the tap writes a few hundred bytes. */
export const MAX_LIMITS_FILE_BYTES = 65_536;

export interface ClaudeLimitsSource {
  /** The file's reading, or null when the file is missing or unusable. Never throws. */
  read(): ClaudeLimit | null;
}

interface Cached {
  /** Inode, modification time and size of the version that was parsed. */
  readonly key: string;
  readonly limit: ClaudeLimit | null;
}

const errorCode = (error: unknown): string =>
  typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'unknown';

/**
 * Reads the status line tap's file on demand, re-parsing it only after its inode, modification time or size changed. A
 * path that is not a file (for example a directory left by a bad mount) is ignored and logged once. A problem is logged
 * once per file version (or error code), not on every status request. A missing file is the normal state without the tap
 * and is not logged.
 */
export function createClaudeLimitsSource(path: string, logger: Logger): ClaudeLimitsSource {
  let cached: Cached | null = null;
  let reported: string | null = null;

  const report = (key: string, fields: Readonly<Record<string, unknown>>, message: string): void => {
    if (reported === key) return;
    reported = key;
    logger.warn({ path, ...fields }, message);
  };

  const load = (key: string, size: number): ClaudeLimit | null => {
    if (size > MAX_LIMITS_FILE_BYTES) {
      report(key, { size }, 'Claude limits file is too large; ignored');
      return null;
    }
    const result = parseClaudeLimits(readFileSync(path, 'utf8'));
    if (!result.ok) {
      report(key, { reason: result.reason }, 'Claude limits file is not valid; ignored');
      return null;
    }
    reported = null;
    return result.limit;
  };

  return {
    read: () => {
      try {
        const stat = statSync(path);
        if (!stat.isFile()) {
          cached = null;
          report('not-a-file', {}, 'Claude limits path is not a file; ignored');
          return null;
        }
        // The tap replaces the file by rename, so the inode tells a new version apart even within one mtime tick.
        const key = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
        const current = cached?.key === key ? cached : { key, limit: load(key, stat.size) };
        cached = current;
        return current.limit;
      } catch (error) {
        cached = null;
        const code = errorCode(error);
        if (code !== 'ENOENT') report(`error:${code}`, { err: error }, 'cannot read the Claude limits file');
        return null;
      }
    },
  };
}
