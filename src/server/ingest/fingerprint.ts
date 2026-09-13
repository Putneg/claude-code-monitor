import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

/** Bytes at the head of a transcript file that its fingerprint covers. */
export const FINGERPRINT_BYTES = 1024;

const FINGERPRINT_PATTERN = /^(\d{1,4}):([0-9a-f]{16})$/;

/** Up to `length` bytes from the start of the file; fewer when the file is shorter. */
async function readHead(path: string, length: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

const digest = (head: Buffer): string => createHash('sha256').update(head).digest('hex').slice(0, 16);

/**
 * "<len>:<16 hex chars of sha256>" over the first min(size, FINGERPRINT_BYTES) bytes. When the file is shorter than
 * `size` by now, `len` is the number of bytes it has.
 */
export async function readFingerprint(path: string, size: number): Promise<string> {
  const head = await readHead(path, Math.min(size, FINGERPRINT_BYTES));
  return `${head.length}:${digest(head)}`;
}

/**
 * True when `stored` covers as many head bytes as a fingerprint of a `size`-byte file would. One taken while the file
 * was shorter than FINGERPRINT_BYTES does not, so it is worth widening once the file has grown.
 */
export function fingerprintCoversHead(stored: string, size: number): boolean {
  const match = FINGERPRINT_PATTERN.exec(stored);
  return match !== null && Number(match[1]) >= Math.min(size, FINGERPRINT_BYTES);
}

/** Recomputes over the stored length; false when the bytes differ, the file is now shorter, or `stored` is malformed. */
export async function fingerprintMatches(path: string, stored: string): Promise<boolean> {
  const match = FINGERPRINT_PATTERN.exec(stored);
  if (match === null) return false;
  const length = Number(match[1]);
  if (length > FINGERPRINT_BYTES) return false;
  const head = await readHead(path, length);
  return head.length === length && digest(head) === match[2];
}
