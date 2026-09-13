import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface Tree {
  readonly root: string;
  path(rel: string): string;
  write(rel: string, lines: readonly string[], options?: { append?: boolean; trailingNewline?: boolean }): string;
  writeRaw(rel: string, content: string | Buffer, options?: { append?: boolean }): string;
  remove(rel: string): void;
  setMtime(rel: string, when: Date): void;
  cleanup(): void;
}

export function createTree(): Tree {
  const root = mkdtempSync(join(tmpdir(), 'claude-code-monitor-'));
  const path = (rel: string): string => join(root, ...rel.split('/'));
  const writeRaw = (rel: string, content: string | Buffer, options: { append?: boolean } = {}): string => {
    const file = path(rel);
    mkdirSync(dirname(file), { recursive: true });
    if (options.append) appendFileSync(file, content);
    else writeFileSync(file, content);
    return file;
  };
  return {
    root,
    path,
    writeRaw,
    write: (rel, lines, options = {}) => {
      const trailing = (options.trailingNewline ?? true) && lines.length > 0 ? '\n' : '';
      return writeRaw(rel, lines.join('\n') + trailing, { append: options.append ?? false });
    },
    remove: (rel) => rmSync(path(rel), { force: true }),
    setMtime: (rel, when) => utimesSync(path(rel), when, when),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
