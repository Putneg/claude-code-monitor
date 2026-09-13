import { describe, expect, it } from 'vitest';
import {
  FUTURE_SLACK_MS,
  isCandidateLine,
  MAX_CWD_LENGTH,
  MAX_ID_LENGTH,
  MAX_ITERATIONS,
  MAX_TITLE_CODE_POINTS,
  MAX_TOKEN_COUNT,
  normalizeCwd,
  parseLine,
  type ParseContext,
  type ParsedLine,
  type UsageRow,
} from '../../src/server/ingest/parser.js';
import { MAX_LIST_ITEM_LENGTH } from '../../src/shared/limits.js';
import { assistantLine, titleLine, userLine, type AssistantInput, type UsageInput } from '../helpers/records.js';

const NOW = Date.parse('2026-09-12T00:00:00.000Z');
const ctx: ParseContext = { toLocalDay: (ts: number) => new Date(ts).toISOString().slice(0, 10), now: NOW };
const TS = '2026-09-10T12:00:00.000Z';

function usageOf(result: ParsedLine): readonly UsageRow[] {
  if (result.kind !== 'usage') throw new Error(`expected usage, got ${result.kind}`);
  return result.rows;
}

describe('isCandidateLine', () => {
  it('detects usage and title markers in strings and buffers', () => {
    expect(isCandidateLine('{"usage":{"input_tokens":1}}')).toBe(true);
    expect(isCandidateLine(Buffer.from('{"type":"ai-title"}'))).toBe(true);
    expect(isCandidateLine('{"type":"user"}')).toBe(false);
  });
});

