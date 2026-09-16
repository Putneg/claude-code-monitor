<script lang="ts">
  import type { CodexLimit } from '../../shared/api';
  import { limitViews } from '../lib/limits';

  interface Props {
    limits: readonly CodexLimit[];
    now: string;
    timeZone: string;
  }

  let { limits, now, timeZone }: Props = $props();
  const views = $derived(limitViews(limits, now, timeZone));
</script>

<div class="limits" data-testid="codex-limits">
  {#each views as view (view.id)}
    <div class="block" role="group" aria-label={view.title}>
      <div class="head">
        <span class="cap">{view.title}</span>
        <span class="asof">{view.asOf}</span>
      </div>
      {#each view.windows as item (item.key)}
        <div class="win" class:stale={item.stale}>
          <span class="lbl">{item.label}</span>
          <span class="bar" aria-hidden="true">{item.bar}</span>
          {#if item.stale}
            <span class="rs wide" title={item.resets}>{item.resets}</span>
          {:else}
            <span class="pct">{item.percent}</span>
            <span class="rs" title={item.resets}>{item.resets}</span>
          {/if}
        </div>
      {/each}
      {#if view.credits !== null}
        <p class="credits">{view.credits}</p>
      {/if}
    </div>
  {/each}
</div>

<style>
  .limits {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
    padding-top: 10px;
    border-top: 1px solid var(--line);
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: baseline;
    gap: 2px 8px;
    margin-bottom: 4px;
  }

  .asof,
  .win,
  .credits {
    color: var(--dim);
    font-size: 11.5px;
  }

  .asof {
    font-size: 10.5px;
  }

  .win {
    display: grid;
    grid-template-columns: 6ch auto 4ch minmax(0, 1fr);
    align-items: baseline;
    gap: 8px;
  }

  .bar {
    color: var(--accent);
    white-space: pre;
  }

  .pct {
    color: var(--fg);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .rs {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .wide {
    grid-column: 3 / -1;
  }

  /* The bar is decorative; the window's text keeps the readable dim color. */
  .stale .bar {
    color: var(--dimmer);
  }

  .credits {
    margin: 2px 0 0;
  }
</style>
