import { z } from 'zod';
import type { ClaudeLimit, ClaudeLimitKind, ClaudeLimitWindow } from '../../shared/api.js';

/** Window kinds in display order. */
export const CLAUDE_LIMIT_KINDS: readonly ClaudeLimitKind[] = ['five_hour', 'seven_day', 'spend_limit'];

/** Largest accepted usage percentage: spend_limit can exceed 100, but not without bound. The tap (scripts/claude-limits-tap-core.mjs) uses the same bounds. */
const MAX_PERCENT = 10_000;
/** Accepted epoch seconds, 2001-09-09 to 2286-11-20: rejects milliseconds and zero. Same bounds as the tap. */
const epochSec = z.number().int().min(1_000_000_000).max(9_999_999_999);

const windowSchema = z.object({
  used_percentage: z.number().min(0).max(MAX_PERCENT),
  resets_at: epochSec,
  observed_at: epochSec,
});

/** The status line tap's file (scripts/claude-limits-tap-core.mjs). Unknown fields are ignored. */
const fileSchema = z.object({
  version: z.literal(1),
  windows: z.object({
    five_hour: windowSchema.optional(),
    seven_day: windowSchema.optional(),
    spend_limit: windowSchema.optional(),
  }),
});

export type ClaudeLimitsParse = { readonly ok: true; readonly limit: ClaudeLimit | null } | { readonly ok: false; readonly reason: string };

const iso = (sec: number): string => new Date(sec * 1000).toISOString();

function parseJson(text: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    // The caller reports "not JSON"; the parser's message could quote the file's content.
    return { ok: false };
  }
}

/**
 * The dashboard's reading from the tap file's text: null when the file has no windows. Text that is not a version 1
 * limits file is an error whose reason names fields, never their values.
 */
export function parseClaudeLimits(text: string): ClaudeLimitsParse {
  const json = parseJson(text);
  if (!json.ok) return { ok: false, reason: 'not JSON' };
  const parsed = fileSchema.safeParse(json.value);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(root)'))];
    return { ok: false, reason: `invalid fields: ${fields.join(', ')}` };
  }
  const stored = parsed.data.windows;
  const windows: ClaudeLimitWindow[] = CLAUDE_LIMIT_KINDS.flatMap((kind) => {
    const window = stored[kind];
    return window === undefined ? [] : [{ kind, usedPercent: window.used_percentage, resetsAt: iso(window.resets_at) }];
  });
  if (windows.length === 0) return { ok: true, limit: null };
  const observed = CLAUDE_LIMIT_KINDS.map((kind) => stored[kind]?.observed_at ?? 0);
  return { ok: true, limit: { windows, observedAt: iso(Math.max(...observed)) } };
}
