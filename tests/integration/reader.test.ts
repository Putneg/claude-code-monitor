import { afterEach, describe, expect, it } from 'vitest';
import { MAX_LINE_BYTES, readCompleteLines } from '../../src/server/ingest/reader.js';
import { createTree, type Tree } from '../helpers/tree.js';

let tree: Tree;
afterEach(() => tree.cleanup());

async function collect(path: string, offset: number, maxLineBytes?: number) {
  const lines: string[] = [];
  const outcome = await readCompleteLines(path, offset, (line) => lines.push(line.toString('utf8')), maxLineBytes);
  return { lines, ...outcome };
}

describe('readCompleteLines', () => {
  it('emits complete lines and stops before an unterminated tail', async () => {
    tree = createTree();
    const file = tree.writeRaw('a.jsonl', 'one\ntwo\nthr');
    const result = await collect(file, 0);
    expect(result.lines).toEqual(['one', 'two']);
    expect(result.newOffset).toBe(8);
    expect(result.bytesRead).toBe(8);
  });

  it('resumes from the stored offset after an append', async () => {
    tree = createTree();
    const file = tree.writeRaw('a.jsonl', 'one\ntwo\nthr');
    const first = await collect(file, 0);
    tree.writeRaw('a.jsonl', 'ee\nfour\n', { append: true });
    const second = await collect(file, first.newOffset);
    expect(second.lines).toEqual(['three', 'four']);
    expect(second.newOffset).toBe(Buffer.byteLength('one\ntwo\nthree\nfour\n'));
  });

  it('strips carriage returns and skips empty lines', async () => {
    tree = createTree();
    const file = tree.writeRaw('a.jsonl', 'one\r\n\r\n\ntwo\n');
    const result = await collect(file, 0);
    expect(result.lines).toEqual(['one', 'two']);
    expect(result.newOffset).toBe(Buffer.byteLength('one\r\n\r\n\ntwo\n'));
  });

  it('counts bytes, not characters, for multi-byte text', async () => {
    tree = createTree();
    const text = 'café\nnaïve\n';
    const file = tree.writeRaw('a.jsonl', text);
    const result = await collect(file, 0);
    expect(result.lines).toEqual(['café', 'naïve']);
    expect(result.newOffset).toBe(Buffer.byteLength(text));
  });

  it('handles lines longer than the stream chunk size', async () => {
    tree = createTree();
    const long = 'x'.repeat(300_000);
    const file = tree.writeRaw('a.jsonl', `${long}\nshort\n`);
    const result = await collect(file, 0);
    expect(result.lines.map((l) => l.length)).toEqual([300_000, 5]);
  });

  it('returns zero bytes at end of file and for empty files', async () => {
    tree = createTree();
    const file = tree.writeRaw('a.jsonl', 'one\n');
    expect(await collect(file, 4)).toEqual({ lines: [], newOffset: 4, bytesRead: 0, oversizedLines: 0 });
    const empty = tree.writeRaw('empty.jsonl', '');
    expect(await collect(empty, 0)).toEqual({ lines: [], newOffset: 0, bytesRead: 0, oversizedLines: 0 });
  });

  it('uses a 64 MiB line cap by default', () => {
    expect(MAX_LINE_BYTES).toBe(64 * 1024 * 1024);
  });

  it('skips a line longer than the cap, counts it and reads past it', async () => {
    tree = createTree();
    const text = `one\n${'x'.repeat(50)}\n${'y'.repeat(10)}\ntwo\n`;
    const file = tree.writeRaw('a.jsonl', text);
    expect(await collect(file, 0, 10)).toEqual({
      lines: ['one', 'y'.repeat(10), 'two'],
      newOffset: Buffer.byteLength(text),
      bytesRead: Buffer.byteLength(text),
      oversizedLines: 1,
    });
  });

  it('skips an oversized line that spans several stream chunks', async () => {
    tree = createTree();
    const text = `${'x'.repeat(300_000)}\nshort\n`;
    const file = tree.writeRaw('a.jsonl', text);
    const result = await collect(file, 0, 100_000);
    expect(result).toMatchObject({ lines: ['short'], newOffset: Buffer.byteLength(text), oversizedLines: 1 });
  });

  it('leaves an oversized unterminated tail for the next read', async () => {
    tree = createTree();
    const file = tree.writeRaw('a.jsonl', `one\n${'x'.repeat(50)}`);
    expect(await collect(file, 0, 10)).toEqual({ lines: ['one'], newOffset: 4, bytesRead: 4, oversizedLines: 0 });
  });
});
