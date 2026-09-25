<script lang="ts">
  import type { Day, OverviewResponse } from '../../shared/api';
  import { heroView } from '../lib/hero';
  import type { Unit } from '../lib/view-state';
  import DrumNumber from './DrumNumber.svelte';

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
  <div class="readout" class:long={hero.main.length > 10}>
    <DrumNumber text={hero.main} testid="hero-main" />
  </div>
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

  /* The caption is a dim label here, not a section title. */
  .spend .cap {
    color: var(--dim);
    font-size: 12px;
    font-weight: 400;
  }

  /* Framed readout with a pointer on the right, like an airspeed box. */
  .readout {
    position: relative;
    display: inline-flex;
    margin: 6px 12px 12px 0;
    padding: 1px 14px 1px 10px;
    border: 1.5px solid var(--frame);
    font-size: 36px;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--accent);
  }

  .readout.long {
    font-size: 30px;
  }

  .readout::before,
  .readout::after {
    content: '';
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    border: 11px solid transparent;
    border-right: 0;
  }

  .readout::before {
    right: -12px;
    border-left-color: var(--frame);
  }

  .readout::after {
    right: -9.5px;
    border-left-color: var(--bg);
  }

  .kv {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 3px 12px;
    margin: 0;
    font-size: 12px;
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
