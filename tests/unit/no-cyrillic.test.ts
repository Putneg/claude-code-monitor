import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOTS = ['src', 'tests', 'scripts'];
const TEXT_EXTENSIONS = new Set(['.ts', '.js', '.json', '.svelte', '.css', '.html', '.md', '.jsonl']);
const CYRILLIC = /\p{Script=Cyrillic}/u;

function listFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries.flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : listFiles(full);
    return TEXT_EXTENSIONS.has(extname(entry.name)) ? [full] : [];
  });
}

describe('language policy', () => {
  it('keeps src, tests and scripts free of Cyrillic characters', () => {
    const offenders = ROOTS.flatMap(listFiles).filter((file) => CYRILLIC.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
