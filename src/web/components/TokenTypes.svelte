<script lang="ts">
  import type { OverviewTotals } from '../../shared/api';
  import { formatPercent } from '../lib/format';
  import { tokenInsights, tokenTypeRows } from '../lib/token-types';
  import Meter from './Meter.svelte';

  interface Props {
    totals: OverviewTotals;
  }

  let { totals }: Props = $props();
  const rows = $derived(tokenTypeRows(totals));
  const insights = $derived(tokenInsights(rows));
</script>

<div class="types" data-testid="token-types">
  <h2 class="cap">Token types <span class="dim">tokens vs cost</span></h2>
  <table>
    <thead>
      <tr><th>type</th><th colspan="2">tokens</th><th colspan="2">cost</th></tr>
    </thead>
    <tbody>
      {#each rows as row (row.key)}
        <tr>
          <td class="name">{row.label}</td>
          <td class="bar"><Meter share={row.tokenShare} color="var(--cyan)" /></td>
          <td class="pct">{formatPercent(row.tokenShare)}</td>
          <td class="bar"><Meter share={row.costShare} /></td>
          <td class="pct">{formatPercent(row.costShare)}</td>
        </tr>
      {/each}
    </tbody>
  </table>
  {#each insights as line (line)}
    <p class="insight">{line}</p>
  {/each}
</div>

<style>
  .types {
    min-width: 0;
    overflow-x: auto;
  }

  .cap {
    margin-bottom: 8px;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    line-height: 1.75;
  }

  th {
    padding: 0 10px 0 0;
    text-align: left;
    font-weight: 400;
    color: var(--dim);
  }

  td {
    padding: 0 10px 0 0;
    white-space: nowrap;
  }

  .name {
    min-width: 12ch;
    color: var(--fg);
  }

  .bar {
    width: 40%;
    min-width: 12ch;
  }

  .pct {
    min-width: 6ch;
    text-align: right;
    color: var(--dim);
  }

  .insight {
    margin: 0;
    color: var(--dim);
    font-size: 12px;
  }

  .insight:first-of-type {
    margin-top: 10px;
  }
</style>
