import { describe, expect, it } from 'vitest';
import {
  axisBucketLabel,
  bucketLabel,
  EM_DASH,
  escapeHtml,
  formatBytes,
  formatClock,
  formatDateTime,
  formatPercent,
  formatRate,
  formatStamp,
  formatTimeOfDay,
  formatTokens,
  formatUsd,
  formatUsdAxis,
  formatUsdExact,
  plural,
  shortDay,
  zonedDay,
} from '../../../src/web/lib/format.js';

describe('money', () => {
  it('adapts precision to the amount', () => {
    expect(formatUsd(0)).toBe('$0');
    expect(formatUsd(0.004)).toBe('<$0.01');
    expect(formatUsd(1.234)).toBe('$1.23');
    expect(formatUsd(99.5)).toBe('$99.50');
    expect(formatUsd(123.4)).toBe('$123');
    expect(formatUsd(12_345.6)).toBe('$12,346');
    expect(formatUsd(-5)).toBe('-$5.00');
  });

  it('prints the hero number with two decimals', () => {
    expect(formatUsdExact(1_234.5)).toBe('$1,234.50');
    expect(formatUsdExact(0)).toBe('$0.00');
  });

  it('keeps axis labels short', () => {
    expect(formatUsdAxis(0)).toBe('$0');
    expect(formatUsdAxis(0.25)).toBe('$0.25');
    expect(formatUsdAxis(12.4)).toBe('$12');
    expect(formatUsdAxis(1_500)).toBe('$1.5k');
    expect(formatUsdAxis(2_000)).toBe('$2k');
  });

  it('formats the cost per million tokens', () => {
    expect(formatRate(1.234)).toBe('$1.23');
    expect(formatRate(null)).toBe(EM_DASH);
  });
});

describe('formatTokens', () => {
  it('uses k, M and B without rounding up into the next unit', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(245_000)).toBe('245k');
    expect(formatTokens(999_499)).toBe('999k');
    expect(formatTokens(999_500)).toBe('1.0M');
    expect(formatTokens(1_833_000)).toBe('1.8M');
    expect(formatTokens(999_949_999)).toBe('999.9M');
    expect(formatTokens(2_346_000_000)).toBe('2.35B');
  });
});

describe('formatPercent', () => {
  it('formats shares with a floor for tiny values', () => {
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(0.0004)).toBe('<0.1%');
    expect(formatPercent(0.1234)).toBe('12.3%');
    expect(formatPercent(0.004, 0)).toBe('<1%');
    expect(formatPercent(0.97, 0)).toBe('97%');
    expect(formatPercent(Number.NaN)).toBe('0%');
  });
});

describe('formatBytes', () => {
  it('uses binary units', () => {
    expect(formatBytes(512)).toBe('512B');
    expect(formatBytes(12 * 1024)).toBe('12K');
    expect(formatBytes(340 * 1024 ** 2)).toBe('340M');
    expect(formatBytes(3.04 * 1024 ** 3)).toBe('3.0G');
  });
});

describe('labels', () => {
  it('shortens days and buckets', () => {
    expect(shortDay('2026-09-11')).toBe('09-11');
    expect(bucketLabel('2026-09-11')).toBe('09-11');
    expect(bucketLabel('2026-09-11T14:00')).toBe('09-11 14:00');
    expect(axisBucketLabel('2026-09-11', true)).toBe('09-11');
    expect(axisBucketLabel('2026-09-11T14:00', false)).toBe('14:00');
    expect(axisBucketLabel('2026-09-11T14:00', true)).toBe('09-11 14h');
  });

  it('shows the UTC offset of a repeated DST hour, in full in labels and short on the axis', () => {
    expect(bucketLabel('2026-10-25T03:00+03:00')).toBe('10-25 03:00 (UTC+03:00)');
    expect(bucketLabel('2026-11-01T01:00-05:00')).toBe('11-01 01:00 (UTC-05:00)');
    expect(axisBucketLabel('2026-10-25T03:00+02:00', false)).toBe('03:00+02');
    expect(axisBucketLabel('2026-10-25T03:00+02:00', true)).toBe('10-25 03h+02');
    expect(axisBucketLabel('2026-04-05T01:00+10:30', false)).toBe('01:00+10:30');
  });

  it('pluralizes nouns', () => {
    expect(plural(1, 'project')).toBe('1 project');
    expect(plural(2, 'file')).toBe('2 files');
    expect(plural(0, 'model')).toBe('0 models');
  });
});

describe('zoned time', () => {
  const iso = '2026-09-11T21:02:03.000Z';

  it('formats instants in the given zone', () => {
    expect(formatClock(iso, 'Europe/Kyiv')).toBe('00:02:03');
    expect(formatStamp(iso, 'Europe/Kyiv')).toBe('09-12 00:02');
    expect(formatTimeOfDay(iso, 'UTC')).toBe('21:02');
    expect(zonedDay(iso, 'Europe/Kyiv')).toBe('2026-09-12');
  });

  it('prints the full date and time in the zone', () => {
    expect(formatDateTime(iso, 'UTC')).toBe('2026-09-11 21:02:03');
    expect(formatDateTime(iso, 'Asia/Tokyo')).toBe('2026-09-12 06:02:03');
    expect(formatDateTime('not-a-date', 'UTC')).toBe(EM_DASH);
  });

  it('falls back to UTC for an unknown zone and to a dash for a bad timestamp', () => {
    expect(formatClock(iso, 'Mars/Base')).toBe('21:02:03');
    expect(formatStamp('not-a-date', 'UTC')).toBe(EM_DASH);
    expect(zonedDay('not-a-date', 'UTC')).toBe('');
  });
});

describe('escapeHtml', () => {
  it('escapes markup characters', () => {
    expect(escapeHtml(`<img src=x onerror="a('b')">&`)).toBe('&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
  });
});

describe('rounding boundaries', () => {
  it('never prints a value that belongs to the next tier', () => {
    expect(formatUsd(99.996)).toBe('$100');
    expect(formatUsdAxis(999.6)).toBe('$1k');
    expect(formatTokens(999.6)).toBe('1k');
  });
});
