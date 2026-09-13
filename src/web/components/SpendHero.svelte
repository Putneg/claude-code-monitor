<script lang="ts">
  import type { Day, OverviewResponse } from '../../shared/api';
  import { heroView } from '../lib/hero';
  import type { Unit } from '../lib/view-state';

  interface Props {
    overview: OverviewResponse;
    unit: Unit;
    rangeText: string;
    firstDay: Day | null;
  }

  let { overview, unit, rangeText, firstDay }: Props = $props();
  const hero = $derived(heroView(overview, unit, rangeText, firstDay));
</script>

<div class="spend" data-testid="spend-hero">
  <h2 class="cap">{hero.caption}</h2>
  <div class="num" data-testid="hero-main">{hero.main}</div>
  <dl class="kv">
    {#each hero.rows as row (row.label)}
      <dt>{row.label}</dt>
      <dd class:muted={row.muted}>
        {#if row.strong}<b>{row.strong}</b>{/if}{row.rest}
      </dd>
    {/each}
  </dl>
</div>

<style>
  .spend {
    min-width: 0;
  }

  .num {
    margin: 6px 0 10px;
    font-size: 42px;
    font-weight: 800;
    line-height: 1.1;
    letter-spacing: -0.02em;
    color: var(--accent);
    text-shadow: 0 0 18px var(--accent-glow);
    font-variant-numeric: tabular-nums;
  }

  .kv {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 3px 12px;
    margin: 0;
    font-size: 11.5px;
    color: var(--dim);
  }

  dd {
    margin: 0;
  }

  b {
    color: var(--fg);
    font-weight: 500;
  }
</style>
