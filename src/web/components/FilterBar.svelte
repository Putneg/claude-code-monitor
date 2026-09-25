<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { ClientOption, Day, ModelOption, ProjectOption } from '../../shared/api';
  import { createDebouncer, DATE_APPLY_DELAY_MS, typedRange, type Debouncer } from '../lib/date-input';
  import { shiftSide, type DayRange, type ShiftDirection } from '../lib/range';
  import { clientChoice, isChecked, PRESETS, toggleModel, type RangePreset, type ViewSettings, type ViewState } from '../lib/view-state';
  import ProjectPicker from './ProjectPicker.svelte';

  interface Props {
    view: ViewState;
    range: DayRange;
    today: Day;
    firstDay: Day | null;
    models: readonly ModelOption[];
    projects: readonly ProjectOption[];
    clients: readonly ClientOption[];
    onPreset: (preset: RangePreset) => void;
    onCustomRange: (from: Day, to: Day) => void;
    onSettings: (patch: Partial<ViewSettings>) => void;
    onShift: (direction: ShiftDirection) => void;
  }

  let { view, range, today, firstDay, models, projects, clients, onPreset, onCustomRange, onSettings, onShift }: Props = $props();
  const choice = $derived(clientChoice(view.clients));

  const uid = $props.id();
  const bounds = $derived({ today, firstDay });
  const back = $derived(shiftSide(view.range, range, 'back', bounds));
  const forward = $derived(shiftSide(view.range, range, 'forward', bounds));

  /** A disabled step stays focusable (aria-disabled) so its reason can be read; a click on it does nothing. */
  function step(direction: ShiftDirection, allowed: boolean): void {
    if (allowed) onShift(direction);
  }

  const modelIds = $derived(models.map((model) => model.id));
  const checkedCount = $derived(models.filter((model) => isChecked(view.models, model.id)).length);

  type Edge = 'from' | 'to';

  // Chromium reports every segment edit of a date input (a year typed as 2026 arrives as 0002, 0020, 0202, 2026),
  // so a typed day waits for a pause in typing, and the focused field is never written. A day that reverses the pair
  // waits for blur or Enter instead: ordering the pair would change this edge and rewrite the field in mid-edit.
  const debouncers: Readonly<Record<Edge, Debouncer>> = {
    from: createDebouncer(DATE_APPLY_DELAY_MS),
    to: createDebouncer(DATE_APPLY_DELAY_MS),
  };

  onDestroy(() => {
    debouncers.from.cancel();
    debouncers.to.cancel();
  });

  // A range change from outside these inputs (a preset, the brush, a new day) drops a typed day not yet applied.
  // Keyed on the days, not the object: the parent re-derives an equal range on every status poll.
  const rangeKey = $derived(`${range.from}|${range.to}`);
  $effect(() => {
    void rangeKey;
    debouncers.from.cancel();
    debouncers.to.cancel();
  });

  /**
   * Schedules a complete, valid, in-bounds day; any other value (a half-typed year, an empty field) cancels the pending
   * one. A day that reverses the pair (ISO days compare as strings) is held for blur or Enter rather than scheduled.
   */
  function onTyped(input: HTMLInputElement, edge: Edge): void {
    const next = typedRange(input.value, input.validity.valid, edge, range, { min: firstDay, max: today });
    if (next === null) {
      debouncers[edge].cancel();
      return;
    }
    const apply = (): void => onCustomRange(next.from, next.to);
    if (next.from > next.to) debouncers[edge].hold(apply);
    else debouncers[edge].schedule(apply);
  }

  /**
   * Leaving the field applies a pending or held day at once, then shows the effective range: an invalid or empty value,
   * or a day the view refused (a range over the limit), reverts, and a swapped from/to shows the ordered day. `range` is
   * read after the flush, so it already reflects the applied day. The field no longer has focus here.
   */
  function onLeave(input: HTMLInputElement, edge: Edge): void {
    debouncers[edge].flush();
    if (input.value !== range[edge]) input.value = range[edge];
  }

  /** Enter commits the typed day at once, a held one included, even when ordering the pair rewrites this field. */
  function onDateKey(event: KeyboardEvent, edge: Edge): void {
    if (event.key === 'Enter') debouncers[edge].flush();
  }
</script>

