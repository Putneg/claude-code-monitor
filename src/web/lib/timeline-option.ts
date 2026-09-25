import type { LineSeriesOption } from 'echarts/charts';
import type {
  BrushComponentOption,
  GridComponentOption,
  MarkPointComponentOption,
  ToolboxComponentOption,
  TooltipComponentOption,
} from 'echarts/components';
import type { ComposeOption } from 'echarts/core';
import type { OverviewSeries } from '../../shared/api.js';
import { axisBucketLabel, bucketLabel, escapeHtml, formatTokens, formatUsd, formatUsdAxis, plural } from './format.js';
import { bucketTotals, cumulativeOf, peakOf, unitValues, type Peak } from './series.js';
import type { Unit } from './view-state.js';

export type TimelineOption = ComposeOption<
  LineSeriesOption | GridComponentOption | TooltipComponentOption | BrushComponentOption | MarkPointComponentOption | ToolboxComponentOption
>;

/** Mirrors the CSS tokens in app.css; ECharts draws on a canvas and cannot read CSS variables. */
export const CHART_THEME = {
  bg: '#0D0E0B',
  raised: '#171812',
  line: '#2A2B22',
  fg: '#D8D4C7',
  dim: '#8B877A',
  accent: '#FFB000',
  font: "'IBM Plex Sans', system-ui, sans-serif",
} as const;

export const CUMULATIVE_NAME = 'cumulative';
export const AREA_OPACITY = 0.13;
export const GLOW_BLUR = 8;
const SAFE_COLOR = /^#[0-9a-f]{3,8}$/i;
const AXIS_LABEL = { color: CHART_THEME.dim, fontFamily: CHART_THEME.font, fontSize: 10 } as const;

export interface TimelineSettings {
  readonly unit: Unit;
  readonly cumulative: boolean;
}

export interface TooltipParam {
  readonly seriesName: string;
  readonly value: number;
  readonly color: string;
  readonly axisValue: string;
}

const valueFormatter = (unit: Unit): ((value: number) => string) => (unit === 'usd' ? formatUsd : formatTokens);
const axisFormatter = (unit: Unit): ((value: number) => string) => (unit === 'usd' ? formatUsdAxis : formatTokens);
const safeColor = (color: string): string => (SAFE_COLOR.test(color) ? color : 'inherit');

/** Normalizes what ECharts passes to an axis tooltip formatter: one object or an array of them. */
export function toTooltipParams(raw: unknown): TooltipParam[] {
  const list: unknown[] = Array.isArray(raw) ? raw : [raw];
  return list.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const record = item as Record<string, unknown>;
    const value = Number(record.value);
    return [
      {
        seriesName: String(record.seriesName ?? ''),
        value: Number.isFinite(value) ? value : 0,
        color: typeof record.color === 'string' ? record.color : '',
        axisValue: String(record.axisValue ?? ''),
      },
    ];
  });
}

/** Tooltip body. Every label is escaped: project labels come from directory names. */
export function tooltipHtml(params: readonly TooltipParam[], unit: Unit): string {
  const first = params[0];
  if (first === undefined) return '';
  const format = valueFormatter(unit);
  const stacked = params.filter((param) => param.seriesName !== CUMULATIVE_NAME);
  const cumulative = params.find((param) => param.seriesName === CUMULATIVE_NAME);
  const total = stacked.reduce((sum, param) => sum + param.value, 0);
  const rows = stacked
    .filter((param) => param.value > 0)
    .sort((a, b) => b.value - a.value)
    .map(
      (param) =>
        `<div class="tt-row"><span style="color:${safeColor(param.color)}">${escapeHtml(param.seriesName)}</span>` +
        `<span>${escapeHtml(format(param.value))}</span></div>`,
    );
  const head = `<div class="tt-head"><span>${escapeHtml(bucketLabel(first.axisValue))}</span><span>${escapeHtml(format(total))}</span></div>`;
  const tail = cumulative
    ? `<div class="tt-row tt-cum"><span>${CUMULATIVE_NAME}</span><span>${escapeHtml(format(cumulative.value))}</span></div>`
    : '';
  return head + rows.join('') + tail;
}

/**
 * Text alternative for the chart canvas (its aria-label): range, bucket count, total and peak in the unit, e.g.
 * 'usage over time, 03-01 to 03-14, 14 day buckets, total $12.34, peak 03-05 $4.56'. Token amounts carry the word,
 * so a screen reader never announces a bare number: 'total 1.8M tokens, peak 03-05 620k tokens'.
 */
