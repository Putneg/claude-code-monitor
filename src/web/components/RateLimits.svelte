<script lang="ts">
  import type { LimitView } from '../lib/limits';

  interface Props {
    /** Prepared blocks (statusLimitViews): Claude first, then Codex. */
    views: readonly LimitView[];
  }

  let { views }: Props = $props();
  /** Tick positions in percent; 0, 50 and 100 are the long ones. */
  const TICKS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
</script>

<div class="limits" data-testid="rate-limits">
  {#each views as view (view.id)}
    <div class="block" role="group" aria-label={view.title}>
      <div class="head">
        <span class="sub">{view.title}</span>
        <span class="asof">{view.asOf}</span>
      </div>
      {#each view.windows as item (item.key)}
        <div class="win" class:stale={item.stale} class:hot={item.hot}>
          <div class="line">
            {#if item.stale}
              <span class="lbl">{item.label}</span>
              <span class="rs wide" title={item.resets}>{item.resets}</span>
            {:else}
              <span class="lbl"
                >{item.label}{#if item.resets !== ''}<span class="rs" title={item.resets}>{` · ${item.resets}`}</span>{/if}</span
              >
              <span class="pct">{item.percent}</span>
            {/if}
          </div>
          <div class="scale" aria-hidden="true">
            {#each TICKS as tick (tick)}<i class:major={tick % 50 === 0} style:left="{tick}%"></i>{/each}
            <span class="zone"></span>
            {#if !item.stale}
              <span class="fill" style:width="{item.used}%"></span>
              <span class="bug" style:left="{item.used}%"></span>
            {/if}
          </div>
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
    align-items: baseline;
    gap: 2px 8px;
    margin-bottom: 4px;
  }

  .asof,
  .credits,
  .line {
    color: var(--dim);
    font-size: 11.5px;
  }

  .win {
    margin-bottom: 8px;
  }

  .line {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    min-width: 0;
  }

  .lbl,
  .rs {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pct {
    flex: none;
    color: var(--fg);
    font-weight: 500;
  }

  .hot .pct {
    color: var(--err);
  }

  .scale {
    position: relative;
    height: 14px;
    margin-top: 2px;
    border-bottom: 1px solid var(--frame);
  }

  .scale i {
    position: absolute;
    bottom: 0;
    width: 1px;
    height: 4px;
    background: var(--line);
  }

  .scale i.major {
    height: 8px;
    background: var(--dimmer);
  }

  .zone {
    position: absolute;
    bottom: -3px;
    left: 80%;
    width: 20%;
    height: 3px;
    background: var(--err);
    opacity: 0.8;
  }

  .fill {
    position: absolute;
    left: 0;
    bottom: 0;
    height: 2px;
    background: var(--fg);
    transition: width 700ms cubic-bezier(0.2, 0.7, 0.2, 1);
  }

  .hot .fill {
    background: var(--err);
  }

  .bug {
    position: absolute;
    top: 0;
    width: 0;
    height: 0;
    border-left: 5px solid transparent;
    border-right: 5px solid transparent;
    border-top: 7px solid var(--accent);
    transform: translateX(-5px);
    transition: left 700ms cubic-bezier(0.2, 0.7, 0.2, 1);
  }

  .stale .scale {
    opacity: 0.5;
  }

  .credits {
    margin: 2px 0 0;
  }

  @media (prefers-reduced-motion: reduce) {
    .fill,
    .bug {
      transition: none;
    }
  }
</style>
