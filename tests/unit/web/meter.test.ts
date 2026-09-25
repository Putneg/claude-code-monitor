import { describe, expect, it } from 'vitest';
import { meterWidth } from '../../../src/web/lib/meter.js';

describe('meterWidth', () => {
  it('turns a share into a CSS width', () => {
    expect(meterWidth(0.5)).toBe('50%');
    expect(meterWidth(1)).toBe('100%');
  });

  it('shows nothing for zero or less and clamps above one', () => {
    expect(meterWidth(0)).toBe('0%');
    expect(meterWidth(-0.2)).toBe('0%');
    expect(meterWidth(3)).toBe('100%');
    expect(meterWidth(Number.NaN)).toBe('0%');
  });

  it('keeps a tiny non-zero share visible as a 1px sliver', () => {
    expect(meterWidth(0.0004)).toBe('max(1px, 0.04%)');
  });
});