export function timelineSummary(series: OverviewSeries, unit: Unit): string {
  const first = series.buckets[0];
  const last = series.buckets.at(-1);
  if (first === undefined || last === undefined) return 'usage over time, no buckets';
  const format = valueFormatter(unit);
  const amount = (value: number): string => (unit === 'usd' ? format(value) : `${format(value)} tokens`);
  const total = bucketTotals(series, unit).reduce((sum, value) => sum + value, 0);
  const peak = peakOf(series, unit);
  const count = plural(series.buckets.length, `${first.length > 10 ? 'hour' : 'day'} bucket`);
  const peakText = peak === null ? 'peak n/a' : `peak ${bucketLabel(peak.bucket)} ${amount(peak.value)}`;
  return `usage over time, ${bucketLabel(first)} to ${bucketLabel(last)}, ${count}, total ${amount(total)}, ${peakText}`;
}

/** Category indices [start, end] from a brushEnd event, or null when nothing usable was selected. */
export function brushIndices(event: unknown): readonly [number, number] | null {
  const areas = typeof event === 'object' && event !== null ? (event as { areas?: unknown }).areas : undefined;
  const first: unknown = Array.isArray(areas) ? areas[0] : undefined;
  const range = typeof first === 'object' && first !== null ? (first as { coordRange?: unknown }).coordRange : undefined;
  if (!Array.isArray(range)) return null;
  const [start, end]: unknown[] = range;
  if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end)) return null;
  return [Math.min(start, end), Math.max(start, end)];
}

/** A peak at or past this share of the buckets gets its label on the left, so the label stays inside the chart. */
const PEAK_LABEL_FLIP_SHARE = 0.75;

function peakMarker(peak: Peak, unit: Unit, bucketCount: number, z: number): MarkPointComponentOption {
  return {
    // A marker's z is absolute (it does not follow its series), so the caller passes one above every stacked line.
    z,
    symbol: 'circle',
    symbolSize: 7,
    silent: true,
    itemStyle: { color: CHART_THEME.bg, borderColor: CHART_THEME.accent, borderWidth: 1.5 },
    label: {
      show: true,
      position: peak.index >= bucketCount * PEAK_LABEL_FLIP_SHARE ? 'left' : 'right',
      distance: 6,
      color: CHART_THEME.accent,
      // Opaque, so a dashed gridline never runs through the text.
      backgroundColor: CHART_THEME.bg,
      padding: [1, 4],
      fontFamily: CHART_THEME.font,
      fontSize: 10.5,
      formatter: `peak ${valueFormatter(unit)(peak.value)}`,
    },
    data: [{ name: 'peak', coord: [peak.bucket, peak.value], value: peak.value }],
  };
}

/**
 * Where the series above are zero, their lines lie on the top edge of the stack. Lower series get the higher z, so
 * the visible edge belongs to the highest non-zero series; the cumulative line (z 1) stays below them all.
 */
const stackZ = (index: number, top: number): number => 2 + (top - index);

/** The category after the last bucket on the hidden edge axis: the right edge of the last band. */
export const EDGE_END = 'end';

/**
 * The stacked areas. A step line through band centers on the visible axis would leave the left half of the first
 * band and the right half of the last one empty, so they are drawn on a hidden axis whose N + 1 categories are the
 * edges of the N bands (boundaryGap false): with step 'end' and the last value repeated, every bucket fills its band.
 */
function drawnSeries(series: OverviewSeries, unit: Unit): LineSeriesOption[] {
  const values = unitValues(series, unit);
  const top = series.keys.length - 1;
  return series.keys.map((key, index) => {
    const data = values[index] ?? [];
    return {
      id: `key:${key.key}`,
      name: key.label,
      type: 'line',
      xAxisIndex: 1,
      step: 'end',
      stack: 'total',
      symbol: 'none',
      silent: true,
      z: stackZ(index, top),
      data: [...data, data.at(-1) ?? 0],
      itemStyle: { color: key.color },
      lineStyle: { width: 1.5, color: key.color, shadowBlur: GLOW_BLUR, shadowColor: key.color },
      areaStyle: { color: key.color, opacity: AREA_OPACITY },
      emphasis: { disabled: true },
    };
  });
}

/**
 * Invisible lines with each key's own values on the visible axis: the axis tooltip reads them (the edge axis does not
 * trigger it), and the top one carries the peak marker at the center of its band.
 */
