import type { CodexLimit, CodexLimitWindow } from '../../shared/api.js';
import { formatStamp, formatTimeOfDay, zonedDay } from './format.js';
import { progressBar } from './status-view.js';

/** Character cells of a window's usage bar. */
export const LIMIT_CELLS = 10;
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 1_440;
const MINUTES_PER_WEEK = 10_080;
const STALE_TEXT = 'reset · no newer data';

export interface LimitWindowView {
  readonly key: string;
  readonly label: string;
  /** Decorative; the percentage carries the value. */
  readonly bar: string;
  readonly percent: string;
  readonly resets: string;
  /** The window has reset since the reading, so its usage is unknown. */
  readonly stale: boolean;
}

export interface LimitView {
  readonly id: string;
  readonly title: string;
  readonly asOf: string;
  readonly windows: readonly LimitWindowView[];
  readonly credits: string | null;
}

/** 300 -> 5h, 10080 -> weekly, 4320 -> 3d, 90 -> 90m. */
export function windowLabel(minutes: number): string {
  if (minutes === MINUTES_PER_WEEK) return 'weekly';
  if (minutes % MINUTES_PER_DAY === 0) return `${minutes / MINUTES_PER_DAY}d`;
  if (minutes % MINUTES_PER_HOUR === 0) return `${minutes / MINUTES_PER_HOUR}h`;
  return `${minutes}m`;
}

/** 'HH:MM' on the same local day as now, otherwise 'MM-DD HH:MM'. */
function moment(iso: string, nowIso: string, timeZone: string): string {
  return zonedDay(iso, timeZone) === zonedDay(nowIso, timeZone) ? formatTimeOfDay(iso, timeZone) : formatStamp(iso, timeZone);
}

function windowView(window: CodexLimitWindow, nowIso: string, timeZone: string): LimitWindowView {
  const label = windowLabel(window.windowMinutes);
  if (window.resetsAt !== null && Date.parse(window.resetsAt) <= Date.parse(nowIso)) {
    return { key: window.slot, label, bar: progressBar(0, 100, LIMIT_CELLS), percent: '', resets: STALE_TEXT, stale: true };
  }
  return {
    key: window.slot,
    label,
    bar: progressBar(window.usedPercent, 100, LIMIT_CELLS),
    percent: `${Math.round(window.usedPercent)}%`,
    resets: window.resetsAt === null ? '' : `resets ${moment(window.resetsAt, nowIso, timeZone)}`,
    stale: false,
  };
}

function creditsText(limit: CodexLimit): string | null {
  if (limit.credits === null) return null;
  if (limit.credits.unlimited) return 'credits unlimited';
  return limit.credits.hasCredits ? `credits ${limit.credits.balance ?? '?'}` : null;
}

function titleOf(limit: CodexLimit): string {
  const parts = ['codex limits', limit.limitId === 'codex' ? null : limit.limitId, limit.planType];
  return parts.filter((part): part is string => part !== null && part.length > 0).join(' · ');
}

/** The Codex limits widget, one block per limit id; times in the server's zone. */
export function limitViews(limits: readonly CodexLimit[], nowIso: string, timeZone: string): LimitView[] {
  return limits.map((limit) => ({
    id: limit.limitId,
    title: titleOf(limit),
    asOf: `as of ${moment(limit.observedAt, nowIso, timeZone)}`,
    windows: limit.windows.map((window) => windowView(window, nowIso, timeZone)),
    credits: creditsText(limit),
  }));
}
