const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** A calendar date without a time zone; months are 1-based. */
export interface CalendarDay {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export const pad2 = (value: number): string => String(value).padStart(2, '0');

export const formatDay = (parts: CalendarDay): string => `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;

export const dayToUtcMs = (parts: CalendarDay): number => Date.UTC(parts.year, parts.month - 1, parts.day);

export function parseDay(value: string): CalendarDay | null {
  const match = DAY_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  const valid = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return valid ? { year, month, day } : null;
}

export function parseDayOrThrow(value: string): CalendarDay {
  const parsed = parseDay(value);
  if (!parsed) throw new RangeError(`Invalid day: ${value}`);
  return parsed;
}

export const isValidDay = (value: string): boolean => parseDay(value) !== null;

export function addDays(day: string, amount: number): string {
  const start = dayToUtcMs(parseDayOrThrow(day));
  return new Date(start + amount * MS_PER_DAY).toISOString().slice(0, 10);
}

export function daysInclusive(from: string, to: string): number {
  const span = dayToUtcMs(parseDayOrThrow(to)) - dayToUtcMs(parseDayOrThrow(from));
  return Math.round(span / MS_PER_DAY) + 1;
}

export function enumerateDays(from: string, to: string): string[] {
  const count = daysInclusive(from, to);
  return count <= 0 ? [] : Array.from({ length: count }, (_, index) => addDays(from, index));
}
