<script lang="ts">
  import type { ProjectOption } from '../../shared/api';
  import { matchProjects } from '../lib/tables';
  import { toggleProject } from '../lib/view-state';

  interface Props {
    projects: readonly ProjectOption[];
    selected: readonly string[];
    onChange: (ids: readonly string[]) => void;
  }

  let { projects, selected, onChange }: Props = $props();
  let open = $state(false);
  let query = $state('');
  let root: HTMLDivElement;
  let toggle: HTMLButtonElement;
  let search = $state<HTMLInputElement | undefined>();
  const panelId = $props.id();

  /** The panel is at most this wide, and keeps this margin from both edges of the viewport. */
  const PANEL_MAX_WIDTH = 340;
  const PANEL_MARGIN = 18;
  let panelWidth = $state(PANEL_MAX_WIDTH);
  let panelLeft = $state(0);

  const visible = $derived(matchProjects(projects, query));
  const summary = $derived(selected.length === 0 ? `all (${projects.length})` : `${selected.length} selected`);

  $effect(() => {
    if (open) search?.focus();
  });

  function closeOnOutside(event: PointerEvent): void {
    if (open && event.target instanceof Node && !root.contains(event.target)) open = false;
  }

  /** Escape closes the panel; focus inside it goes back to the toggle instead of staying on the removed search box. */
  function closeOnEscape(event: KeyboardEvent): void {
    if (!open || event.key !== 'Escape') return;
    const focusInside = root.contains(document.activeElement);
    open = false;
    if (focusInside) toggle.focus();
  }

  /**
   * Focus moving to a control outside the picker (Tab, Shift+Tab) closes it. A null relatedTarget is not a move out:
   * a window switch, or a browser that does not focus buttons on click. Pointer-down outside and Escape close it then.
   */
  function closeOnFocusOut(event: FocusEvent): void {
    if (open && event.relatedTarget instanceof Node && !root.contains(event.relatedTarget)) open = false;
  }

  /** "all projects" stays focusable while nothing is selected (aria-disabled), so clearing never drops focus to the page. */
  function clearAll(): void {
    if (selected.length > 0) onChange([]);
  }

  /**
   * Sizes the panel to min(340px, 100vw - 36px) and starts it at the toggle's left edge. On a phone the toggle sits
   * after the "projects" label, so the panel moves left by what would pass the viewport's right margin; it never
   * scrolls the page sideways.
   */
  function placePanel(): void {
    panelWidth = Math.min(PANEL_MAX_WIDTH, window.innerWidth - 2 * PANEL_MARGIN);
    const right = root.getBoundingClientRect().left + panelWidth;
    panelLeft = Math.min(0, document.documentElement.clientWidth - PANEL_MARGIN - right);
  }

  /** A resized window (a phone turned) moves the toggle, so an open panel is placed again. */
  function placeWhileOpen(): void {
    if (open) placePanel();
  }

  function toggleOpen(): void {
    if (!open) placePanel();
    open = !open;
  }
</script>

<svelte:window onpointerdown={closeOnOutside} onkeydown={closeOnEscape} onresize={placeWhileOpen} />

<div class="picker" bind:this={root} onfocusout={closeOnFocusOut}>
  <button
    bind:this={toggle}
    type="button"
    class="dd"
    aria-label={`projects: ${summary}`}
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-controls={open ? panelId : undefined}
    onclick={toggleOpen}
  >
    {summary} <span aria-hidden="true">▾</span>
  </button>
  {#if open}
    <!-- tabindex -1: a click on the panel's background moves focus onto the panel, so focus stays inside the picker and Escape returns it to the toggle. -->
    <div
      id={panelId}
      class="panel"
      role="dialog"
      aria-label="filter projects"
      tabindex="-1"
      style:left="{panelLeft}px"
      style:width="{panelWidth}px"
    >
      <input bind:this={search} bind:value={query} type="search" placeholder="search projects" aria-label="search projects" />
      <ul>
        {#each visible as project (project.id)}
          {@const checked = selected.includes(project.id)}
          <li>
            <button
              type="button"
              role="checkbox"
              class="item"
              aria-checked={checked}
              title={project.path}
              onclick={() => onChange(toggleProject(selected, project.id))}
            >
              <span class="sq" class:off={!checked} style:--sq="var(--accent)" aria-hidden="true"></span>
              <span class="ut">{project.label}</span>
            </button>
          </li>
        {:else}
          <li class="none">no match</li>
        {/each}
      </ul>
      <button type="button" class="opt" aria-disabled={selected.length === 0} onclick={clearAll}>all projects</button>
    </div>
  {/if}
</div>

<style>
  .picker {
    position: relative;
  }

  .dd {
    border: 1px solid var(--line);
    border-radius: 3px;
    padding: 1px 8px;
    color: var(--fg);
  }

  .dd:hover {
    border-color: var(--dim);
  }

  .panel {
    position: absolute;
    z-index: 10;
    top: calc(100% + 4px);
    left: 0;
    max-height: 340px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    background: var(--bg-raised);
    border: 1px solid var(--line);
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.55);
  }

  input {
    background: var(--bg);
    border: 1px solid var(--line);
    padding: 3px 6px;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
  }

  .item {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 2px 4px;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .item:hover {
    background: var(--hover);
  }

  /* The list scrolls (overflow-y: auto), which clips the global 2px-offset outline on full-width items. */
  .item:focus-visible {
    outline-offset: -2px;
  }

  .item[aria-checked='false'] {
    color: var(--dim);
  }

  .none {
    padding: 2px 4px;
    color: var(--dim);
  }
</style>
