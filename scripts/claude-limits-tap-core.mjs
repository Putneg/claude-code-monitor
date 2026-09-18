// @ts-check
/**
 * Core of the Claude Code status line tap (entry point: claude-limits-tap.mjs). Claude Code passes the subscription
 * rate limits only to the status line command, on stdin; the tap keeps the newest reading per window in a small JSON
 * file that claude-code-monitor reads. Dependency-free on purpose: it runs on the host with plain `node`.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/** The rate-limit windows Claude Code reports, in display order. */
export const WINDOW_KEYS = /** @type {const} */ (['five_hour', 'seven_day', 'spend_limit']);
export const FILE_VERSION = 1;
/** Readings whose reset times differ by at most this many seconds belong to the same window. */
export const SAME_WINDOW_SLACK_SEC = 60;
/** An unchanged reading is written again once its newest observation is this many seconds newer, so "as of" stays fresh. */
export const REFRESH_SEC = 60;
/** Larger status line input is passed through but not parsed. */
export const MAX_INPUT_BYTES = 1_048_576;
/** A larger limits file is not trusted: it is treated as empty and replaced. */
export const MAX_FILE_BYTES = 65_536;

/**
 * Accepted usage percentages and epoch seconds. The server (src/server/limits/claude-limits.ts) rejects a file with
 * values outside them, so a reading outside them is dropped here and never stored.
 */
export const MAX_PERCENT = 10_000;
export const MIN_EPOCH_SEC = 1_000_000_000;
export const MAX_EPOCH_SEC = 9_999_999_999;

/** Temporary files older than this are left over from a killed run. */
export const STALE_TEMP_MS = 60_000;

const LABELS = { five_hour: '5h', seven_day: 'weekly', spend_limit: 'spend' };

/**
 * @typedef {(typeof WINDOW_KEYS)[number]} WindowKey
 * @typedef {{ used_percentage: number, resets_at: number, observed_at: number }} WindowReading
 * @typedef {Partial<Record<WindowKey, WindowReading>>} Windows
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * @param {unknown} value
 * @returns {value is number}
 */
const isPercent = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_PERCENT;

/**
 * @param {unknown} value
 * @returns {value is number}
 */
const isEpochSec = (value) => typeof value === 'number' && Number.isInteger(value) && value >= MIN_EPOCH_SEC && value <= MAX_EPOCH_SEC;

/**
 * @param {Record<string, string | undefined>} env
 * @returns {string} ${CLAUDE_CONFIG_DIR:-~/.claude}/claude-code-monitor/rate-limits.json
 */
export function defaultLimitsPath(env) {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  return join(configDir ? configDir : join(homedir(), '.claude'), 'claude-code-monitor', 'rate-limits.json');
}

/**
 * @param {unknown} value one window of the status line's rate_limits
 * @param {number} nowSec
 * @returns {WindowReading | null}
 */
function readingFromInput(value, nowSec) {
  if (!isRecord(value) || !isPercent(value.used_percentage) || typeof value.resets_at !== 'number') return null;
  const resets = Math.floor(value.resets_at);
  return isEpochSec(resets) ? { used_percentage: value.used_percentage, resets_at: resets, observed_at: nowSec } : null;
}

/**
 * The known windows of the status line input's rate_limits, observed now. A window without a finite, non-negative
 * percentage or a positive reset time is skipped, and so is a reading outside the bounds the server accepts (MAX_PERCENT,
 * MIN_EPOCH_SEC..MAX_EPOCH_SEC).
 * @param {unknown} input the parsed status line JSON
 * @param {number} nowSec
 * @returns {Windows}
 */
export function windowsFromInput(input, nowSec) {
  const limits = isRecord(input) ? input.rate_limits : undefined;
  if (!isRecord(limits)) return {};
  const entries = WINDOW_KEYS.flatMap((key) => {
    const reading = readingFromInput(limits[key], nowSec);
    return reading === null ? [] : [/** @type {const} */ ([key, reading])];
  });
  return /** @type {Windows} */ (Object.fromEntries(entries));
}

