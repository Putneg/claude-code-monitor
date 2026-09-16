import { describe, expect, it } from 'vitest';
import {
  EMPTY_CODEX_STATE,
  isCodexCandidate,
  MAX_TURNS,
  parseCodexLine,
  parseCodexState,
  serializeCodexState,
  toCodexTokens,
  type CodexState,
  type CodexStep,
} from '../../src/server/ingest/codex-parser.js';
import { MAX_ID_LENGTH, type ParseContext } from '../../src/server/ingest/parser.js';
import {
  CODEX_CWD,
  CODEX_TS,
  responseMessageLine,
  sessionMetaLine,
  tokenCountLine,
  turnContextLine,
  usageRecordLine,
} from '../helpers/codex-records.js';

const NOW = Date.parse('2026-09-12T00:00:00.000Z');
const ctx: ParseContext = { toLocalDay: (ts: number) => new Date(ts).toISOString().slice(0, 10), now: NOW };
const RESETS_S = Date.parse('2026-09-10T17:00:00.000Z') / 1_000;

interface Run {
  readonly state: CodexState;
  readonly steps: readonly CodexStep[];
}

/** Feeds the lines in order, starting from `state`. */
function run(lines: readonly string[], state: CodexState = EMPTY_CODEX_STATE): Run {
  return lines.reduce<Run>(
    (acc, line) => {
      const result = parseCodexLine(acc.state, line, ctx);
      return { state: result.state, steps: [...acc.steps, result.step] };
    },
    { state, steps: [] },
  );
}

const usages = (steps: readonly CodexStep[]) => steps.flatMap((step) => (step.kind === 'usage' ? [step] : []));
const limitSteps = (steps: readonly CodexStep[]) => steps.flatMap((step) => (step.kind === 'limits' ? [step.snapshot] : []));
const last = (result: Run): CodexStep | undefined => result.steps.at(-1);

const meta = sessionMetaLine({ id: 'cx-main' });
const sol = turnContextLine({ turnId: 't1', model: 'gpt-5.6-sol' });

describe('isCodexCandidate', () => {
  it('accepts lines with a record marker, in strings and buffers', () => {
    expect(isCodexCandidate(meta)).toBe(true);
    expect(isCodexCandidate(Buffer.from(sol))).toBe(true);
    expect(isCodexCandidate(usageRecordLine({ responseId: 'r', threadId: 't' }))).toBe(true);
    expect(isCodexCandidate(tokenCountLine({}))).toBe(true);
    expect(isCodexCandidate(responseMessageLine('hello'))).toBe(false);
  });
});

