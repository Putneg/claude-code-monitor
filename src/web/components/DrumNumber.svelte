<script lang="ts">
  import { untrack } from 'svelte';
  import { drumDigits, type DrumCell } from '../lib/drum';

  interface Props {
    /** The formatted value, e.g. '$16,102.11' or '20.58B'. */
    text: string;
    /** Test id of the text layer: tests, screen readers, selection and copy read the value there, never the strips. */
    testid: string;
  }

  let { text, testid }: Props = $props();

  /** Height of one digit window, in em; the strip moves by whole windows. Matches --win in the styles. */
  const WINDOW_EM = 1.2;

  let cells = $state.raw<readonly DrumCell[]>([]);
  /** Bumped on every rebuild, so the strips are created again at 0 and roll in. */
  let generation = $state(0);
  /** False for the first frames after a rebuild: the strips paint at 0 before they move to their digits. */
  let settled = $state(false);
  /** The last shown value; read untracked, so writing it never re-runs the effect. */
  let previous = $state.raw<string | null>(null);

  $effect.pre(() => {
    const next = drumDigits(
      untrack(() => previous),
      text,
    );
    previous = text;
    cells = next.cells;
    if (next.rebuild) {
      generation = untrack(() => generation) + 1;
      settled = false;
    }
  });

  // Two frames: the first paints the new strips at 0, the second starts the transition to the digits.
  $effect(() => {
    if (settled) return;
    void generation;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => (settled = true));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  });
</script>

<span class="number">
  <!-- The drum draws its digits and characters with CSS content, so it holds no text: selecting and copying reach only the text layer on top. -->
  <span class="drum" aria-hidden="true">
    {#key generation}
      {#each cells as cell, index (index)}
        {#if cell.kind === 'digit'}
          <span class="win"><span class="strip" style:transform="translateY({settled ? -cell.value * WINDOW_EM : 0}em)"></span></span>
        {:else}
          <span class="char" data-char={cell.value}></span>
        {/if}
      {/each}
    {/key}
  </span>
  <span class="text" data-testid={testid}>{text}</span>
</span>

<style>
  .number {
    --win: 1.2em;
    position: relative;
    display: inline-flex;
    line-height: var(--win);
  }

  .drum {
    display: inline-flex;
  }

  .win {
    display: inline-block;
    height: var(--win);
    overflow: hidden;
  }

  .strip {
    display: block;
    transition: transform 700ms cubic-bezier(0.2, 0.7, 0.2, 1);
  }

  .strip::before {
    content: '0\A 1\A 2\A 3\A 4\A 5\A 6\A 7\A 8\A 9';
    display: block;
    white-space: pre;
  }

  .char::before {
    content: attr(data-char);
    white-space: pre;
  }

  /* The real value, transparent, laid over the drum: the same font and tabular figures keep the glyphs aligned. */
  .text {
    position: absolute;
    inset: 0;
    color: transparent;
    white-space: pre;
  }

  @media (prefers-reduced-motion: reduce) {
    .strip {
      transition: none;
    }
  }
</style>
