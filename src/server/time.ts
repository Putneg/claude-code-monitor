import { dayToUtcMs, formatDay, pad2, parseDayOrThrow, type CalendarDay } from '../shared/days.js';

export { addDays, daysInclusive, enumerateDays, isValidDay, parseDay, type CalendarDay } from '../shared/days.js';

const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;

interface ZonedParts extends CalendarDay {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function createPartsReader(timeZone: string): (tsMs: number) => ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  return (tsMs) => {
    const values: Record<string, string> = Object.fromEntries(formatter.formatToParts(tsMs).map((part) => [part.type, part.value]));
    return {
      year: Number(values.year),
      month: Number(values.month),
      day: Number(values.day),
      hour: Number(values.hour),
      minute: Number(values.minute),
      second: Number(values.second),
    };
  };
}

export function createLocalDay(timeZone: string): (tsMs: number) => string {
  const read = createPartsReader(timeZone);
  return (tsMs) => formatDay(read(tsMs));
}

function createOffsetReader(timeZone: string): (tsMs: number) => number {
  const read = createPartsReader(timeZone);
  return (tsMs) => {
    const p = read(tsMs);
    const wallClockAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return wallClockAsUtc - Math.floor(tsMs / 1000) * 1000;
  };
}

export function createZonedDayStart(timeZone: string): (day: string) => number {
  const offsetAt = createOffsetReader(timeZone);
  return (day) => {
    const guess = dayToUtcMs(parseDayOrThrow(day));
    const firstEstimate = guess - offsetAt(guess);
    return guess - offsetAt(firstEstimate);
  };
}

/** '+03:00' or '-05:00' for a UTC offset in milliseconds, at minute precision. */
function formatOffset(offsetMs: number): string {
  const minutes = Math.round(offsetMs / MS_PER_MINUTE);
  const abs = Math.abs(minutes);
  return `${minutes < 0 ? '-' : '+'}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/**
 * Labels for `count` hour buckets starting at `startMs`: 'YYYY-MM-DDTHH:00' in the zone. A local hour that occurs
 * twice (the DST fall-back) would be ambiguous, so both of its buckets get their UTC offset: 'YYYY-MM-DDTHH:00+03:00'.
 */
export function createHourLabels(timeZone: string): (startMs: number, count: number) => string[] {
  const read = createPartsReader(timeZone);
  const offsetAt = createOffsetReader(timeZone);
  return (startMs, count) => {
    const hours = Array.from({ length: count }, (_, index) => {
      const tsMs = startMs + index * MS_PER_HOUR;
      const parts = read(tsMs);
      return { tsMs, label: `${formatDay(parts)}T${pad2(parts.hour)}:00` };
    });
    const seen = hours.reduce((acc, hour) => acc.set(hour.label, (acc.get(hour.label) ?? 0) + 1), new Map<string, number>());
    return hours.map(({ tsMs, label }) => ((seen.get(label) ?? 0) > 1 ? `${label}${formatOffset(offsetAt(tsMs))}` : label));
  };
}
