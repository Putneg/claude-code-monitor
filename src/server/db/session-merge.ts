import { createHash } from 'node:crypto';

export type ProjectSource = 'main' | 'sidechain';

export interface SessionRecord {
  readonly sessionId: string;
  readonly projectPath: string | null;
  readonly projectId: string | null;
  readonly projectSource: ProjectSource | null;
  readonly projectTs: number | null;
  readonly title: string | null;
}

export interface SessionTouch {
  readonly sessionId: string;
  readonly cwd: string | null;
  readonly isSidechain: boolean;
  readonly ts: number;
}

export function projectIdFor(path: string): string {
  return createHash('sha1').update(path).digest('hex').slice(0, 10);
}

export function emptySession(sessionId: string): SessionRecord {
  return {
    sessionId,
    projectPath: null,
    projectId: null,
    projectSource: null,
    projectTs: null,
    title: null,
  };
}

function shouldReplaceProject(existing: SessionRecord, source: ProjectSource, ts: number): boolean {
  if (existing.projectPath === null || existing.projectSource === null) return true;
  if (existing.projectSource === 'sidechain' && source === 'main') return true;
  if (existing.projectSource !== source) return false;
  return existing.projectTs === null || ts < existing.projectTs;
}

/** The session after one usage line: the project comes from the earliest main-chain cwd, else the earliest sidechain cwd. */
export function mergeTouch(existing: SessionRecord, touch: SessionTouch): SessionRecord {
  if (touch.cwd === null) return existing;
  const source: ProjectSource = touch.isSidechain ? 'sidechain' : 'main';
  if (!shouldReplaceProject(existing, source, touch.ts)) return existing;
  return {
    ...existing,
    projectPath: touch.cwd,
    projectId: projectIdFor(touch.cwd),
    projectSource: source,
    projectTs: touch.ts,
  };
}

export function withTitle(existing: SessionRecord, title: string): SessionRecord {
  return { ...existing, title };
}

/** Field-by-field equality; the repository skips a write that would not change the stored row. */
export function sameSession(a: SessionRecord, b: SessionRecord): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.projectPath === b.projectPath &&
    a.projectId === b.projectId &&
    a.projectSource === b.projectSource &&
    a.projectTs === b.projectTs &&
    a.title === b.title
  );
}
