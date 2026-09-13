import type { LineSeriesOption } from 'echarts/charts';
import { describe, expect, it } from 'vitest';
import type { OverviewSeries } from '../../../src/shared/api.js';
import {
  AREA_OPACITY,
  brushIndices,
  buildTimelineOption,
  CHART_THEME,
  CUMULATIVE_NAME,
  GLOW_BLUR,
  timelineSummary,
  toTooltipParams,
  tooltipHtml,
  type TimelineOption,
} from '../../../src/web/lib/timeline-option.js';
import { SERIES } from './fixtures.js';

type LabelAxis<T> = { axisLabel: { formatter: (value: T) => string } };

const seriesOf = (option: TimelineOption): LineSeriesOption[] => option.series as LineSeriesOption[];
const xFormatter = (option: TimelineOption) => (option.xAxis as LabelAxis<string>).axisLabel.formatter;

/** One model over `count` day buckets, with the largest value at `peakIndex`. */
function seriesPeakingAt(peakIndex: number, count: number): OverviewSeries {
  const values = Array.from({ length: count }, (_, index) => (index === peakIndex ? 9 : 1));
  return {
    stack: 'model',
    buckets: Array.from({ length: count }, (_, index) => `2026-03-${String(index + 1).padStart(2, '0')}`),
    keys: [{ key: 'claude-opus-5', label: 'opus-5', color: '#FFB000' }],
    cost: [values],
    tokens: [values],
  };
}

const peakLabel = (series: OverviewSeries) =>
  seriesOf(buildTimelineOption(series, { unit: 'usd', cumulative: false })).at(-1)?.markPoint?.label;

describe('buildTimelineOption', () => {
  it('stacks one stepped, glowing area per key', () => {
    const [opus, sonnet] = seriesOf(buildTimelineOption(SERIES, { unit: 'usd', cumulative: false }));
    expect(opus).toMatchObject({
      name: 'opus-5',
      type: 'line',
      step: 'middle',
      stack: 'total',
      data: [1, 4, 0],
      areaStyle: { color: '#FFB000', opacity: AREA_OPACITY },
      lineStyle: { shadowBlur: GLOW_BLUR, shadowColor: '#FFB000' },
    });
    expect(sonnet).toMatchObject({ name: 'sonnet-5', data: [2, 1, 0] });
  });

  it('plots tokens in token mode', () => {
    const [opus] = seriesOf(buildTimelineOption(SERIES, { unit: 'tok', cumulative: false }));
    expect(opus?.data).toEqual([100, 400, 0]);
  });

  it('adds a dashed cumulative line on the right axis only when enabled', () => {
    const lines = seriesOf(buildTimelineOption(SERIES, { unit: 'usd', cumulative: true }));
    expect(lines.at(-1)).toMatchObject({ name: CUMULATIVE_NAME, yAxisIndex: 1, data: [3, 8, 8], lineStyle: { type: 'dashed' } });
    expect(seriesOf(buildTimelineOption(SERIES, { unit: 'usd', cumulative: false }))).toHaveLength(2);
  });

  it('marks the peak on the top series', () => {
    const [opus, sonnet] = seriesOf(buildTimelineOption(SERIES, { unit: 'usd', cumulative: false }));
    expect(opus?.markPoint).toBeUndefined();
    expect(sonnet?.markPoint).toMatchObject({
      data: [{ coord: ['2026-03-02', 5], value: 5 }],
      label: { formatter: 'peak $5.00' },
    });
  });

  it('puts the peak label on the left when the peak is the last bucket', () => {
    expect(peakLabel(seriesPeakingAt(7, 8))).toMatchObject({ position: 'left' });
  });

  it('keeps the peak label on the right for a peak in the first half', () => {
    expect(peakLabel(seriesPeakingAt(1, 8))).toMatchObject({ position: 'right' });
    expect(peakLabel(SERIES)).toMatchObject({ position: 'right' });
  });

  it('paints the peak label on the chart background, so a gridline cannot cross it', () => {
    expect(peakLabel(SERIES)).toMatchObject({ backgroundColor: CHART_THEME.bg, padding: [1, 4] });
  });

  it('arms lineX brushing on the category axis and formats both axes', () => {
    const option = buildTimelineOption(SERIES, { unit: 'usd', cumulative: true });
    expect(option.brush).toMatchObject({ xAxisIndex: 0, brushType: 'lineX', brushMode: 'single' });
    expect(option.toolbox).toEqual({ show: false });
    expect(option.xAxis).toMatchObject({ type: 'category', data: SERIES.buckets, boundaryGap: true });
    expect(xFormatter(option)('2026-03-02')).toBe('03-02');
    const [left] = option.yAxis as LabelAxis<number>[];
    expect(left?.axisLabel.formatter(1_500)).toBe('$1.5k');
  });

  it('labels hour buckets with the time of day on a single-day range', () => {
    const hourly = { ...SERIES, buckets: ['2026-03-01T10:00', '2026-03-01T11:00', '2026-03-01T12:00'] };
    expect(xFormatter(buildTimelineOption(hourly, { unit: 'usd', cumulative: false }))('2026-03-01T11:00')).toBe('11:00');
  });

  it('draws each stacked series over the ones stacked above it, and the cumulative line below them all', () => {
    const three: OverviewSeries = {
      ...SERIES,
      keys: [...SERIES.keys, { key: 'claude-haiku-4-5', label: 'haiku-4.5', color: '#C792EA' }],
      cost: [...SERIES.cost, [0, 0, 0]],
      tokens: [...SERIES.tokens, [0, 0, 0]],
    };
    expect(seriesOf(buildTimelineOption(three, { unit: 'usd', cumulative: true })).map((line) => line.z)).toEqual([4, 3, 2, 1]);
  });

  it('keeps the peak marker above every stacked line', () => {
    const keys = Array.from({ length: 9 }, (_, index) => ({ key: `k${index}`, label: `p${index}`, color: '#FFB000' }));
    const values = keys.map((_, index) => [index + 1, 1]);
    const many: OverviewSeries = { stack: 'project', buckets: ['2026-03-01', '2026-03-02'], keys, cost: values, tokens: values };
    const lines = seriesOf(buildTimelineOption(many, { unit: 'usd', cumulative: false }));
    expect(lines.map((line) => line.z)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2]);
    expect(lines.at(-1)?.markPoint?.z).toBe(11);
  });

  it('moves the tooltip without a CSS transition', () => {
    expect(buildTimelineOption(SERIES, { unit: 'usd', cumulative: false }).tooltip).toMatchObject({ transitionDuration: 0 });
  });
});