<div class="fb" data-testid="filter-bar">
  <div class="grp" role="group" aria-label="range">
    <span class="lbl">range</span>
    <span class="seg">
      {#each PRESETS as preset (preset)}
        <button
          type="button"
          class="opt"
          class:on={view.range === preset}
          aria-pressed={view.range === preset}
          onclick={() => onPreset(preset)}
        >
          {preset}
        </button>
      {/each}
    </span>
    <span class="dates">
      <button
        type="button"
        class="step"
        aria-label={back.label}
        aria-disabled={!back.allowed}
        aria-describedby={back.allowed ? undefined : `${uid}-back`}
        title={back.reason ?? back.label}
        onclick={() => step('back', back.allowed)}>‹</button
      >
      <input
        type="date"
        class="date"
        aria-label="from"
        value={range.from}
        min={firstDay ?? undefined}
        max={today}
        oninput={(event) => onTyped(event.currentTarget, 'from')}
        onblur={(event) => onLeave(event.currentTarget, 'from')}
        onkeydown={(event) => onDateKey(event, 'from')}
      />
      <span class="lbl">→</span>
      <input
        type="date"
        class="date"
        aria-label="to"
        value={range.to}
        min={firstDay ?? undefined}
        max={today}
        oninput={(event) => onTyped(event.currentTarget, 'to')}
        onblur={(event) => onLeave(event.currentTarget, 'to')}
        onkeydown={(event) => onDateKey(event, 'to')}
      />
      <button
        type="button"
        class="step"
        aria-label={forward.label}
        aria-disabled={!forward.allowed}
        aria-describedby={forward.allowed ? undefined : `${uid}-forward`}
        title={forward.reason ?? forward.label}
        onclick={() => step('forward', forward.allowed)}>›</button
      >
    </span>
    {#if !back.allowed}<span id="{uid}-back" class="sr-only">{back.reason}</span>{/if}
    {#if !forward.allowed}<span id="{uid}-forward" class="sr-only">{forward.reason}</span>{/if}
  </div>

  {#if clients.length > 1}
    <div class="grp" role="group" aria-label="client">
      <span class="lbl">client</span>
      <span class="seg">
        <button
          type="button"
          class="opt"
          class:on={choice === 'all'}
          aria-pressed={choice === 'all'}
          onclick={() => onSettings({ clients: [] })}
        >
          all
        </button>
        {#each clients as client (client.id)}
          <button
            type="button"
            class="opt"
            class:on={choice === client.id}
            aria-pressed={choice === client.id}
            title={client.label}
            onclick={() => onSettings({ clients: [client.id] })}
          >
            {client.id}
          </button>
        {/each}
      </span>
    </div>
  {/if}

  <div class="grp" role="group" aria-label="projects">
    <span class="lbl">projects</span>
    <ProjectPicker {projects} selected={view.projects} onChange={(ids) => onSettings({ projects: ids })} />
  </div>

  <div class="grp" role="group" aria-label="unit">
    <span class="lbl">unit</span>
    <span class="seg">
      <button
        type="button"
        class="opt"
        class:on={view.unit === 'usd'}
        aria-pressed={view.unit === 'usd'}
        aria-label="$ (dollars)"
        onclick={() => onSettings({ unit: 'usd' })}
      >
        $
      </button>
      <button
        type="button"
        class="opt"
        class:on={view.unit === 'tok'}
        aria-pressed={view.unit === 'tok'}
        onclick={() => onSettings({ unit: 'tok' })}
      >
        tok
      </button>
    </span>
  </div>
  <div class="grp models" role="group" aria-label="models">
    <span class="lbl">models</span>
    {#each models as model (model.id)}
      {@const checked = isChecked(view.models, model.id)}
      <button
        type="button"
        role="checkbox"
        class="chk"
        aria-checked={checked}
        disabled={checked && checkedCount === 1}
        title={model.priced ? model.id : `${model.id} (no price: counted as $0)`}
        onclick={() => onSettings({ models: toggleModel(view.models, modelIds, model.id) })}
      >
        <span class="sq" class:off={!checked} style:--sq={model.color} aria-hidden="true"></span>
        {model.label}
      </button>
    {/each}
  </div>
</div>

<style>
  .fb {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px 26px;
    padding: 10px 18px;
    border-bottom: 1px solid var(--line);
    color: var(--dim);
    font-size: 11.5px;
  }

  .grp {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
  }

  .lbl {
    margin-right: 4px;
  }

  .date {
    background: transparent;
    border: 1px solid var(--line);
    border-radius: 3px;
    padding: 1px 8px;
    color: var(--fg);
  }

  .date:hover {
    border-color: var(--dim);
  }

  .models {
    flex-basis: 100%;
  }

  /* The dates and their step buttons wrap as one unit. */
  .dates {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .step {
    padding: 0 6px;
    font-size: 15px;
    line-height: 1;
    color: var(--fg);
  }

  .step:hover:not([aria-disabled='true']) {
    color: var(--accent);
  }

  /* The scoped .step color outranks the global disabled rule, so the disabled look is repeated here. */
  .step[aria-disabled='true'] {
    color: var(--dimmer);
  }

  .chk:hover:not(:disabled) {
    color: var(--accent);
  }

  .chk:disabled {
    cursor: not-allowed;
  }
</style>
