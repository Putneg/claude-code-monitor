<script lang="ts">
  import type { StatusResponse } from '../../shared/api';
  import { formatBytes } from '../lib/format';
  import { progressBar, visibleSources, type EmptyKind } from '../lib/status-view';

  interface Props {
    kind: EmptyKind | 'loading' | 'error';
    status: StatusResponse | null;
    message: string | null;
  }

  let { kind, status, message }: Props = $props();
  const backfill = $derived(status?.backfill ?? null);
</script>

<section class="empty" data-testid="empty-state" data-kind={kind}>
  {#if kind === 'loading'}
    <p class="title">connecting to claude-code-monitor…</p>
  {:else if kind === 'error'}
    <div role="alert">
      <p class="title alert">⚠ cannot load data</p>
      <p class="note">{message ?? 'unexpected error'} · retrying every 30s</p>
    </div>
  {:else if kind === 'backfill'}
    <p class="title">backfill in progress</p>
    {#if backfill !== null && backfill.filesTotal > 0}
      <p class="progress">
        <span class="meter">{progressBar(backfill.bytesDone, backfill.bytesTotal, 24)}</span>
        <span class="note">
          {backfill.filesDone}/{backfill.filesTotal} files · {formatBytes(backfill.bytesDone)} / {formatBytes(backfill.bytesTotal)}
        </span>
      </p>
    {/if}
    <p class="note">the first scan reads every transcript once; the page fills in as files are committed</p>
  {:else if kind === 'source-missing'}
    <p class="title alert">⚠ source missing</p>
    <ul>
      {#each visibleSources(status?.sources ?? []) as source (source.path)}
        <li class:alert={!source.ok}>{source.path}{source.error === null ? '' : ` — ${source.error}`}</li>
      {/each}
    </ul>
    <p class="note">mount the Claude Code projects directory read-only (see CLAUDE_HOME in the README)</p>
  {:else if kind === 'no-data'}
    <p class="title">no usage recorded yet</p>
    <p class="note">the transcript folders contain no assistant messages with token usage</p>
  {:else}
    <p class="title">no usage in range</p>
    <p class="note">{message} · try a wider range such as 90d or all</p>
  {/if}
</section>

<style>
  .empty {
    padding: 48px 18px;
    border-top: 1px solid var(--line);
  }

  .title {
    margin: 0 0 8px;
    font-size: 14px;
    font-weight: 700;
    color: var(--fg);
  }

  .title.alert,
  .alert {
    color: var(--err);
  }

  .note {
    margin: 4px 0;
    color: var(--dim);
  }

  .progress {
    display: flex;
    gap: 14px;
    align-items: baseline;
    margin: 8px 0;
  }

  .meter {
    color: var(--accent);
    letter-spacing: 1px;
  }

  ul {
    margin: 8px 0;
    padding-left: 18px;
    color: var(--dim);
  }
</style>
