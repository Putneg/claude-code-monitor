import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { FileState } from '../db/file-state-repo.js';

export interface FileInfo {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface SourceScan {
  readonly root: string;
  readonly ok: boolean;
  readonly error: string | null;
  readonly files: readonly FileInfo[];
  /** Paths under the root that could not be listed or stat'ed; skipped. */
  readonly unreadable: readonly string[];
}

export interface WorkItem {
  readonly file: FileInfo;
  readonly startOffset: number;
  /** The stored fingerprint when resuming (startOffset > 0), else null. */
  readonly fingerprint: string | null;
}

export interface WorkPlan {
  readonly work: readonly WorkItem[];
  readonly removed: readonly string[];
  readonly pendingBytes: number;
}

/** What a walk found below one directory. */
interface Found {
  readonly files: readonly FileInfo[];
  readonly unreadable: readonly string[];
}

const NOTHING: Found = { files: [], unreadable: [] };

const failed = (root: string, error: string, unreadable: readonly string[] = []): SourceScan => ({
  root,
  ok: false,
  error,
  files: [],
  unreadable,
});

/** Why a root yields no transcripts: none are there, or none could be read. */
const emptyRootError = (unreadable: number): string =>
  unreadable === 0 ? 'no .jsonl files found (check the mount path)' : `no readable .jsonl files (unreadable entries: ${unreadable})`;

export const errorCode = (error: unknown): string => (error instanceof Error && 'code' in error ? String(error.code) : 'unknown error');

const merge = (parts: readonly Found[]): Found => ({
  files: parts.flatMap((part) => part.files),
  unreadable: parts.flatMap((part) => part.unreadable),
});

async function statFile(path: string): Promise<Found> {
  try {
    const info = await stat(path);
    return info.isFile() ? { files: [{ path, size: info.size, mtimeMs: info.mtimeMs }], unreadable: [] } : NOTHING;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return NOTHING; // vanished between readdir and stat
    return { files: [], unreadable: [path] };
  }
}

/** Subdirectories are walked and .jsonl files stat'ed; symlinks and junctions are neither followed nor listed. */
function visit(dir: string, entry: Dirent): Promise<Found> {
  const path = join(dir, entry.name);
  if (entry.isDirectory()) return walk(path);
  if (entry.isFile() && entry.name.endsWith('.jsonl')) return statFile(path);
  return Promise.resolve(NOTHING);
}

/** One non-recursive readdir per directory, so an unreadable subdirectory costs only itself. */
async function walk(dir: string): Promise<Found> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return NOTHING; // removed while the walk was running
    return { files: [], unreadable: [dir] };
  }
  return merge(await Promise.all(entries.map((entry) => visit(dir, entry))));
}

/** Only an unreadable, missing or empty root fails the source; unreadable entries below it are reported and skipped. */
export async function scanSource(rootInput: string): Promise<SourceScan> {
  const root = resolve(rootInput);
  try {
    if (!(await stat(root)).isDirectory()) return failed(root, 'not a directory');
    const entries = await readdir(root, { withFileTypes: true });
    const found = merge(await Promise.all(entries.map((entry) => visit(root, entry))));
    if (found.files.length === 0) return failed(root, emptyRootError(found.unreadable.length), found.unreadable);
    return { root, ok: true, error: null, files: found.files, unreadable: found.unreadable };
  } catch (error) {
    return failed(root, `not accessible: ${errorCode(error)}`);
  }
}

export function scanSources(roots: readonly string[]): Promise<SourceScan[]> {
  return Promise.all(roots.map(scanSource));
}

function startOffsetFor(file: FileInfo, known: FileState | undefined): number | null {
  if (!known) return 0;
  if (file.size < known.offset) return 0;
  if (file.size === known.size && file.mtimeMs === known.mtimeMs) return null;
  return known.offset;
}

const isUnder = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

const isUnderAny = (path: string, roots: readonly string[]): boolean => roots.some((root) => isUnder(path, root));

export function planWork(scans: readonly SourceScan[], known: ReadonlyMap<string, FileState>): WorkPlan {
  const files = scans.flatMap((scan) => scan.files);
  const work = files
    .flatMap((file): WorkItem[] => {
      const state = known.get(file.path);
      const startOffset = startOffsetFor(file, state);
      if (startOffset === null) return [];
      return [{ file, startOffset, fingerprint: startOffset > 0 ? (state?.fingerprint ?? null) : null }];
    })
    .sort((a, b) => a.file.mtimeMs - b.file.mtimeMs || a.file.path.localeCompare(b.file.path));
  const present = new Set(files.map((file) => file.path));
  const okRoots = scans.filter((scan) => scan.ok).map((scan) => scan.root);
  // A file below an unreadable entry was not listed, not deleted: its state stays until the entry can be read again.
  const unreadable = scans.flatMap((scan) => scan.unreadable);
  const removed = [...known.keys()].filter((path) => !present.has(path) && isUnderAny(path, okRoots) && !isUnderAny(path, unreadable));
  const pendingBytes = work.reduce((sum, item) => sum + (item.file.size - item.startOffset), 0);
  return { work, removed, pendingBytes };
}