function valueSeries(series: OverviewSeries, unit: Unit): LineSeriesOption[] {
  const values = unitValues(series, unit);
  const peak = peakOf(series, unit);
  const top = series.keys.length - 1;
  return series.keys.map((key, index) => ({
    id: `value:${key.key}`,
    name: key.label,
    type: 'line',
    symbol: 'none',
    data: [...(values[index] ?? [])],
    itemStyle: { color: key.color },
    lineStyle: { opacity: 0 },
    emphasis: { disabled: true },
    ...(index === top && peak !== null ? { markPoint: peakMarker(peak, unit, series.buckets.length, stackZ(0, top) + 1) } : {}),
  }));
}

function cumulativeSeries(series: OverviewSeries, unit: Unit): LineSeriesOption {
  return {
    id: CUMULATIVE_NAME,
    name: CUMULATIVE_NAME,
    type: 'line',
    yAxisIndex: 1,
    symbol: 'none',
    z: 1,
    data: cumulativeOf(bucketTotals(series, unit)),
    itemStyle: { color: CHART_THEME.fg },
    lineStyle: { width: 1, type: 'dashed', color: CHART_THEME.fg, opacity: 0.7 },
    emphasis: { disabled: true },
  };
}

function tooltipOption(unit: Unit): TooltipComponentOption {
  return {
    trigger: 'axis',
    confine: true,
    // ECharts glides the HTML tooltip with a CSS transition by default; without it the page has no motion at all.
    transitionDuration: 0,
    backgroundColor: CHART_THEME.raised,
    borderColor: CHART_THEME.line,
    borderWidth: 1,
    padding: [6, 10],
    textStyle: { color: CHART_THEME.fg, fontFamily: CHART_THEME.font, fontSize: 11 },
    axisPointer: { type: 'line', lineStyle: { color: CHART_THEME.dim, type: 'dotted' } },
    formatter: (params: unknown) => tooltipHtml(toTooltipParams(params), unit),
  };
}

const BRUSH_OPTION: BrushComponentOption = {
  xAxisIndex: 0,
  brushType: 'lineX',
  brushMode: 'single',
  transformable: false,
  throttleType: 'debounce',
  throttleDelay: 100,
  toolbox: [],
  brushStyle: { color: 'rgba(255, 176, 0, 0.08)', borderColor: 'rgba(255, 176, 0, 0.5)', borderWidth: 1 },
};

/** Stepped stacked areas + optional cumulative line + peak marker + lineX brush. */
export function buildTimelineOption(series: OverviewSeries, settings: TimelineSettings): TimelineOption {
  const { unit, cumulative } = settings;
  const multiDay = (series.buckets[0] ?? '').slice(0, 10) !== (series.buckets.at(-1) ?? '').slice(0, 10);
  const valueAxisLabel = { ...AXIS_LABEL, formatter: (value: number) => axisFormatter(unit)(value) };
  return {
    animation: false,
    backgroundColor: 'transparent',
    textStyle: { fontFamily: CHART_THEME.font, color: CHART_THEME.dim },
    grid: { left: 56, right: cumulative ? 60 : 20, top: 18, bottom: 26 },
    tooltip: tooltipOption(unit),
    brush: BRUSH_OPTION,
    // The brush preprocessor always injects a toolbox with brush buttons; keep it hidden.
    toolbox: { show: false },
    xAxis: [
      {
        type: 'category',
        data: [...series.buckets],
        boundaryGap: true,
        axisLine: { lineStyle: { color: CHART_THEME.line } },
        axisTick: { show: false },
        axisLabel: { ...AXIS_LABEL, hideOverlap: true, formatter: (value: string) => axisBucketLabel(value, multiDay) },
      },
      // The band edges, for the stacked areas only (see drawnSeries): no labels, no pointer, no tooltip.
      {
        type: 'category',
        data: [...series.buckets, EDGE_END],
        boundaryGap: false,
        show: false,
        axisPointer: { show: false, triggerTooltip: false },
      },
    ],
    yAxis: [
      { type: 'value', axisLabel: valueAxisLabel, splitLine: { lineStyle: { color: CHART_THEME.line, type: 'dashed' } } },
      { type: 'value', show: cumulative, position: 'right', splitLine: { show: false }, axisLabel: valueAxisLabel },
    ],
    series: [...drawnSeries(series, unit), ...valueSeries(series, unit), ...(cumulative ? [cumulativeSeries(series, unit)] : [])],
  };
}