/**
 * One window's merge. Usage within a window only grows, so a lower reading for the same window comes from an idle
 * session's older data and loses; a later reset time starts a new window; an earlier one is an old window.
 * @param {WindowReading | undefined} stored
 * @param {WindowReading} incoming
 * @returns {WindowReading}
 */
export function mergeWindow(stored, incoming) {
  if (stored === undefined) return incoming;
  if (Math.abs(incoming.resets_at - stored.resets_at) <= SAME_WINDOW_SLACK_SEC) {
    return {
      used_percentage: Math.max(stored.used_percentage, incoming.used_percentage),
      resets_at: Math.max(stored.resets_at, incoming.resets_at),
      observed_at: Math.max(stored.observed_at, incoming.observed_at),
    };
  }
  return incoming.resets_at > stored.resets_at ? incoming : stored;
}

/**
 * Merges every incoming window; stored windows the input left out are kept as they are.
 * @param {Windows} stored
 * @param {Windows} incoming
 * @returns {Windows}
 */
export function mergeWindows(stored, incoming) {
  const entries = WINDOW_KEYS.flatMap((key) => {
    const next = incoming[key];
    const kept = next === undefined ? stored[key] : mergeWindow(stored[key], next);
    return kept === undefined ? [] : [/** @type {const} */ ([key, kept])];
  });
  return /** @type {Windows} */ (Object.fromEntries(entries));
}

/**
 * @param {Windows} windows
 * @returns {string} the usages and reset times, in display order
 */
const valuesOf = (windows) =>
  JSON.stringify(
    WINDOW_KEYS.map((key) => {
      const window = windows[key];
      return window === undefined ? null : [window.used_percentage, window.resets_at];
    }),
  );

/**
 * @param {Windows} windows
 * @returns {number}
 */
const newestObservation = (windows) => Math.max(0, ...WINDOW_KEYS.map((key) => windows[key]?.observed_at ?? 0));

/**
 * True when a usage, a reset time or the set of windows changed, or when the newest observation is REFRESH_SEC newer.
 * @param {Windows} stored
 * @param {Windows} merged
 * @returns {boolean}
 */
export function shouldWrite(stored, merged) {
  return valuesOf(stored) !== valuesOf(merged) || newestObservation(merged) - newestObservation(stored) >= REFRESH_SEC;
}

/**
 * The windows of a limits file, or {} when the text is not a version 1 limits file (it is then replaced on the next
 * write). A malformed window is dropped.
 * @param {string} text
 * @returns {Windows}
 */
export function windowsFromFile(text) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON: treated as no reading, and the next write replaces it.
    return {};
  }
  if (!isRecord(parsed) || parsed.version !== FILE_VERSION || !isRecord(parsed.windows)) return {};
  const windows = parsed.windows;
  const entries = WINDOW_KEYS.flatMap((key) => {
    const window = windows[key];
    if (!isRecord(window)) return [];
    const { used_percentage: used, resets_at: resets, observed_at: observed } = window;
    if (!isPercent(used) || !isEpochSec(resets) || !isEpochSec(observed)) return [];
    return [/** @type {const} */ ([key, { used_percentage: used, resets_at: resets, observed_at: observed }])];
  });
  return /** @type {Windows} */ (Object.fromEntries(entries));
}

/**
 * @param {Windows} windows
 * @returns {string} e.g. '5h 23% · weekly 41%', or '' without windows
 */
export function summaryLine(windows) {
  return WINDOW_KEYS.flatMap((key) => {
    const window = windows[key];
    return window === undefined ? [] : [`${LABELS[key]} ${Math.round(window.used_percentage)}%`];
  }).join(' · ');
}

/**
 * The stored windows: {} when the file is missing, too large or not a limits file. Other read errors are thrown.
 * @param {string} path
 * @returns {Windows}
 */