describe('tooltipHtml', () => {
  it('lists non-zero series by value, with the bucket total and the running total', () => {
    const params = toTooltipParams([
      { seriesName: 'opus-5', value: 1, color: '#FFB000', axisValue: '2026-03-02' },
      { seriesName: 'sonnet-5', value: 4, color: '#8BD450', axisValue: '2026-03-02' },
      { seriesName: 'haiku-4.5', value: 0, color: '#C792EA', axisValue: '2026-03-02' },
      { seriesName: CUMULATIVE_NAME, value: 8, color: '#D8D4C7', axisValue: '2026-03-02' },
    ]);
    expect(tooltipHtml(params, 'usd')).toBe(
      '<div class="tt-head"><span>03-02</span><span>$5.00</span></div>' +
        '<div class="tt-row"><span style="color:#8BD450">sonnet-5</span><span>$4.00</span></div>' +
        '<div class="tt-row"><span style="color:#FFB000">opus-5</span><span>$1.00</span></div>' +
        '<div class="tt-row tt-cum"><span>cumulative</span><span>$8.00</span></div>',
    );
  });

  it('escapes labels and drops unsafe colors', () => {
    const html = tooltipHtml(
      toTooltipParams({ seriesName: '<img src=x onerror=alert(1)>', value: 2, color: 'red;background:url(x)', axisValue: '2026-03-02' }),
      'tok',
    );
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('style="color:inherit"');
    expect(html).not.toContain('<img');
  });

  it('returns an empty string without params and skips junk entries', () => {
    expect(tooltipHtml(toTooltipParams([]), 'usd')).toBe('');
    expect(toTooltipParams([null, 3, { seriesName: 'a', value: 'x' }])).toEqual([{ seriesName: 'a', value: 0, color: '', axisValue: '' }]);
  });
});

describe('brushIndices', () => {
  it('reads and orders the first brushed area', () => {
    expect(brushIndices({ areas: [{ coordRange: [7.2, 2.6] }] })).toEqual([2.6, 7.2]);
  });

  it('returns null for anything else', () => {
    expect(brushIndices({ areas: [] })).toBeNull();
    expect(brushIndices({ areas: [{ coordRange: ['a', 1] }] })).toBeNull();
    expect(brushIndices({ areas: [null] })).toBeNull();
    expect(brushIndices(null)).toBeNull();
  });
});

describe('timelineSummary', () => {
  it('describes the range, bucket count, total and peak in the unit', () => {
    expect(timelineSummary(SERIES, 'usd')).toBe('usage over time, 03-01 to 03-03, 3 day buckets, total $8.00, peak 03-02 $5.00');
    expect(timelineSummary(SERIES, 'tok')).toBe('usage over time, 03-01 to 03-03, 3 day buckets, total 1k tokens, peak 03-02 1k tokens');
  });

  it('says hour buckets and shows the offset of a repeated hour', () => {
    const hourly = { ...SERIES, buckets: ['2026-10-25T02:00', '2026-10-25T03:00+03:00', '2026-10-25T03:00+02:00'] };
    expect(timelineSummary(hourly, 'usd')).toBe(
      'usage over time, 10-25 02:00 to 10-25 03:00 (UTC+02:00), 3 hour buckets, total $8.00, peak 10-25 03:00 (UTC+03:00) $5.00',
    );
  });

  it('reports no peak when the range has no usage', () => {
    const flat = {
      ...SERIES,
      cost: [
        [0, 0, 0],
        [0, 0, 0],
      ],
      tokens: [
        [0, 0, 0],
        [0, 0, 0],
      ],
    };
    expect(timelineSummary(flat, 'usd')).toBe('usage over time, 03-01 to 03-03, 3 day buckets, total $0, peak n/a');
  });

  it('copes with a series without buckets', () => {
    expect(timelineSummary({ ...SERIES, buckets: [], cost: [[], []], tokens: [[], []] }, 'tok')).toBe('usage over time, no buckets');
  });
});
