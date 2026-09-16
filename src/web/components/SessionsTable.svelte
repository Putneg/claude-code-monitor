<script lang="ts">
  import type { SessionSort, SessionsResponse } from '../../shared/api';
  import { sessionRows } from '../lib/tables';
  import { SORTS } from '../lib/view-state';

  interface Props {
    data: SessionsResponse;
    sort: SessionSort;
    timeZone: string;
    onSort: (sort: SessionSort) => void;
  }

  let { data, sort, timeZone, onSort }: Props = $props();
  const rows = $derived(sessionRows(data.sessions, timeZone));
</script>

<section class="sec" data-testid="sessions-table">
  <div class="head">
    <h2 class="cap">sessions · {sort === 'cost' ? 'top by cost' : 'most recent'}</h2>
    <span class="meta">
      sort
      {#each SORTS as choice (choice)}
        <button type="button" class="opt" class:on-soft={sort === choice} aria-pressed={sort === choice} onclick={() => onSort(choice)}>
          {choice}
        </button>
      {/each}
      · {data.total} in range
    </span>
  </div>
  {#if rows.length === 0}
    <p class="none">no sessions in this range</p>
  {:else}
    <div class="scroll">
      <table class="t">
        <thead>
          <tr>
            <th class="r">#</th><th>session</th><th>project</th><th>when</th><th>models</th>
            <th class="r">tokens</th><th class="r">cost</th><th class="r">sub%</th><th class="barcol"></th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row (row.id)}
            <tr>
              <td class="r dim">{row.index}</td>
              <td title={row.title}>
                {#if row.clientTag !== null}<span class="tag" title={row.client}>{row.clientTag}</span>{/if}
                <span class="title-text" class:muted={row.untitled}>{row.title}</span> <span class="muted">{row.shortId}</span>
              </td>
              <td class:dim={!row.unknownProject} class:muted={row.unknownProject}>{row.project}</td>
              <td class="dim" title={row.whenTitle}>{row.when}</td>
              <td>
                {#each row.models as model (model.id)}
                  <span class="dot" style:background={model.color} role="img" aria-label={model.label} title={model.label}></span>
                {/each}
              </td>
              <td class="r dim">{row.tokens}</td>
              <td class="r">{row.cost}</td>
              <td class="r dim">{row.subShare}</td>
              <td class="barcol"><span class="fill" style:width="{row.barPct}%"></span></td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

<style>
  .head {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: baseline;
    gap: 6px 12px;
    margin-bottom: 4px;
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--dim);
    font-size: 11px;
  }

  .none {
    margin: 8px 0 0;
    color: var(--dim);
  }

  .scroll {
    overflow-x: auto;
  }

  /* max-width is undefined on table cells, so the title span carries the limit. */
  .title-text {
    display: inline-block;
    max-width: 48ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: bottom;
  }

  .tag {
    margin-right: 4px;
    padding: 0 3px;
    border: 1px solid var(--line);
    color: var(--dim);
    font-size: 10.5px;
  }

  .barcol {
    width: 14%;
  }

  .fill {
    display: block;
    height: 8px;
    background: var(--accent);
    opacity: 0.75;
  }
</style>
