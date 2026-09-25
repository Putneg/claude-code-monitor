<script lang="ts">
  import type { StatusResponse } from '../../shared/api';
  import { pendingIndicator, statusView } from '../lib/status-view';
  import Meter from './Meter.svelte';

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
    <span class="src ut" title={model.sources}>{model.sources}</span>
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
  <!-- One live region from the first render on, holding only the state word: the dot and backfill progress sit outside it, so polls announce nothing new. -->
  <span
    class="ind"
    class:live={indicator.kind === 'live'}
    class:backfill={indicator.kind === 'backfill'}
    class:warn={indicator.kind === 'offline'}
  >
    {#if indicator.kind === 'live' || indicator.kind === 'offline'}<span class="led" aria-hidden="true"></span>{/if}
    <span role="status">{indicator.text}</span>{#if indicator.progress !== null}
      <span class="files">{indicator.progress.files}</span><span class="bf"><Meter share={indicator.progress.share} /></span>{/if}
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
    font-size: 11.5px;
    color: var(--dim);
    white-space: nowrap;
    overflow: hidden;
  }

  .nm {
    margin: 0;
    font-size: inherit;
    color: var(--fg);
    font-weight: 700;
  }

  .src {
    max-width: 32ch;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 11px;
  }

  .sp {
    flex: 1;
  }

  .ind {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .led {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    border: 1px solid currentColor;
  }

  .live {
    color: var(--ok);
  }

  .live .led {
    background: currentColor;
    animation: pulse 2.4s ease-in-out infinite;
  }

  .backfill {
    color: var(--accent);
  }

  .bf {
    display: inline-block;
    width: 40px;
  }

  @keyframes pulse {
    50% {
      opacity: 0.35;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .live .led {
      animation: none;
    }
  }
</style>
