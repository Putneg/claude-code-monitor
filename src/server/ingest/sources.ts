import type { Client } from '../../shared/models.js';
import type { Config } from '../config.js';

/** A directory the scanner lists, the client whose transcripts it holds, and whether its absence is a problem. */
export interface SourceRoot {
  readonly path: string;
  readonly client: Client;
  /** A required root that is missing or empty is reported as a problem; an optional one is simply absent. */
  readonly required: boolean;
}

export const claudeRoot = (path: string): SourceRoot => ({ path, client: 'claude', required: true });

export const codexRoot = (path: string): SourceRoot => ({ path, client: 'codex', required: false });

export function sourceRoots(config: Pick<Config, 'projectsDirs' | 'codexRoots'>): SourceRoot[] {
  return [...config.projectsDirs.map(claudeRoot), ...config.codexRoots.map(codexRoot)];
}
