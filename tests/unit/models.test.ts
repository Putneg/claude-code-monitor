import { describe, expect, it } from 'vitest';
import {
  FALLBACK_PALETTE,
  OTHER_COLOR,
  TOKEN_TYPE_META,
  TOKEN_TYPE_ORDER,
  hashString,
  modelColor,
  modelLabel,
  projectLabel,
} from '../../src/shared/models.js';

describe('modelLabel', () => {
  it.each([
    ['claude-opus-5', 'opus-5'],
    ['claude-fable-5-1', 'fable-5.1'],
    ['claude-opus-4-8', 'opus-4.8'],
    ['claude-haiku-4-5-20251001', 'haiku-4.5'],
    ['claude-sonnet-5', 'sonnet-5'],
    ['claude-3-5-sonnet-20241022', '3-5-sonnet'],
    ['some-other-model', 'some-other-model'],
  ])('%s -> %s', (id, label) => {
    expect(modelLabel(id)).toBe(label);
  });
});

describe('modelColor', () => {
  it('uses the fixed palette for known models, including dated variants', () => {
    expect(modelColor('claude-opus-5')).toBe('#FFB000');
    expect(modelColor('claude-haiku-4-5-20251001')).toBe('#C792EA');
  });

  it('assigns unknown models a deterministic fallback color', () => {
    const color = modelColor('claude-unknown-9');
    expect(FALLBACK_PALETTE).toContain(color);
    expect(modelColor('claude-unknown-9')).toBe(color);
  });

  it.each(['claude-constructor', '__proto__', 'claude-toString', 'claude-hasOwnProperty'])(
    'gives %s a palette color instead of an Object.prototype member',
    (id) => {
      expect(FALLBACK_PALETTE).toContain(modelColor(id));
    },
  );
});

describe('hashString', () => {
  it('is stable and non-negative', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).toBeGreaterThanOrEqual(0);
    expect(hashString('abc')).not.toBe(hashString('abd'));
  });
});

describe('projectLabel', () => {
  it.each([
    ['D:/src/gamma/team/app', 'team/app'],
    ['D:/datasets', 'D:/datasets'],
    ['/home/dev/alpha', 'dev/alpha'],
    ['C:\\Users\\dev', 'Users/dev'],
    ['/', '/'],
  ])('%s -> %s', (path, label) => {
    expect(projectLabel(path)).toBe(label);
  });
});

/** WCAG 2.x relative luminance of a '#RRGGBB' color. */
function luminance(hex: string): number {
  const channel = (offset: number): number => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

describe('OTHER_COLOR', () => {
  it('keeps the 3:1 contrast graphics need on the page background (#0D0E0B)', () => {
    expect(contrast(OTHER_COLOR, '#0D0E0B')).toBeGreaterThanOrEqual(3);
  });
});

describe('token type metadata', () => {
  it('defines label and color for every token type in display order', () => {
    expect(TOKEN_TYPE_ORDER).toEqual(['cache_read', 'cache_write', 'output', 'input']);
    TOKEN_TYPE_ORDER.forEach((key) => {
      expect(TOKEN_TYPE_META[key].label.length).toBeGreaterThan(0);
      expect(TOKEN_TYPE_META[key].color).toMatch(/^#[0-9A-F]{6}$/);
    });
  });
});