describe('parseLine', () => {
  it('ignores lines without markers', () => {
    expect(parseLine(userLine('s1', 'hello'), ctx)).toEqual({ kind: 'ignored' });
  });

  it('ignores non-assistant records that merely contain the usage marker', () => {
    const line = JSON.stringify({ type: 'user', sessionId: 's1', toolUseResult: { usage: { input_tokens: 1 } } });
    expect(parseLine(line, ctx)).toEqual({ kind: 'ignored' });
  });

  it('builds a primary row from the top-level usage', () => {
    const line = assistantLine({
      messageId: 'msg_1',
      requestId: 'req_1',
      model: 'claude-opus-5',
      sessionId: 's1',
      timestamp: TS,
      cwd: 'D:\\src\\alpha',
      usage: { input: 2, output: 455, cacheRead: 33253, cacheWrite1h: 39268 },
    });
    const result = parseLine(line, ctx);
    expect(result).toMatchObject({ kind: 'usage', sessionId: 's1', cwd: 'D:/src/alpha', isSidechain: false });
    expect(usageOf(result)).toEqual([
      {
        messageId: 'msg_1',
        requestId: 'req_1',
        kind: 'primary',
        seq: 0,
        sessionId: 's1',
        agentId: null,
        isSidechain: false,
        model: 'claude-opus-5',
        speed: 'standard',
        ts: Date.parse(TS),
        localDay: '2026-09-10',
        input: 2,
        output: 455,
        cacheRead: 33253,
        cacheWrite5m: 0,
        cacheWrite1h: 39268,
        webSearchRequests: 0,
        webFetchRequests: 0,
      },
    ]);
  });

  it('puts legacy cache creation tokens into the 5m bucket', () => {
    const line = assistantLine({
      messageId: 'msg_2',
      model: 'claude-opus-5',
      sessionId: 's1',
      timestamp: TS,
      usage: { legacyCacheCreation: 900 },
    });
    expect(usageOf(parseLine(line, ctx))[0]).toMatchObject({ cacheWrite5m: 900, cacheWrite1h: 0 });
  });

  it('keeps the cache-creation remainder when the breakdown is incomplete', () => {
    const line = assistantLine({
      messageId: 'msg_3',
      model: 'claude-opus-5',
      sessionId: 's1',
      timestamp: TS,
      usage: { cacheWrite5m: 10, cacheWrite1h: 20, cacheCreationTotal: 50 },
    });
    expect(usageOf(parseLine(line, ctx))[0]).toMatchObject({ cacheWrite5m: 30, cacheWrite1h: 20 });
  });

  it('adds advisor iterations as separate rows at the advisor model', () => {
    const line = assistantLine({
      messageId: 'msg_4',
      model: 'claude-opus-5',
      sessionId: 's1',
      timestamp: TS,
      usage: {
        input: 4,
        output: 1301,
        cacheRead: 145981,
        cacheWrite1h: 1800,
        iterations: [
          { type: 'message', input: 2, output: 218, cacheRead: 72530, cacheWrite1h: 921 },
          { type: 'advisor_message', model: 'claude-fable-5-1', input: 75002, output: 2064 },
          { type: 'message', input: 2, output: 1083, cacheRead: 73451, cacheWrite1h: 879 },
        ],
      },
    });
    const rows = usageOf(parseLine(line, ctx));
    expect(rows.map((r) => [r.kind, r.seq, r.model])).toEqual([
      ['primary', 0, 'claude-opus-5'],
      ['advisor', 1, 'claude-fable-5-1'],
    ]);
    expect(rows[0]).toMatchObject({ input: 4, output: 1301, cacheRead: 145981, cacheWrite1h: 1800 });
    expect(rows[1]).toMatchObject({ input: 75002, output: 2064, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
  });

  it('adds failed primary attempts before a fallback as fallback_attempt rows', () => {
    const line = assistantLine({
      messageId: 'msg_5',
      model: 'claude-opus-4-8',
      sessionId: 's1',
      timestamp: TS,
      usage: {
        input: 2,
        output: 4412,
        cacheWrite5m: 426832,
        iterations: [
          { type: 'message', model: 'claude-fable-5', input: 2, output: 1763, cacheRead: 530736, cacheWrite5m: 1105 },
          { type: 'fallback_message', model: 'claude-opus-4-8', input: 2, output: 4412, cacheWrite5m: 426832 },
        ],
      },
    });
    const rows = usageOf(parseLine(line, ctx));
    expect(rows.map((r) => [r.kind, r.seq, r.model])).toEqual([
      ['primary', 0, 'claude-opus-4-8'],
      ['fallback_attempt', 0, 'claude-fable-5'],
    ]);
    expect(rows[1]).toMatchObject({ output: 1763, cacheRead: 530736, cacheWrite5m: 1105 });
  });

  it('does not add rows for plain message iterations without a fallback', () => {
    const line = assistantLine({
      messageId: 'msg_6',
      model: 'claude-opus-5',
      sessionId: 's1',
      timestamp: TS,
      usage: {
        input: 3,
        iterations: [
          { type: 'message', input: 1 },
          { type: 'message', input: 2 },
        ],
      },
    });
    expect(usageOf(parseLine(line, ctx))).toHaveLength(1);
  });

  it('reads server tool requests for the primary row and for advisor rows', () => {
    const line = assistantLine({
      messageId: 'msg_ws',
      model: 'claude-opus-5',
      sessionId: 's1',
      timestamp: TS,
      usage: {
        output: 10,
        webSearchRequests: 2,
        webFetchRequests: 1,
        iterations: [
          { type: 'message', output: 10 },
          { type: 'advisor_message', model: 'claude-fable-5-1', input: 5, webSearchRequests: 4 },
        ],
      },
    });
    expect(usageOf(parseLine(line, ctx)).map((row) => [row.kind, row.webSearchRequests, row.webFetchRequests])).toEqual([
      ['primary', 2, 1],
      ['advisor', 4, 0],
    ]);
  });

  it('ignores synthetic and API error messages', () => {
    const synthetic = assistantLine({
      messageId: 'msg_7',
      model: '<synthetic>',
      sessionId: 's1',
      timestamp: TS,
      usage: {},
    });
    const apiError = assistantLine({
      messageId: 'msg_8',
      model: 'claude-opus-5',
      sessionId: 's1',
      timestamp: TS,
      isApiErrorMessage: true,
      usage: {},
    });
    expect(parseLine(synthetic, ctx)).toEqual({ kind: 'ignored' });
    expect(parseLine(apiError, ctx)).toEqual({ kind: 'ignored' });
  });

  it('uses an empty request id when requestId is missing', () => {
    const line = assistantLine({
      messageId: 'msg_9',
      requestId: null,
      model: 'claude-opus-5',
      sessionId: 's1',
      timestamp: TS,
      usage: {},
    });
    expect(usageOf(parseLine(line, ctx))[0]?.requestId).toBe('');
  });

  it('marks subagent rows as sidechain with their agent id', () => {
    const line = assistantLine({
      messageId: 'msg_10',
      model: 'claude-sonnet-5',
      sessionId: 'parent',
      timestamp: TS,
      isSidechain: true,
      agentId: 'agent-a1',
      usage: { output: 5 },
    });
    const result = parseLine(line, ctx);
    expect(result).toMatchObject({ kind: 'usage', isSidechain: true, sessionId: 'parent' });
    expect(usageOf(result)[0]).toMatchObject({ isSidechain: true, agentId: 'agent-a1' });
  });

  it('normalizes speed to standard or fast', () => {
    const fast = assistantLine({
      messageId: 'msg_11',
      model: 'claude-opus-5',
      sessionId: 's1',
      timestamp: TS,
      usage: { speed: 'fast' },
    });
    const nullSpeed = assistantLine({
      messageId: 'msg_12',
      model: 'claude-opus-5',
      sessionId: 's1',
      timestamp: TS,
      usage: { speed: null },
    });
    expect(usageOf(parseLine(fast, ctx))[0]?.speed).toBe('fast');
    expect(usageOf(parseLine(nullSpeed, ctx))[0]?.speed).toBe('standard');
  });

  it('reports malformed candidate lines as skipped', () => {
    expect(parseLine('{"usage":{ broken', ctx)).toEqual({ kind: 'skipped', reason: 'invalid_json' });
    const noId = JSON.stringify({
      type: 'assistant',
      timestamp: TS,
      sessionId: 's1',
      message: { model: 'claude-opus-5', usage: { input_tokens: 1 } },
    });
    expect(parseLine(noId, ctx)).toEqual({ kind: 'skipped', reason: 'invalid_record' });
    const badTs = assistantLine({
      messageId: 'msg_13',
      model: 'claude-opus-5',
      sessionId: 's1',
      timestamp: 'yesterday',
      usage: {},
    });
    expect(parseLine(badTs, ctx)).toEqual({ kind: 'skipped', reason: 'invalid_timestamp' });
  });

  it('parses ai-title records', () => {
    expect(parseLine(titleLine('s1', 'Pricing research'), ctx)).toEqual({
      kind: 'title',
      sessionId: 's1',
      title: 'Pricing research',
    });
    const empty = JSON.stringify({ type: 'ai-title', sessionId: 's1' });
    expect(parseLine(empty, ctx)).toEqual({ kind: 'skipped', reason: 'invalid_record' });
  });

  it('uses the injected local-day function', () => {
    const line = assistantLine({
      messageId: 'msg_14',
      model: 'claude-opus-5',
      sessionId: 's1',
      timestamp: TS,
      usage: {},
    });
    const rows = usageOf(parseLine(line, { toLocalDay: () => '1999-01-01', now: NOW }));
    expect(rows[0]?.localDay).toBe('1999-01-01');
  });
});

describe('normalizeCwd', () => {
  it('converts backslashes and trims trailing separators', () => {
    expect(normalizeCwd('D:\\src\\alpha\\')).toBe('D:/src/alpha');
    expect(normalizeCwd('/home/dev/alpha')).toBe('/home/dev/alpha');
    expect(normalizeCwd('')).toBeNull();
    expect(normalizeCwd(undefined)).toBeNull();
  });

  it('treats a cwd longer than MAX_CWD_LENGTH as unknown', () => {
    const longest = `/${'a'.repeat(MAX_CWD_LENGTH - 1)}`;
    expect(normalizeCwd(longest)).toBe(longest);
    expect(normalizeCwd(`${longest}a`)).toBeNull();
  });

  it('upper-cases a leading drive letter only', () => {
    expect(normalizeCwd('c:\\work\\x')).toBe('C:/work/x');
    expect(normalizeCwd('C:/work/x')).toBe('C:/work/x');
    expect(normalizeCwd('/home/c:/x')).toBe('/home/c:/x');
  });
});

const boundedLine = (overrides: Partial<AssistantInput> = {}): string =>
  assistantLine({ messageId: 'msg_b', model: 'claude-opus-5', sessionId: 's1', timestamp: TS, usage: {}, ...overrides });

describe('input bounds', () => {
  it('accepts counts up to MAX_TOKEN_COUNT and rejects larger or fractional ones', () => {
    expect(usageOf(parseLine(boundedLine({ usage: { input: MAX_TOKEN_COUNT } }), ctx))[0]?.input).toBe(1_000_000_000);
    expect(parseLine(boundedLine({ usage: { input: MAX_TOKEN_COUNT + 1 } }), ctx)).toEqual({ kind: 'skipped', reason: 'invalid_record' });
    expect(parseLine(boundedLine({ usage: { output: 1.5 } }), ctx)).toEqual({ kind: 'skipped', reason: 'invalid_record' });
  });

  it('caps web search requests like any other count', () => {
    expect(usageOf(parseLine(boundedLine({ usage: { webSearchRequests: MAX_TOKEN_COUNT } }), ctx))[0]?.webSearchRequests).toBe(
      1_000_000_000,
    );
    expect(parseLine(boundedLine({ usage: { webSearchRequests: MAX_TOKEN_COUNT + 1 } }), ctx)).toEqual({
      kind: 'skipped',
      reason: 'invalid_record',
    });
  });

  it('accepts timestamps from 2023-01-01 to one day after the clock and skips the rest', () => {
    const at = (timestamp: string) => parseLine(boundedLine({ timestamp }), ctx).kind;
    const latest = new Date(NOW + FUTURE_SLACK_MS).toISOString();
    expect(at('2023-01-01T00:00:00.000Z')).toBe('usage');
    expect(at(latest)).toBe('usage');
    expect(parseLine(boundedLine({ timestamp: '2022-12-31T23:59:59.999Z' }), ctx)).toEqual({
      kind: 'skipped',
      reason: 'invalid_timestamp',
    });
    expect(at(new Date(NOW + FUTURE_SLACK_MS + 1).toISOString())).toBe('skipped');
    expect(at('-000001-06-01T00:00:00.000Z')).toBe('skipped');
  });

  it('rejects ids and model names longer than MAX_ID_LENGTH', () => {
    expect(MAX_ID_LENGTH).toBe(MAX_LIST_ITEM_LENGTH);
    const longest = 'x'.repeat(MAX_ID_LENGTH);
    const tooLong = `${longest}x`;
    expect(parseLine(boundedLine({ messageId: longest, requestId: longest, agentId: longest }), ctx).kind).toBe('usage');
    const invalid = { kind: 'skipped', reason: 'invalid_record' };
    expect(parseLine(boundedLine({ messageId: tooLong }), ctx)).toEqual(invalid);
    expect(parseLine(boundedLine({ requestId: tooLong }), ctx)).toEqual(invalid);
    expect(parseLine(boundedLine({ sessionId: tooLong }), ctx)).toEqual(invalid);
    expect(parseLine(boundedLine({ agentId: tooLong }), ctx)).toEqual(invalid);
    expect(parseLine(boundedLine({ model: tooLong }), ctx)).toEqual(invalid);
    expect(parseLine(titleLine(tooLong, 'A title'), ctx)).toEqual(invalid);
  });

  it('keeps an empty request id as data', () => {
    expect(usageOf(parseLine(boundedLine({ requestId: '' }), ctx))[0]?.requestId).toBe('');
  });

  it('stores a line with an overlong cwd without a project', () => {
    const cwd = `/${'a'.repeat(4_096)}`;
    expect(cwd).toHaveLength(MAX_CWD_LENGTH + 1);
    expect(parseLine(boundedLine({ cwd }), ctx)).toMatchObject({ kind: 'usage', cwd: null });
  });

  it('cuts titles to MAX_TITLE_CODE_POINTS code points without splitting a surrogate pair', () => {
    const smile = '\u{1F600}';
    expect(parseLine(titleLine('s1', smile.repeat(MAX_TITLE_CODE_POINTS + 10)), ctx)).toEqual({
      kind: 'title',
      sessionId: 's1',
      title: smile.repeat(MAX_TITLE_CODE_POINTS),
    });
    const exact = 't'.repeat(MAX_TITLE_CODE_POINTS);
    expect(parseLine(titleLine('s1', exact), ctx)).toMatchObject({ title: exact });
  });

  it('accepts 100 iterations and skips a line with more as an invalid record', () => {
    const withIterations = (count: number): string =>
      boundedLine({ usage: { iterations: Array.from({ length: count }, () => ({ type: 'advisor_message', input: 1 })) } });
    expect(usageOf(parseLine(withIterations(100), ctx))).toHaveLength(101);
    expect(parseLine(withIterations(101), ctx)).toEqual({ kind: 'skipped', reason: 'invalid_record' });
    expect(MAX_ITERATIONS).toBe(100);
  });
});

describe('iterations', () => {
  it('drops an invalid iteration and keeps the rest of the line', () => {
    const line = boundedLine({
      usage: {
        input: 4,
        output: 10,
        iterations: [
          { type: 'message', input: 4, output: 10 },
          { type: 'advisor_message', model: 'claude-fable-5-1', input: -1 },
          { type: 'advisor_message', model: 'x'.repeat(MAX_ID_LENGTH + 1), input: 5 },
          { type: 'advisor_message', model: 'claude-fable-5-1', input: 75 },
        ],
      },
    });
    const result = parseLine(line, ctx);
    expect(result).toMatchObject({ kind: 'usage', droppedIterations: 2, advisorMismatch: false });
    expect(usageOf(result).map((row) => [row.kind, row.seq, row.input])).toEqual([
      ['primary', 0, 4],
      ['advisor', 3, 75],
    ]);
  });

  it('reports no dropped iterations for a clean line', () => {
    expect(parseLine(boundedLine({ usage: { input: 1 } }), ctx)).toMatchObject({ droppedIterations: 0, advisorMismatch: false });
  });

  it('keeps the failed attempts when the fallback entry itself is malformed', () => {
    const line = boundedLine({
      usage: {
        output: 40,
        iterations: [
          { type: 'message', model: 'claude-fable-5', output: 17 },
          { type: 'fallback_message', model: 'claude-opus-5', output: -1 },
        ],
      },
    });
    const result = parseLine(line, ctx);
    expect(result).toMatchObject({ kind: 'usage', droppedIterations: 1 });
    expect(usageOf(result).map((row) => [row.kind, row.seq, row.model, row.output])).toEqual([
      ['primary', 0, 'claude-opus-5', 40],
      ['fallback_attempt', 0, 'claude-fable-5', 17],
    ]);
  });
});

describe('advisor usage check', () => {
  const parseUsage = (usage: UsageInput): ParsedLine => parseLine(boundedLine({ usage }), ctx);
  const message = { type: 'message', input: 2, output: 20, cacheRead: 100, cacheWrite1h: 10 };
  const advisor = { type: 'advisor_message', model: 'claude-fable-5-1', input: 500, output: 50 };
  const top = { input: 4, output: 40, cacheRead: 200, cacheWrite1h: 20 };

  it('passes when the top-level usage equals the sum of the message iterations', () => {
    expect(parseUsage({ ...top, iterations: [message, advisor, message] })).toMatchObject({ advisorMismatch: false });
  });

  it.each([
    { name: 'input', usage: { ...top, input: 5 } },
    { name: 'output', usage: { ...top, output: 41 } },
    { name: 'cache read', usage: { ...top, cacheRead: 201 } },
    { name: 'cache creation', usage: { ...top, cacheWrite1h: 21 } },
  ])('fails when the $name count differs', ({ usage }) => {
    expect(parseUsage({ ...usage, iterations: [message, advisor, message] })).toMatchObject({ advisorMismatch: true });
  });

  it('does not apply without an advisor iteration, with a fallback, or with a dropped iteration', () => {
    const off = { ...top, input: 99 };
    expect(parseUsage({ ...off, iterations: [message, message] })).toMatchObject({ advisorMismatch: false });
    const fallback = { type: 'fallback_message', input: 1 };
    expect(parseUsage({ ...off, iterations: [message, advisor, fallback] })).toMatchObject({ advisorMismatch: false });
    const broken = { type: 'message', input: -1 };
    expect(parseUsage({ ...off, iterations: [message, advisor, broken] })).toMatchObject({
      advisorMismatch: false,
      droppedIterations: 1,
    });
  });
});
