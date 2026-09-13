<script lang="ts">
  import { onMount } from 'svelte';
  import { LineChart } from 'echarts/charts';
  import { BrushComponent, GridComponent, MarkPointComponent, ToolboxComponent, TooltipComponent } from 'echarts/components';
  import { init, use, type EChartsType } from 'echarts/core';
  import { CanvasRenderer } from 'echarts/renderers';
  import type { Bucket, OverviewSeries, Stack } from '../../shared/api';
  import { brushRange, type DayRange } from '../lib/range';
  import { brushIndices, buildTimelineOption, timelineSummary } from '../lib/timeline-option';
  import { STACKS, type Unit } from '../lib/view-state';

  // The brush preprocessor injects a toolbox, so ToolboxComponent must be registered; the option hides it.
  use([LineChart, GridComponent, TooltipComponent, BrushComponent, MarkPointComponent, ToolboxComponent, CanvasRenderer]);

  /** Arms lineX brushing with the toolbox hidden; it must be re-sent after every setOption with notMerge. */
  const BRUSH_CURSOR = { type: 'takeGlobalCursor', key: 'brush', brushOption: { brushType: 'lineX', brushMode: 'single' } };

  interface Props {
    series: OverviewSeries;
    bucket: Bucket;
    stack: Stack;
    unit: Unit;
    cumulative: boolean;
    dayAllowed: boolean;
    hourAllowed: boolean;
    onStack: (stack: Stack) => void;
    onBucket: (bucket: Bucket) => void;
    onCumulative: (value: boolean) => void;
    onBrush: (range: DayRange) => void;
    onPointer: (inside: boolean) => void;
  }

  let { series, bucket, stack, unit, cumulative, dayAllowed, hourAllowed, onStack, onBucket, onCumulative, onBrush, onPointer }: Props =
    $props();

  let container: HTMLDivElement;
  let chart = $state.raw<EChartsType | null>(null);
  const chartOption = $derived(buildTimelineOption(series, { unit, cumulative }));
  const summary = $derived(timelineSummary(series, unit));

  const DAY_REASON = 'day buckets need a range of 2 days or more';
  const HOUR_REASON = 'hour buckets need a range of 7 days or less';
  // Prefix for the ids of the visually hidden reasons that a disallowed bucket button points to.
  const uid = $props.id();

  /** A disallowed bucket button stays focusable (aria-disabled) so its reason can be read; a click on it does nothing. */
  function pickBucket(choice: Bucket, allowed: boolean): void {
    if (allowed) onBucket(choice);
  }

  onMount(() => {
    const instance = init(container, null, { renderer: 'canvas' });
    instance.on('brushEnd', (event: unknown) => {
      const indices = brushIndices(event);
      instance.dispatchAction({ type: 'brush', areas: [] });
      const picked = indices === null ? null : brushRange(series.buckets, indices[0], indices[1]);
      if (picked !== null) onBrush(picked);
    });
    const enter = (): void => onPointer(true);
    const leave = (): void => onPointer(false);
    container.addEventListener('pointerenter', enter);
    container.addEventListener('pointerleave', leave);
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(container);
    chart = instance;
    return () => {
      // First, so the App stops deferring reloads even if a later teardown step throws.
      onPointer(false);
      observer.disconnect();
      container.removeEventListener('pointerenter', enter);
      container.removeEventListener('pointerleave', leave);
      instance.dispose();
      chart = null;
    };
  });

  $effect(() => {
    if (chart === null) return;
    chart.setOption(chartOption, { notMerge: true });
    chart.dispatchAction(BRUSH_CURSOR);
  });
</script>

<div class="timeline" data-testid="timeline">
  <div class="head">
    <div class="controls">
      <span class="lbl">stack</span>
      {#each STACKS as choice (choice)}
        <button type="button" class="opt" class:on-soft={stack === choice} aria-pressed={stack === choice} onclick={() => onStack(choice)}>
          {choice}
        </button>
      {/each}
      <span class="sep">·</span>
      <span class="lbl">bucket</span>
      <button
        type="button"
        class="opt"
        class:on-soft={bucket === 'day'}
        aria-pressed={bucket === 'day'}
        aria-disabled={!dayAllowed}
        aria-describedby={dayAllowed ? undefined : `${uid}-day`}
        title={dayAllowed ? undefined : DAY_REASON}
        onclick={() => pickBucket('day', dayAllowed)}
      >
        day
      </button>
      <button
        type="button"
        class="opt"
        class:on-soft={bucket === 'hour'}
        aria-pressed={bucket === 'hour'}
        aria-disabled={!hourAllowed}
        aria-describedby={hourAllowed ? undefined : `${uid}-hour`}
        title={hourAllowed ? undefined : HOUR_REASON}
        onclick={() => pickBucket('hour', hourAllowed)}
      >
        hour
      </button>
      {#if !dayAllowed}<span id="{uid}-day" class="sr-only">{DAY_REASON}</span>{/if}
      {#if !hourAllowed}<span id="{uid}-hour" class="sr-only">{HOUR_REASON}</span>{/if}
      <span class="sep">·</span>
      <button type="button" role="checkbox" class="opt check" aria-checked={cumulative} onclick={() => onCumulative(!cumulative)}>
        <span aria-hidden="true">[{cumulative ? 'x' : ' '}]</span> cumulative
      </button>
    </div>
    <span class="hint">drag to zoom ⟷</span>
  </div>
  {#if series.stack !== 'model'}
    <div class="legend">
      {#each series.keys as key (key.key)}
        <span><span class="dot" style:background={key.color}></span>{key.label}</span>
      {/each}
    </div>
  {/if}
  <div class="chart" bind:this={container} role="img" aria-label={summary}></div>
</div>

<style>
  .timeline {
    min-width: 0;
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 6px 16px;
    margin-bottom: 4px;
    color: var(--dim);
    font-size: 11px;
  }

  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
  }

  .lbl {
    margin-right: 2px;
  }

  .sep {
    margin: 0 6px;
    color: var(--dimmer);
  }

  .check {
    white-space: pre;
  }

  .hint {
    color: var(--dim);
  }

  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 14px;
    margin-bottom: 2px;
    font-size: 11px;
    color: var(--dim);
  }

  .chart {
    width: 100%;
    height: clamp(260px, 18vw, 400px);
  }
</style>
