<script lang="ts">
  import type { ModelBreakdown } from '../../shared/api';
  import { EM_DASH, formatPercent, formatRate, formatTokens, formatUsd } from '../lib/format';

  interface Props {
    rows: readonly ModelBreakdown[];
  }

  let { rows }: Props = $props();
</script>

<div class="models" data-testid="models-table">
  <h2 class="cap">models</h2>
  <table class="t">
    <thead>
      <tr><th>model</th><th class="r">tokens</th><th class="r">cost</th><th class="r">share</th><th class="r">$/Mtok</th></tr>
    </thead>
    <tbody>
      {#each rows as row (row.model)}
        <tr>
          <td title={row.model}>
            <span class="dot" style:background={row.color}></span>{row.label}{#if !row.priced}<span
                class="unpriced"
                title="no LiteLLM price: counted as $0"
              >
                *</span
              >{/if}
          </td>
          <td class="r">{formatTokens(row.tokensTotal)}</td>
          <td class="r">{row.priced ? formatUsd(row.cost) : EM_DASH}</td>
          <td class="r dim">{formatPercent(row.share)}</td>
          <td class="r dim">{formatRate(row.costPerMTok)}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .models {
    min-width: 0;
    overflow-x: auto;
  }

  .cap {
    margin-bottom: 4px;
  }

  .unpriced {
    margin-left: 0.25em;
    color: var(--err);
  }
</style>
