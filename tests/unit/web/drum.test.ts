import { describe, expect, it } from 'vitest';
import { drumDigits } from '../../../src/web/lib/drum.js';

describe('drumDigits', () => {
  it('splits a value into digit and character cells', () => {
    expect(drumDigits(null, '$1,02').cells).toEqual([
      { kind: 'char', value: '$' },
      { kind: 'digit', value: 1 },
      { kind: 'char', value: ',' },
      { kind: 'digit', value: 0 },
      { kind: 'digit', value: 2 },
    ]);
  });

  it('builds the drum on first show', () => {
    expect(drumDigits(null, '$3.42').rebuild).toBe(true);
  });

  it('keeps the drum when only digits change', () => {
    expect(drumDigits('$16,102.11', '$16,104.87').rebuild).toBe(false);
  });

  it('rebuilds when the length or a separator moves', () => {
    expect(drumDigits('$9,999.99', '$10,000.00').rebuild).toBe(true);
    expect(drumDigits('$3.42', '1.8M').rebuild).toBe(true);
    expect(drumDigits('1.83M', '18.3M').rebuild).toBe(true);
  });
});