describe('parseCodexLine usage', () => {
  it('turns a main-thread record into a codex row and a session touch', () => {
    const record = usageRecordLine({
      responseId: 'resp_1',
      threadId: 'cx-main',
      turnId: 't1',
      input: 1_000,
      cached: 600,
      output: 50,
      reasoning: 20,
    });
    const [step] = usages(run([meta, sol, record]).steps);
    expect(step).toEqual({
      kind: 'usage',
      row: {
        client: 'codex',
        messageId: 'resp_1',
        requestId: '',
        kind: 'primary',
        seq: 0,
        sessionId: 'cx-main',
        agentId: null,
        isSidechain: false,
        model: 'gpt-5.6-sol',
        speed: 'standard',
        ts: Date.parse(CODEX_TS),
        localDay: '2026-09-10',
        input: 400,
        output: 50,
        cacheRead: 600,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        webSearchRequests: 0,
        webFetchRequests: 0,
      },
      touch: { sessionId: 'cx-main', cwd: CODEX_CWD, isSidechain: false, ts: Date.parse(CODEX_TS) },
    });
  });

  it('files a subagent record under the parent session as sidechain usage', () => {
    const lines = [
      sessionMetaLine({ id: 'cx-guard', sessionId: 'cx-main', subagent: true }),
      turnContextLine({ turnId: 'g1', model: 'codex-auto-review' }),
      usageRecordLine({ responseId: 'resp_g', threadId: 'cx-guard', sessionId: 'cx-main', turnId: 'g1', output: 5 }),
    ];
    const [step] = usages(run(lines).steps);
    expect(step?.row).toMatchObject({ sessionId: 'cx-main', agentId: 'cx-guard', isSidechain: true, model: 'codex-auto-review' });
    expect(step?.touch).toMatchObject({ sessionId: 'cx-main', isSidechain: true });
  });

  it('takes the model of the record turn, not the latest turn', () => {
    const lines = [
      turnContextLine({ turnId: 't1', model: 'gpt-6-astra' }),
      turnContextLine({ turnId: 't2', model: 'gpt-5.6-sol' }),
      usageRecordLine({ responseId: 'r1', threadId: 'cx', turnId: 't1' }),
      usageRecordLine({ responseId: 'r2', threadId: 'cx', turnId: 't2' }),
    ];
    expect(usages(run(lines).steps).map((step) => step.row.model)).toEqual(['gpt-6-astra', 'gpt-5.6-sol']);
  });

  it('falls back to the latest model for a record whose turn it has not seen', () => {
    const lines = [sol, usageRecordLine({ responseId: 'r1', threadId: 'cx', turnId: 'other' })];
    const lines2 = [sol, usageRecordLine({ responseId: 'r2', threadId: 'cx', turnId: null })];
    expect(usages(run(lines).steps)[0]?.row.model).toBe('gpt-5.6-sol');
    expect(usages(run(lines2).steps)[0]?.row.model).toBe('gpt-5.6-sol');
  });

  it('skips a record before any model is known', () => {
    expect(last(run([meta, usageRecordLine({ responseId: 'r1', threadId: 'cx-main' })]))).toEqual({
      kind: 'skipped',
      reason: 'unknown_model',
    });
  });

  it('resolves the model from a state saved after an earlier read', () => {
    const first = run([meta, sol]);
    const restored = parseCodexState(serializeCodexState(first.state));
    expect(restored).toEqual(first.state);
    const second = run(
      [usageRecordLine({ responseId: 'r1', threadId: 'cx-main', turnId: 't1', output: 1 })],
      restored ?? EMPTY_CODEX_STATE,
    );
    expect(usages(second.steps)[0]?.row).toMatchObject({ model: 'gpt-5.6-sol' });
    expect(usages(second.steps)[0]?.touch.cwd).toBe(CODEX_CWD);
  });

  it('gets no usage from token_count lines: forked subagents and imported sessions only carry cumulative totals', () => {
    const forked = [
      sessionMetaLine({ id: 'cx-fork', sessionId: 'cx-main', subagent: true }),
      tokenCountLine({ totalTokens: 7_000_000 }),
      turnContextLine({ turnId: 'f1', model: 'gpt-5.6-sol' }),
      usageRecordLine({ responseId: 'resp_f', threadId: 'cx-fork', sessionId: 'cx-main', turnId: 'f1', output: 3 }),
      tokenCountLine({ totalTokens: 7_000_003 }),
    ];
    const imported = [sessionMetaLine({ id: 'cx-imported' }), tokenCountLine({ totalTokens: 20_932 })];
    expect(usages(run(forked).steps).map((step) => step.row.messageId)).toEqual(['resp_f']);
    expect(run(imported).steps.every((step) => step.kind === 'ignored')).toBe(true);
  });

  it('skips a record with a timestamp outside the accepted window', () => {
    const record = usageRecordLine({ responseId: 'r1', threadId: 'cx', timestamp: '2030-01-01T00:00:00.000Z' });
    expect(last(run([sol, record]))).toEqual({ kind: 'skipped', reason: 'invalid_timestamp' });
  });

  it.each([
    [
      'a missing response id',
      JSON.stringify({ timestamp: CODEX_TS, type: 'token_usage_record', payload: { thread_id: 'a', session_id: 'a', usage: {} } }),
    ],
    ['an id over the length limit', usageRecordLine({ responseId: 'r'.repeat(MAX_ID_LENGTH + 1), threadId: 'cx' })],
    ['a negative token count', usageRecordLine({ responseId: 'r1', threadId: 'cx', input: -1 })],
    ['a fractional token count', usageRecordLine({ responseId: 'r1', threadId: 'cx', output: 1.5 })],
  ])('skips a record with %s', (_label, line) => {
    expect(last(run([sol, line]))).toEqual({ kind: 'skipped', reason: 'invalid_record' });
  });

  it('skips a line with a marker that is not JSON', () => {
    expect(last(run(['{"type":"token_usage_record",']))).toEqual({ kind: 'skipped', reason: 'invalid_json' });
  });

  it('ignores lines that only mention a marker in their text, and JSON that is not an object', () => {
    const result = run([sol, responseMessageLine('the "token_usage_record" and "turn_context" lines'), '["token_count"]']);
    expect(result.steps.slice(1)).toEqual([{ kind: 'ignored' }, { kind: 'ignored' }]);
    expect(result.state).toEqual(run([sol]).state);
  });

  it('ignores a record whose type is none of the known markers, even when a candidate marker appears unescaped', () => {
    const line = JSON.stringify({ timestamp: CODEX_TS, type: 'response_item', payload: { note: 'token_usage_record' } });
    expect(run([line]).steps).toEqual([{ kind: 'ignored' }]);
  });
});

