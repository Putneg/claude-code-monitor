export const EM_DASH = '—';

const TWO_DECIMALS = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const WHOLE = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** Money for tables and captions: $12,345 · $123 · $1.23 · <$0.01 · $0. */
export function formatUsd(value: number): string {
  if (value < 0) return `-${formatUsd(-value)}`;
  if (value === 0) return '$0';
  if (value < 0.01) return '<$0.01';
  if (value < 99.995) return `$${TWO_DECIMALS.format(value)}`;
  return `$${WHOLE.format(value)}`;
}

/** The hero number: always two decimals with grouping, $1,234.56. */
export function formatUsdExact(value: number): string {
  return `${value < 0 ? '-' : ''}$${TWO_DECIMALS.format(Math.abs(value))}`;
}

const trimmed = (value: number, digits: number): string => String(Number(value.toFixed(digits)));

/** Compact money for chart axes: $0 · $0.25 · $12 · $1.5k. */
export function formatUsdAxis(value: number): string {
  if (value < 0) return `-${formatUsdAxis(-value)}`;
  if (value >= 999.5) return `$${trimmed(value / 1_000, 1)}k`;
  if (value >= 10) return `$${Math.round(value)}`;
  return `$${trimmed(value, 2)}`;
}

/** Effective price per million tokens, or a dash for a model without a price. */
export const formatRate = (value: number | null): string => (value === null ? EM_DASH : `$${value.toFixed(2)}`);

/** Token counts: 999 · 12k · 1.8M · 2.35B. The thresholds keep rounding from printing 1000, 1000k or 1000.0M. */
export function formatTokens(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 999_950_000) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 999_500) return `${(value / 1e6).toFixed(1)}M`;
  if (abs >= 999.5) return `${(value / 1e3).toFixed(0)}k`;
  return String(Math.round(value));
}

/** A share in [0, 1] as a percentage: 12.3% · <0.1% · 0%. */
export function formatPercent(share: number, digits = 1): string {
  if (!Number.isFinite(share) || share <= 0) return '0%';
  const percent = share * 100;
  const smallest = 10 ** -digits;
  if (percent < smallest) return `<${smallest}%`;
  return `${percent.toFixed(digits)}%`;
}

/** File sizes in binary units: 512B · 12K · 340M · 3.0G. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}G`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)}M`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}K`;
  return `${bytes}B`;
}

/** 'YYYY-MM-DD' -> 'MM-DD'. */
export const shortDay = (day: string): string => day.slice(5, 10);

/** Length of a plain hour label, 'YYYY-MM-DDTHH:00'; a repeated DST hour appends its UTC offset, e.g. '+02:00'. */
const HOUR_LABEL_LENGTH = 16;

/** The UTC offset of a repeated-hour label, or '' for every other label. */
const bucketOffset = (bucket: string): string => bucket.slice(HOUR_LABEL_LENGTH);

/**
 * Tooltip and hero label: '2026-09-11' -> '09-11', '2026-09-11T14:00' -> '09-11 14:00', and a repeated DST hour
 * '2026-10-25T03:00+02:00' -> '10-25 03:00 (UTC+02:00)'.
 */
export function bucketLabel(bucket: string): string {
  if (bucket.length <= 10) return shortDay(bucket);
  const offset = bucketOffset(bucket);
  return `${shortDay(bucket)} ${bucket.slice(11, 16)}${offset === '' ? '' : ` (UTC${offset})`}`;
}

/** Axis tick: hour buckets show only the time when the whole range is a single day; a repeated hour adds '+02' (or '+10:30'). */
export function axisBucketLabel(bucket: string, multiDay: boolean): string {
  if (bucket.length <= 10) return shortDay(bucket);
  const offset = bucketOffset(bucket).replace(/:00$/, '');
  return multiDay ? `${shortDay(bucket)} ${bucket.slice(11, 13)}h${offset}` : `${bucket.slice(11, 16)}${offset}`;
}

interface ZonedStamp {
  readonly year: string;
  readonly month: string;
  readonly day: string;
  readonly hour: string;
  readonly minute: string;
  readonly second: string;
}

const STAMP_OPTIONS: Intl.DateTimeFormatOptions = {
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
};

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function createFormatter(timeZone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat('en-US', { ...STAMP_OPTIONS, timeZone });
  } catch {
    // An unknown zone name would throw on every render; UTC keeps the page usable.
    return new Intl.DateTimeFormat('en-US', { ...STAMP_OPTIONS, timeZone: 'UTC' });
  }
}

/** One formatter per zone: constructing Intl.DateTimeFormat is costly and a table formats many timestamps. */
function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = FORMATTERS.get(timeZone);
  if (cached !== undefined) return cached;
  const formatter = createFormatter(timeZone);
  FORMATTERS.set(timeZone, formatter);
  return formatter;
}

function zonedStamp(iso: string, timeZone: string): ZonedStamp | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const parts = new Map(
    zonedFormatter(timeZone)
      .formatToParts(ms)
      .map((part) => [part.type, part.value]),
  );
  const read = (type: Intl.DateTimeFormatPartTypes): string => parts.get(type) ?? '00';
  return { year: read('year'), month: read('month'), day: read('day'), hour: read('hour'), minute: read('minute'), second: read('second') };
}

/** 'HH:MM:SS' in the zone. */
export function formatClock(iso: string, timeZone: string): string {
  const stamp = zonedStamp(iso, timeZone);
  return stamp ? `${stamp.hour}:${stamp.minute}:${stamp.second}` : EM_DASH;
}

/** 'MM-DD HH:MM' in the zone. */
export function formatStamp(iso: string, timeZone: string): string {
  const stamp = zonedStamp(iso, timeZone);
  return stamp ? `${stamp.month}-${stamp.day} ${stamp.hour}:${stamp.minute}` : EM_DASH;
}

/** 'YYYY-MM-DD HH:MM:SS' in the zone. */
export function formatDateTime(iso: string, timeZone: string): string {
  const stamp = zonedStamp(iso, timeZone);
  return stamp ? `${stamp.year}-${stamp.month}-${stamp.day} ${stamp.hour}:${stamp.minute}:${stamp.second}` : EM_DASH;
}

/** 'HH:MM' in the zone. */
export function formatTimeOfDay(iso: string, timeZone: string): string {
  const stamp = zonedStamp(iso, timeZone);
  return stamp ? `${stamp.hour}:${stamp.minute}` : EM_DASH;
}

/** 'YYYY-MM-DD' of the instant in the zone, or '' for an invalid timestamp. */
export function zonedDay(iso: string, timeZone: string): string {
  const stamp = zonedStamp(iso, timeZone);
  return stamp ? `${stamp.year}-${stamp.month}-${stamp.day}` : '';
}

export const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** For the ECharts tooltip, the only place that builds HTML from data. */
export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
