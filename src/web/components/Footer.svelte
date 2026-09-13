<script lang="ts">
  import type { StatusResponse } from '../../shared/api';
  import { EM_DASH } from '../lib/format';

  interface Props {
    status: StatusResponse | null;
  }

  let { status }: Props = $props();
</script>

<footer class="ft">
  {#if status !== null}
    <span>db: {status.data.rows.toLocaleString('en-US')} billing rows</span>
    <span>
      history since {status.data.firstDay ?? EM_DASH} · JSONL older than ~30d are deleted by Claude Code — DB keeps everything
    </span>
  {/if}
  <span>cost = API-equivalent estimate (LiteLLM prices)</span>
</footer>

<style>
  .ft {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 22px;
    padding: 8px 16px;
    border-top: 1px solid var(--line);
    background: var(--bg-sunken);
    font-size: 10.5px;
    color: var(--dim);
  }
</style>