describe('toCodexTokens', () => {
  it('splits input into uncached input, cache reads and cache writes', () => {
    expect(toCodexTokens({ input_tokens: 1_000, cached_input_tokens: 600, cache_write_input_tokens: 100, output_tokens: 50 })).toEqual({
      input: 300,
      output: 50,
      cacheRead: 600,
      cacheWrite5m: 100,
      cacheWrite1h: 0,
    });
  });

  it('treats missing cache fields as zero', () => {
    expect(toCodexTokens({ input_tokens: 10, output_tokens: 2 })).toEqual({
      input: 10,
      output: 2,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    });
  });

  it('never lets cache tokens exceed the input', () => {
    expect(toCodexTokens({ input_tokens: 100, cached_input_tokens: 150, cache_write_input_tokens: 10, output_tokens: 0 })).toMatchObject({
      input: 0,
      cacheRead: 100,
      cacheWrite5m: 0,
    });
    expect(toCodexTokens({ input_tokens: 100, cached_input_tokens: 60, cache_write_input_tokens: 70, output_tokens: 0 })).toMatchObject({
      input: 0,
      cacheRead: 60,
      cacheWrite5m: 40,
    });
  });
});

describe('parseCodexLine rate limits', () => {
  it('reads a rate-limit snapshot from a token_count line', () => {
    const line = tokenCountLine({
      totalTokens: 100,
      rateLimits: {
        planType: 'plus',
        primary: { usedPercent: 12.5, windowMinutes: 300, resetsAt: RESETS_S },
        secondary: { usedPercent: 3, windowMinutes: 10_080 },
        credits: { hasCredits: true, unlimited: false, balance: '12.50' },
      },
    });
    expect(limitSteps(run([line]).steps)).toEqual([
      {
        limitId: 'codex',
        planType: 'plus',
        primary: { usedPercent: 12.5, windowMinutes: 300, resetsAt: RESETS_S * 1_000 },
        secondary: { usedPercent: 3, windowMinutes: 10_080, resetsAt: null },
        credits: { hasCredits: true, unlimited: false, balance: '12.50' },
        observedAt: Date.parse(CODEX_TS),
      },
    ]);
  });

  it('reads limits from a token_count line without usage info, and keeps missing plan and credits as null', () => {
    const line = tokenCountLine({
      totalTokens: null,
      rateLimits: { planType: null, credits: null, primary: { usedPercent: 1, windowMinutes: 60 } },
    });
    expect(limitSteps(run([line]).steps)).toEqual([
      expect.objectContaining({
        planType: null,
        credits: null,
        primary: { usedPercent: 1, windowMinutes: 60, resetsAt: null },
        secondary: null,
      }),
    ]);
  });

  it('clamps the used percentage to 0-100', () => {
    const line = tokenCountLine({
      rateLimits: { primary: { usedPercent: 150, windowMinutes: 300 }, secondary: { usedPercent: -3, windowMinutes: 10_080 } },
    });
    const [snapshot] = limitSteps(run([line]).steps);
    expect([snapshot?.primary?.usedPercent, snapshot?.secondary?.usedPercent]).toEqual([100, 0]);
  });

  it.each([
    ['no rate limits', tokenCountLine({ totalTokens: 5 })],
    ['limits without any window', tokenCountLine({ rateLimits: { limitId: 'premium' } })],
    ['a zero-minute window', tokenCountLine({ rateLimits: { primary: { usedPercent: 1, windowMinutes: 0 } } })],
    [
      'a reset time after 2100',
      tokenCountLine({ rateLimits: { primary: { usedPercent: 1, windowMinutes: 60, resetsAt: 4_102_444_801 } } }),
    ],
    [
      'a timestamp outside the window',
      tokenCountLine({ timestamp: 'not a date', rateLimits: { primary: { usedPercent: 1, windowMinutes: 60 } } }),
    ],
    [
      'another event type',
      JSON.stringify({ timestamp: CODEX_TS, type: 'event_msg', payload: { type: 'user_message', kind: 'token_count' } }),
    ],
  ])('ignores %s', (_label, line) => {
    expect(run([line]).steps).toEqual([{ kind: 'ignored' }]);
  });

  it('keeps a null credits balance as null', () => {
    const line = tokenCountLine({
      rateLimits: {
        primary: { usedPercent: 1, windowMinutes: 60 },
        credits: { hasCredits: false, unlimited: true, balance: null },
      },
    });
    expect(limitSteps(run([line]).steps)).toEqual([
      expect.objectContaining({ credits: { hasCredits: false, unlimited: true, balance: null } }),
    ]);
  });
});

