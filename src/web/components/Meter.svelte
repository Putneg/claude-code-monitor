<script lang="ts">
  import { meterWidth } from '../lib/meter';

  interface Props {
    /** 0-1; the number next to the bar carries the value, the bar is decorative. */
    share: number;
    color?: string;
  }

  let { share, color = 'var(--accent)' }: Props = $props();
</script>

<span class="meter" aria-hidden="true"><span class="fill" style:width={meterWidth(share)} style:background={color}></span></span>

<style>
  .meter {
    display: block;
    height: 5px;
    background: var(--line-soft);
  }

  .fill {
    display: block;
    height: 100%;
  }
</style>
