import type { OverviewResponse, SourceStatus, StatusResponse } from '../../shared/api.js';
import { formatBytes, formatClock, formatStamp, plural } from './format.js';

/** done/total as a share of 0-1; 0 without a total. */
export function progressShare(done: number, total: number): number {
  return total > 0 ? Math.min(Math.max(done / total, 0), 1) : 0;
}

export interface BackfillProgress {
  /** Files done out of files found, e.g. '312/754'. */
  readonly files: string;
  /** For the decorative bar, hidden from screen readers. */
  readonly share: number;
}

export interface StatusIndicator {
  readonly kind: 'connecting' | 'live' | 'backfill' | 'offline';
  /** The state word, the only text the status live region holds. */
  readonly text: string;
  /** Shown after the state word but outside the live region, so a poll that moves it announces nothing. */
  readonly progress: BackfillProgress | null;
}

export interface StatusView {
  readonly sources: string;
  readonly files: string;
  readonly prices: string;
  readonly tz: string;
  readonly sync: string;
  readonly indicator: StatusIndicator;
  readonly warnings: readonly string[];
}

const OFFLINE: StatusIndicator = { kind: 'offline', text: 'offline', progress: null };

function indicator(status: StatusResponse, apiDown: boolean): StatusIndicator {
  if (apiDown) return OFFLINE;
  const { active, filesDone, filesTotal } = status.backfill;
  if (active) {
    return {
      kind: 'backfill',
      text: 'backfill',
      progress: { files: `${filesDone}/${filesTotal}`, share: progressShare(filesDone, filesTotal) },
    };
  }
  return { kind: 'live', text: 'live', progress: null };
}

/** The indicator before the first status response: connecting, or offline once a poll has failed. */
export function pendingIndicator(apiDown: boolean): StatusIndicator {
  return apiDown ? OFFLINE : { kind: 'connecting', text: 'connecting…', progress: null };
}

/** Sources worth listing: every required one, and optional ones that exist. */
export function visibleSources(sources: readonly SourceStatus[]): SourceStatus[] {
  return sources.filter((source) => source.required || source.present);
}

const requiredSourceMissing = (status: StatusResponse): boolean => status.sources.some((source) => source.required && !source.ok);

const optionalSourceBroken = (status: StatusResponse): boolean =>
  status.sources.some((source) => !source.required && source.present && !source.ok);

function warnings(status: StatusResponse): string[] {
  const unpriced = status.pricing.unpricedModels.length;
  const { skippedLines, droppedIterations, usageMismatches } = status.sync;
  return [
    ...(requiredSourceMissing(status) ? ['⚠ source missing'] : []),
    ...(optionalSourceBroken(status) ? ['⚠ codex source unreadable'] : []),
    ...(unpriced > 0 ? [`⚠ ${plural(unpriced, 'model')} unpriced`] : []),
    ...(skippedLines > 0 ? [`⚠ ${plural(skippedLines, 'line')} skipped`] : []),
    ...(droppedIterations > 0 ? [`⚠ ${plural(droppedIterations, 'iteration')} dropped`] : []),
    ...(usageMismatches > 0 ? [`⚠ advisor usage check failed (${usageMismatches})`] : []),
  ];
}

/** Text for the tmux-style status bar: sources, files, prices, time zone, last sync, indicator and warnings. */
export function statusView(status: StatusResponse, apiDown: boolean): StatusView {
  const shown = visibleSources(status.sources);
  const files = status.sources.reduce((sum, source) => sum + source.files, 0);
  const bytes = status.sources.reduce((sum, source) => sum + source.bytes, 0);
  const { source, fetchedAt } = status.pricing;
  return {
    sources: shown.length > 0 ? shown.map((item) => item.path).join(', ') : 'no sources',
    files: `${plural(files, 'file')} · ${formatBytes(bytes)}`,
    prices: fetchedAt === null ? `prices: ${source}` : `prices: ${source} · ${formatStamp(fetchedAt, status.tz)}`,
    tz: `tz ${status.tz}`,
    sync: status.sync.lastSyncAt === null ? 'sync pending' : `sync ${formatClock(status.sync.lastSyncAt, status.tz)}`,
    indicator: indicator(status, apiDown),
    warnings: warnings(status),
  };
}

export type EmptyKind = 'source-missing' | 'backfill' | 'no-data' | 'no-usage';

/** Which empty state replaces the dashboard, or null when there is something to show. */
export function emptyStateKind(status: StatusResponse, overview: OverviewResponse | null): EmptyKind | null {
  if (status.data.rows === 0) {
    if (requiredSourceMissing(status)) return 'source-missing';
    if (status.backfill.active || status.sync.lastSyncAt === null) return 'backfill';
    return 'no-data';
  }
  if (overview === null || overview.totals.tokensTotal > 0) return null;
  // Mid-backfill the loaded range can still be empty: keep saying "backfill", not "no usage in range".
  return status.backfill.active ? 'backfill' : 'no-usage';
}
