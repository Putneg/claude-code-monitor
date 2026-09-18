#!/usr/bin/env node
// @ts-check
/**
 * Claude Code status line tap for claude-code-monitor: records Claude's subscription rate limits for the dashboard.
 * Put it in front of your status line command in ~/.claude/settings.json:
 *
 *   "command": "node /path/to/claude-code-monitor/scripts/claude-limits-tap.mjs | <your status line command>"
 *
 * or use it alone with --standalone, which prints a short summary. See the README section "Claude limits".
 */
import { runTap } from './claude-limits-tap-core.mjs';

// When the next status line command exits without reading its input, the pass-through write fails with EPIPE. The
// limits are already recorded by then, so the run ends quietly instead of printing a stack trace.
process.stdout.on('error', () => process.exit(0));

/** @type {Buffer[]} */
const chunks = [];
try {
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
} catch (error) {
  // The status line must not fail on the tap: what was read so far is still passed through.
  process.stderr.write(`claude-limits-tap: cannot read the status line input: ${error instanceof Error ? error.message : String(error)}\n`);
}
runTap({
  input: Buffer.concat(chunks),
  args: process.argv.slice(2),
  env: process.env,
  nowMs: Date.now(),
  stdout: process.stdout,
  stderr: process.stderr,
});
