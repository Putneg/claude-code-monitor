<script lang="ts">
  import type { StatusResponse } from '../../shared/api';
  import { pendingIndicator, statusView } from '../lib/status-view';

  interface Props {
    status: StatusResponse | null;
    apiDown: boolean;
  }

  let { status, apiDown }: Props = $props();
  const model = $derived(status === null ? null : statusView(status, apiDown));
  const indicator = $derived(model === null ? pendingIndicator(apiDown) : model.indicator);
</script>

<header class="sb" data-testid="status-bar">
  <h1 class="nm">claude-code-monitor</h1>
  {#if model !== null}
    <span class="src" title={model.sources}>{model.sources}</span>
    <span>{model.files}</span>
    <span class="sp"></span>
    <span>{model.prices}</span>
    <span>{model.tz}</span>
    <span>{model.sync}</span>
    {#each model.warnings as warning (warning)}
      <span class="warn">{warning}</span>
    {/each}
  {:else}
    <span class="sp"></span>
  {/if}
  <!-- One live region from the first render on, holding only the state word: backfill progress sits outside it, so polls announce nothing new. -->
  <span class:live={indicator.kind === 'live'} class:backfill={indicator.kind === 'backfill'} class:warn={indicator.kind === 'offline'}>
    <span role="status">{indicator.text}</span>{#if indicator.progress !== null}{` ${indicator.progress.files} `}<span aria-hidden="true"
        >{indicator.progress.bar}</span
      >{/if}
  </span>
</header>

<style>
  .sb {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 18px;
    align-items: center;
    padding: 7px 16px;
    background: var(--bg-raised);
    border-bottom: 1px solid var(--line);
    font-size: 11px;
    color: var(--dim);
    white-space: nowrap;
    overflow: hidden;
  }

  .nm {
    margin: 0;
    font-size: inherit;
    color: var(--accent);
    font-weight: 800;
  }

  .src {
    max-width: 32ch;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .sp {
    flex: 1;
  }

  .live {
    color: var(--ok);
  }

  .backfill {
    color: var(--accent);
  }
</style>
