import { createReadStream } from 'node:fs';

/** Longest line kept in memory, 64 MiB: far above the largest real transcript line (about 1.4 MB). */
export const MAX_LINE_BYTES = 64 * 1024 * 1024;

export interface ReadOutcome {
  readonly newOffset: number;
  readonly bytesRead: number;
  /** Lines longer than MAX_LINE_BYTES; their bytes are consumed and nothing is emitted for them. */
  readonly oversizedLines: number;
}

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

function emitLine(line: Buffer, onLine: (line: Buffer) => void): void {
  const trimmed = line.at(-1) === CARRIAGE_RETURN ? line.subarray(0, -1) : line;
  if (trimmed.length > 0) onLine(trimmed);
}

/** The line read so far: its pieces while it fits under the cap, and its length in bytes either way. */
interface Pending {
  readonly pieces: readonly Buffer[];
  readonly bytes: number;
}

const NOTHING_PENDING: Pending = { pieces: [], bytes: 0 };

/** Adds a piece of the current line; past the cap the pieces are dropped and only the length is kept. */
function append(pending: Pending, piece: Buffer, maxLineBytes: number): Pending {
  const bytes = pending.bytes + piece.length;
  return { pieces: bytes > maxLineBytes ? [] : [...pending.pieces, piece], bytes };
}

/**
 * Streams the file from `offset` and calls `onLine` for every complete line.
 * The unterminated tail (a line still being written) is left for the next read.
 * A line longer than `maxLineBytes` is consumed and counted but never emitted. An oversized unterminated tail is
 * dropped from memory and read again on the next call, until its newline arrives.
 */
export async function readCompleteLines(
  path: string,
  offset: number,
  onLine: (line: Buffer) => void,
  maxLineBytes: number = MAX_LINE_BYTES,
): Promise<ReadOutcome> {
  let consumed = offset;
  let pending = NOTHING_PENDING;
  let oversizedLines = 0;
  for await (const chunk of createReadStream(path, { start: offset }) as AsyncIterable<Buffer>) {
    let start = 0;
    let newline = chunk.indexOf(NEWLINE, start);
    while (newline !== -1) {
      const piece = chunk.subarray(start, newline);
      const bytes = pending.bytes + piece.length;
      if (bytes > maxLineBytes) {
        oversizedLines += 1;
      } else {
        emitLine(pending.pieces.length > 0 ? Buffer.concat([...pending.pieces, piece]) : piece, onLine);
      }
      consumed += bytes + 1;
      pending = NOTHING_PENDING;
      start = newline + 1;
      newline = chunk.indexOf(NEWLINE, start);
    }
    if (start < chunk.length) pending = append(pending, chunk.subarray(start), maxLineBytes);
  }
  return { newOffset: consumed, bytesRead: consumed - offset, oversizedLines };
}