describe('Codex parser state', () => {
  it('takes the cwd from session_meta, normalized, and keeps it over later turn contexts', () => {
    const result = run([sessionMetaLine({ id: 'a', cwd: 'c:\\work\\gamma\\' }), turnContextLine({ model: 'm', cwd: '/elsewhere' })]);
    expect(result.state.cwd).toBe('C:/work/gamma');
  });

  it('takes the cwd from the first turn context when session_meta has none', () => {
    const result = run([
      sessionMetaLine({ id: 'a', cwd: null }),
      turnContextLine({ model: 'm', cwd: '/first' }),
      turnContextLine({ model: 'm', cwd: '/second' }),
    ]);
    expect(result.state.cwd).toBe('/first');
  });

  it('keeps the latest turns only, and moves a repeated turn to the end', () => {
    const lines = Array.from({ length: MAX_TURNS + 1 }, (_, index) => turnContextLine({ turnId: `t${index}`, model: `m${index}` }));
    const full = run(lines).state;
    expect(full.turns).toHaveLength(MAX_TURNS);
    expect(full.turns[0]).toEqual(['t1', 'm1']);
    const repeated = run([turnContextLine({ turnId: 't1', model: 'changed' })], full).state;
    expect(repeated.turns.at(-1)).toEqual(['t1', 'changed']);
    expect(repeated.turns).toHaveLength(MAX_TURNS);
  });

  it('changes nothing for a turn context without a model, except a missing cwd', () => {
    const start = run([sol]).state;
    expect(run([turnContextLine({ turnId: 't9' })], start).state).toEqual(start);
    expect(run([turnContextLine({ turnId: 't9', cwd: '/x' })]).state).toEqual({ cwd: '/x', model: null, turns: [] });
  });

  it('keeps the current model but no turn for a turn context without a turn id', () => {
    expect(run([turnContextLine({ turnId: null, model: 'gpt-6-astra' })]).state).toEqual({
      cwd: CODEX_CWD,
      model: 'gpt-6-astra',
      turns: [],
    });
  });

  it('skips an invalid session_meta or turn_context and keeps the state', () => {
    const start = run([sol]).state;
    const badMeta = JSON.stringify({ timestamp: CODEX_TS, type: 'session_meta', payload: { cwd: '/x' } });
    const badTurn = JSON.stringify({ timestamp: CODEX_TS, type: 'turn_context', payload: { model: 7 } });
    const result = run([badMeta, badTurn], start);
    expect(result.steps).toEqual([
      { kind: 'skipped', reason: 'invalid_record' },
      { kind: 'skipped', reason: 'invalid_record' },
    ]);
    expect(result.state).toEqual(start);
  });

  it.each([
    ['not JSON', '{'],
    ['another version', JSON.stringify({ v: 2, cwd: null, model: null, turns: [] })],
    [
      'too many turns',
      JSON.stringify({ v: 1, cwd: null, model: null, turns: Array.from({ length: MAX_TURNS + 1 }, (_, i) => [`t${i}`, 'm']) }),
    ],
    ['a wrong shape', JSON.stringify({ v: 1, cwd: 3, model: null, turns: [] })],
    ['a JSON array', '[]'],
  ])('rejects a stored state that is %s', (_label, text) => {
    expect(parseCodexState(text)).toBeNull();
  });

  it('round-trips the empty state', () => {
    expect(serializeCodexState(EMPTY_CODEX_STATE)).toBe('{"v":1,"cwd":null,"model":null,"turns":[]}');
    expect(parseCodexState(serializeCodexState(EMPTY_CODEX_STATE))).toEqual(EMPTY_CODEX_STATE);
  });
});