export function readStoredWindows(path) {
  try {
    if (statSync(path).size > MAX_FILE_BYTES) return {};
    return windowsFromFile(readFileSync(path, 'utf8'));
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return {};
    throw error;
  }
}

/**
 * Removes temporary files that a run killed between writing and renaming left next to the limits file (Claude Code
 * cancels a status line run when a newer update arrives). Younger ones may belong to a run in progress and are kept.
 * @param {string} path the limits file
 * @param {number} nowMs
 */
export function sweepStaleTemps(path, nowMs) {
  const folder = dirname(path);
  const prefix = `${basename(path)}.`;
  for (const name of readdirSync(folder)) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
    const file = join(folder, name);
    const stat = statSync(file, { throwIfNoEntry: false });
    if (stat !== undefined && nowMs - stat.mtimeMs > STALE_TEMP_MS) rmSync(file, { force: true });
  }
}

/**
 * Replaces the file atomically: a temporary file in the same folder is renamed over it.
 * @param {string} path
 * @param {Windows} windows
 */
export function writeWindows(path, windows) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify({ version: FILE_VERSION, windows })}\n`);
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
  try {
    sweepStaleTemps(path, Date.now());
  } catch {
    // Best effort: a leftover temporary file never blocks recording, and the next write tries again.
  }
}

/**
 * Merges the windows into the file and writes it when shouldWrite says so.
 * Sessions do not lock the file: two runs can merge the same stored state and the later rename wins; the next run with
 * fresh data restores the higher usage, so the rule holds eventually.
 * @param {string} path
 * @param {Windows} incoming
 * @returns {boolean} whether the file was written
 */
export function recordWindows(path, incoming) {
  if (WINDOW_KEYS.every((key) => incoming[key] === undefined)) return false;
  const stored = readStoredWindows(path);
  const merged = mergeWindows(stored, incoming);
  if (!shouldWrite(stored, merged)) return false;
  writeWindows(path, merged);
  return true;
}

/**
 * Runs `action`; on failure reports it on stderr and returns `fallback`.
 * @template T
 * @param {{ write(chunk: string): unknown }} stderr
 * @param {T} fallback
 * @param {() => T} action
 * @returns {T}
 */
function reportFailure(stderr, fallback, action) {
  try {
    return action();
  } catch (error) {
    stderr.write(`claude-limits-tap: ${error instanceof Error ? error.message : String(error)}\n`);
    return fallback;
  }
}

/**
 * @param {Buffer} input
 * @returns {unknown} the parsed status line input
 */
function parseInput(input) {
  try {
    return JSON.parse(input.toString('utf8'));
  } catch {
    // The parser's message would quote the input; report the fact only.
    throw new Error('status line input is not JSON');
  }
}

/**
 * @typedef {object} TapIo
 * @property {Buffer} input the whole status line input
 * @property {readonly string[]} args command-line arguments; `--standalone` prints a summary instead of the input
 * @property {Record<string, string | undefined>} env
 * @property {number} nowMs
 * @property {{ write(chunk: string | Uint8Array): unknown }} stdout
 * @property {{ write(chunk: string): unknown }} stderr
 */

/**
 * One status line run: records the rate limits, then writes the untouched input (or, with --standalone, a summary) to
 * stdout. Never throws: a failure is reported on stderr and the output still goes out.
 * @param {TapIo} io
 */
export function runTap(io) {
  const nowSec = Math.floor(io.nowMs / 1000);
  const windows = reportFailure(io.stderr, /** @type {Windows} */ ({}), () =>
    io.input.length > MAX_INPUT_BYTES ? {} : windowsFromInput(parseInput(io.input), nowSec),
  );
  reportFailure(io.stderr, false, () => recordWindows(defaultLimitsPath(io.env), windows));
  io.stdout.write(io.args.includes('--standalone') ? summaryLine(windows) : io.input);
}
