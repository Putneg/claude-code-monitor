<script lang="ts">
  import type { ProjectBreakdown } from '../../shared/api';
  import { projectRows } from '../lib/tables';

  interface Props {
    rows: readonly ProjectBreakdown[];
    selected: readonly string[];
    onToggle: (id: string) => void;
  }

  let { rows, selected, onToggle }: Props = $props();
  const items = $derived(projectRows(rows, selected));
</script>

<section class="sec" data-testid="projects-table">
  <h2 class="cap">projects · top 8 by cost <span class="hint">· click a row to filter</span></h2>
  {#if items.length === 0}
    <p class="none">no project information in this range</p>
  {:else}
    <!-- The rows need 360px, so every number fits a 400px phone; narrower screens scroll this box, never the page. -->
    <div class="scroll">
      <div class="row head" aria-hidden="true">
        <span>project</span><span></span><span class="r">cost</span><span class="r">tokens</span><span class="r">sessions</span>
      </div>
      <ol class="list">
        {#each items as item (item.id)}
          <li>
            <button
              type="button"
              class="row"
              class:selected={item.selected}
              aria-pressed={item.selected}
              title={item.path}
              onclick={() => onToggle(item.id)}
            >
              <span class="label">{item.label}</span>
              <span class="track"><span class="fill" style:width="{item.barPct}%"></span></span>
              <span class="r">{item.cost}</span>
              <span class="r dim">{item.tokens}</span>
              <span class="r dim">{item.sessions}</span>
            </button>
          </li>
        {/each}
      </ol>
    </div>
  {/if}
</section>

<style>
  .cap {
    margin-bottom: 4px;
  }

  .hint {
    color: var(--dim);
    text-transform: none;
    letter-spacing: 0;
  }

  .none {
    margin: 8px 0 0;
    color: var(--dim);
  }

  .scroll {
    overflow-x: auto;
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .row {
    display: grid;
    grid-template-columns: minmax(12ch, 24ch) minmax(6ch, 1fr) 9ch 8ch 8ch;
    gap: 12px;
    align-items: center;
    width: 100%;
    min-width: 360px;
    padding: 4px 6px;
    text-align: left;
    font-size: 11.5px;
    border-bottom: 1px dashed var(--line-soft);
  }

  .head {
    color: var(--dim);
    font-size: 10.5px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    border-bottom: 1px solid var(--line);
  }

  button.row:hover {
    background: var(--hover);
  }

  /* The scroll box clips the global 2px-offset outline on full-width rows. */
  button.row:focus-visible {
    outline-offset: -2px;
  }

  button.row:hover .label,
  .selected .label {
    color: var(--accent);
  }

  .selected .label::before {
    content: '▸ ';
  }

  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .track {
    display: block;
  }

  .fill {
    display: block;
    height: 8px;
    background: linear-gradient(90deg, #ffb000, #ffb00088);
  }

  .r {
    text-align: right;
  }
</style>
