import { describe, expect, it } from 'vitest';
import { resolvePriceKey } from '../../src/server/pricing/resolve.js';

describe('resolvePriceKey', () => {
  it('prefers an exact match', () => {
    expect(resolvePriceKey('claude-opus-5', ['claude-opus-5-1', 'claude-opus-5'])).toBe('claude-opus-5');
  });

  it('falls back to the anthropic/ prefix', () => {
    expect(resolvePriceKey('claude-x-1', ['anthropic/claude-x-1'])).toBe('anthropic/claude-x-1');
  });

  it('maps a dated model id to its undated key', () => {
    const keys = ['claude-opus-4', 'claude-opus-4-1'];
    expect(resolvePriceKey('claude-opus-4-1-20250805', keys)).toBe('claude-opus-4-1');
  });

  it('refuses to match across a minor version (version guard)', () => {
    expect(resolvePriceKey('claude-opus-4-1-20250805', ['claude-opus-4'])).toBeNull();
    expect(resolvePriceKey('claude-opus-5', ['claude-opus-5-1'])).toBeNull();
  });

  it('matches a model contained in a dated key', () => {
    expect(resolvePriceKey('claude-sonnet-5', ['claude-sonnet-5-20260101'])).toBe('claude-sonnet-5-20260101');
  });

  it('normalizes dots and at-signs', () => {
    expect(resolvePriceKey('claude-3.5-sonnet', ['claude-3-5-sonnet'])).toBe('claude-3-5-sonnet');
  });

  it('matches provider-qualified ids at word boundaries', () => {
    expect(resolvePriceKey('us.anthropic.claude-haiku-4-5-v1:0', ['claude-haiku-4-5'])).toBe('claude-haiku-4-5');
  });

  it('requires alphanumeric boundaries', () => {
    expect(resolvePriceKey('claude-opus-50', ['claude-opus-5'])).toBeNull();
  });

  it('picks the longest matching key', () => {
    const keys = ['claude-haiku-4', 'claude-haiku-4-5'];
    expect(resolvePriceKey('claude-haiku-4-5-20251001', keys)).toBe('claude-haiku-4-5');
  });

  it('returns null when nothing matches', () => {
    expect(resolvePriceKey('gpt-4o', ['claude-opus-5'])).toBeNull();
  });
});
