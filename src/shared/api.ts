import type { TokenTypeKey } from './models.js';

export type { TokenTypeKey };

/** Local calendar day in the server time zone: 'YYYY-MM-DD'. */
export type Day = string;
export type Bucket = 'day' | 'hour';
export type Stack = 'model' | 'type' | 'project';
export type SessionSort = 'cost' | 'recent';
export type PricingSource = 'litellm' | 'snapshot' | 'none';

export interface TokenBreakdown {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
}

export interface CostBreakdown {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /** $0.01 per web search request. */
  readonly webSearch: number;
  /** Token costs plus webSearch. */
  readonly total: number;
}

export interface SourceStatus {
  readonly path: string;
  readonly ok: boolean;
  readonly files: number;
  readonly bytes: number;
  readonly error: string | null;
}

export interface SyncStatus {
  readonly state: 'idle' | 'scanning';
  readonly lastSyncAt: string | null;
  /** End of the last cycle that read at least one transcript file; the dashboard refetches when it moves. */
  readonly lastChangeAt: string | null;
  readonly lastDurationMs: number | null;
  /** Lines that could not be used: invalid JSON or record, a timestamp outside the accepted window, or a line over 64 MiB. */
  readonly skippedLines: number;
  /** usage.iterations[] entries that failed validation; the rest of their line was kept. */
  readonly droppedIterations: number;
  /** Lines with advisor iterations whose top-level usage differs from the sum of their message iterations. */
  readonly usageMismatches: number;
}

export interface BackfillStatus {
  readonly active: boolean;
  readonly filesDone: number;
  readonly filesTotal: number;
  readonly bytesDone: number;
  readonly bytesTotal: number;
}

export interface PricingStatus {
  readonly source: PricingSource;
  readonly fetchedAt: string | null;
  readonly unpricedModels: readonly string[];
}

export interface StatusResponse {
  readonly now: string;
  readonly today: Day;
  readonly tz: string;
  readonly sync: SyncStatus;
  readonly backfill: BackfillStatus;
  readonly sources: readonly SourceStatus[];
  readonly pricing: PricingStatus;
  readonly data: { readonly firstDay: Day | null; readonly lastDay: Day | null; readonly rows: number };
}

export interface ModelOption {
  readonly id: string;
  readonly label: string;
  readonly color: string;
  readonly priced: boolean;
}

export interface ProjectOption {
  readonly id: string;
  readonly path: string;
  readonly label: string;
}

export interface FiltersResponse {
  readonly models: readonly ModelOption[];
  readonly projects: readonly ProjectOption[];
  readonly bounds: { readonly firstDay: Day | null; readonly lastDay: Day | null };
}

export interface SeriesKey {
  readonly key: string;
  readonly label: string;
  readonly color: string;
}

export interface OverviewSeries {
  readonly stack: Stack;
  /**
   * Local labels: 'YYYY-MM-DD' (day) or 'YYYY-MM-DDTHH:00' (hour). When a local hour repeats (the DST fall-back),
   * both of its buckets carry their UTC offset: 'YYYY-MM-DDTHH:00+03:00' and 'YYYY-MM-DDTHH:00+02:00'.
   */
  readonly buckets: readonly string[];
  readonly keys: readonly SeriesKey[];
  /** [keyIndex][bucketIndex] */
  readonly cost: readonly (readonly number[])[];
  readonly tokens: readonly (readonly number[])[];
}

export interface OverviewTotals {
  readonly cost: CostBreakdown;
  readonly tokens: TokenBreakdown;
  readonly tokensTotal: number;
  readonly avgCostPerDay: number;
  /** `bucket` is a label from `series.buckets`, so on a repeated DST hour it ends with a '±HH:MM' UTC offset. */
  readonly peak: { readonly bucket: string; readonly cost: number } | null;
  /** null when the previous period is not fully covered by data. */
  readonly prevPeriodCost: number | null;
  readonly sessions: number;
  readonly projects: number;
  readonly subagentCost: number;
  readonly advisorCost: number;
  /** Web search requests in range; each adds $0.01 to the cost (CostBreakdown.webSearch). */
  readonly webSearchRequests: number;
  /** Web fetch requests in range; stored without a fee. */
  readonly webFetchRequests: number;
}

export interface ModelBreakdown {
  readonly model: string;
  readonly label: string;
  readonly color: string;
  readonly priced: boolean;
  readonly tokens: TokenBreakdown;
  readonly tokensTotal: number;
  /** Token costs plus the web search fee. */
  readonly cost: number;
  readonly share: number;
  /** Token cost per million tokens, without the web search fee; null for an unpriced model. */
  readonly costPerMTok: number | null;
}

export interface ProjectBreakdown {
  readonly id: string;
  readonly path: string;
  readonly label: string;
  readonly tokensTotal: number;
  readonly cost: number;
  readonly sessions: number;
}

export interface OverviewResponse {
  readonly range: { readonly from: Day; readonly to: Day; readonly days: number; readonly bucket: Bucket };
  readonly totals: OverviewTotals;
  readonly series: OverviewSeries;
  /** Sorted by cost, descending. */
  readonly byModel: readonly ModelBreakdown[];
  /** All projects in range, sorted by cost descending; the UI shows the top 8. */
  readonly byProject: readonly ProjectBreakdown[];
}

export interface SessionSummary {
  readonly id: string;
  readonly title: string | null;
  readonly projectId: string | null;
  readonly projectLabel: string | null;
  readonly firstTs: string;
  readonly lastTs: string;
  /** Model ids ordered by cost within the session, descending. */
  readonly models: readonly string[];
  readonly tokensTotal: number;
  readonly cost: number;
  readonly subagentCost: number;
}

export interface SessionsResponse {
  readonly total: number;
  readonly sessions: readonly SessionSummary[];
}

export interface HealthResponse {
  readonly ok: boolean;
  readonly lastSyncAgeSec: number | null;
}

export interface ApiError {
  readonly error: string;
  readonly details?: unknown;
}
