import { describe, expect, it } from 'vitest';
import { createFileParser, resumeFileParser, type FileParser } from '../../src/server/ingest/file-parser.js';
import type { ParseContext } from '../../src/server/ingest/parser.js';
import { sessionMetaLine, tokenCountLine, turnContextLine, usageRecordLine } from '../helpers/codex-records.js';
import { titleLine, userLine } from '../helpers/records.js';

const ctx: ParseContext = { toLocalDay: (ts: number) => new Date(ts).toISOString().slice(0, 10), now: Date.parse('2026-09-12T00:00:00Z') };

function feed(parser: FileParser, lines: readonly string[]): FileParser {
  lines
    .map((line) => Buffer.from(line))
    .forEach((raw) => {
      if (parser.accepts(raw)) parser.push(raw.toString('utf8'));
    });
  return parser;
}

/** A Claude Code assistant line with a hand-built usage object, for iteration shapes the record helper cannot emit. */
const assistantWith = (messageId: string, usage: Record<string, unknown>): string =>
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-09-10T10:00:00.000Z',
    sessionId: 's1',
    cwd: '/home/dev/alpha',
    message: { id: messageId, model: 'claude-opus-5', usage },
  });

describe('Claude file parser', () => {
  it('collects rows, touches, titles and counters, and keeps no state', () => {
    const parser = feed(createFileParser('claude', ctx), [
      userLine('s1', 'hi'),
      // The top-level output (3) differs from the message iterations (1): an advisor usage mismatch.
      assistantWith('m1', {
        output_tokens: 3,
        iterations: [
          { type: 'message', output_tokens: 1 },
          { type: 'advisor_message', model: 'claude-fable-5-1', output_tokens: 1 },
        ],
      }),
      // An iteration with a numeric type fails validation and is dropped.
      assistantWith('m2', { output_tokens: 1, iterations: [{ type: 7 }] }),
      titleLine('s1', 'Alpha'),
      '{"usage":{',
    ]);
    const parsed = parser.finish();
    expect(parsed.rows.map((row) => [row.client, row.messageId, row.kind, row.model])).toEqual([
      ['claude', 'm1', 'primary', 'claude-opus-5'],
      ['claude', 'm1', 'advisor', 'claude-fable-5-1'],
      ['claude', 'm2', 'primary', 'claude-opus-5'],
    ]);
    const touch = { sessionId: 's1', cwd: '/home/dev/alpha', isSidechain: false, ts: Date.parse('2026-09-10T10:00:00.000Z') };
    expect(parsed.touches).toEqual([touch, touch]);
    expect(parsed.titles).toEqual([{ sessionId: 's1', title: 'Alpha' }]);
    expect(parsed).toMatchObject({ limits: [], skipped: 1, droppedIterations: 1, usageMismatches: 1 });
    expect(parser.state()).toBeNull();
  });

  it('resumes without stored state', () => {
    expect(resumeFileParser('claude', null, ctx)).not.toBeNull();
  });
});

describe('Codex file parser', () => {
  const lines = [
    sessionMetaLine({ id: 'cx-main' }),
    turnContextLine({ turnId: 't1', model: 'gpt-5.6-sol' }),
    usageRecordLine({ responseId: 'resp_1', threadId: 'cx-main', turnId: 't1', output: 2 }),
    tokenCountLine({ rateLimits: { primary: { usedPercent: 5, windowMinutes: 300 } } }),
    usageRecordLine({ responseId: 'resp_bad', threadId: 'cx-main', output: -1 }),
  ];

  it('collects rows, touches, limit snapshots and skipped lines, and stores its state', () => {
    const parser = feed(createFileParser('codex', ctx), lines);
    const parsed = parser.finish();
    expect(parsed.rows.map((row) => [row.client, row.messageId, row.model])).toEqual([['codex', 'resp_1', 'gpt-5.6-sol']]);
    expect(parsed.touches).toHaveLength(1);
    expect(parsed.limits.map((snapshot) => snapshot.primary?.usedPercent)).toEqual([5]);
    expect(parsed).toMatchObject({ titles: [], skipped: 1, droppedIterations: 0, usageMismatches: 0 });
    expect(JSON.parse(parser.state() ?? 'null')).toMatchObject({ v: 1, model: 'gpt-5.6-sol', turns: [['t1', 'gpt-5.6-sol']] });
  });

  it('resumes from a stored state', () => {
    const first = feed(createFileParser('codex', ctx), lines.slice(0, 2));
    const resumed = resumeFileParser('codex', first.state(), ctx);
    if (resumed === null) throw new Error('expected a resumed parser');
    feed(resumed, [usageRecordLine({ responseId: 'resp_2', threadId: 'cx-main', turnId: 't1' })]);
    expect(resumed.finish().rows.map((row) => row.model)).toEqual(['gpt-5.6-sol']);
  });

  it('refuses to resume without a usable state', () => {
    expect(resumeFileParser('codex', null, ctx)).toBeNull();
    expect(resumeFileParser('codex', 'not json', ctx)).toBeNull();
  });

  it('accepts only lines with a Codex marker', () => {
    const parser = createFileParser('codex', ctx);
    expect(parser.accepts(Buffer.from('{"type":"response_item"}'))).toBe(false);
    expect(parser.accepts(Buffer.from(lines[0] ?? ''))).toBe(true);
  });
});
