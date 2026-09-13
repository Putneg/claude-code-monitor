import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { FINGERPRINT_BYTES, fingerprintCoversHead, fingerprintMatches, readFingerprint } from '../../src/server/ingest/fingerprint.js';
import { createTree, type Tree } from '../helpers/tree.js';

let tree: Tree;
afterEach(() => tree?.cleanup());

const sha16 = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

describe('readFingerprint', () => {
  it('hashes a short file whole', async () => {
    tree = createTree();
    const file = tree.writeRaw('a.jsonl', 'hello\n');
    expect(await readFingerprint(file, 6)).toBe(`6:${sha16('hello\n')}`);
  });

  it('hashes only the first FINGERPRINT_BYTES of a long file', async () => {
    tree = createTree();
    const head = 'h'.repeat(FINGERPRINT_BYTES);
    const file = tree.writeRaw('a.jsonl', `${head}tail\n`);
    expect(FINGERPRINT_BYTES).toBe(1024);
    expect(await readFingerprint(file, FINGERPRINT_BYTES + 5)).toBe(`1024:${sha16(head)}`);
  });

  it('covers the bytes the file has when it is shorter than the given size', async () => {
    tree = createTree();
    const file = tree.writeRaw('a.jsonl', 'abc');
    expect(await readFingerprint(file, 500)).toBe(`3:${sha16('abc')}`);
  });
});

describe('fingerprintMatches', () => {
  it('matches the same head, also after an append', async () => {
    tree = createTree();
    const file = tree.writeRaw('a.jsonl', 'first line\n');
    const stored = await readFingerprint(file, 11);
    expect(await fingerprintMatches(file, stored)).toBe(true);
    tree.writeRaw('a.jsonl', 'second line\n', { append: true });
    expect(await fingerprintMatches(file, stored)).toBe(true);
  });

  it('does not match a changed head or a file that is now shorter', async () => {
    tree = createTree();
    const file = tree.writeRaw('a.jsonl', 'first line\n');
    const stored = await readFingerprint(file, 11);
    tree.writeRaw('a.jsonl', 'FIRST line\n');
    expect(await fingerprintMatches(file, stored)).toBe(false);
    tree.writeRaw('a.jsonl', 'first');
    expect(await fingerprintMatches(file, stored)).toBe(false);
  });

  it.each(['', 'abc', '11:xyz', '11:0123456789abcdef0', '2000:0123456789abcdef', '-1:0123456789abcdef'])(
    'rejects the malformed fingerprint %j',
    async (stored) => {
      tree = createTree();
      const file = tree.writeRaw('a.jsonl', 'first line\n');
      expect(await fingerprintMatches(file, stored)).toBe(false);
    },
  );

  it('fails for a missing file, which the ingestor reports as a failed file', async () => {
    tree = createTree();
    await expect(fingerprintMatches(tree.path('gone.jsonl'), `3:${sha16('abc')}`)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('fingerprintCoversHead', () => {
  it('is true only when the stored fingerprint spans the head a file of that size has', () => {
    const narrow = `11:${sha16('first line\n')}`;
    expect(fingerprintCoversHead(narrow, 11)).toBe(true);
    expect(fingerprintCoversHead(narrow, 12)).toBe(false);
    expect(fingerprintCoversHead(`${FINGERPRINT_BYTES}:${sha16('h')}`, 5_000)).toBe(true);
    expect(fingerprintCoversHead('abc', 11)).toBe(false);
  });
});
