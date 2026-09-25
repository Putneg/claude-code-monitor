<script lang="ts">
  import { onMount } from 'svelte';
  import type { Day, FiltersResponse, OverviewResponse, SessionsResponse, StatusResponse } from '../shared/api';
  import { createApiClient, describeError } from './lib/api';
  import { historyAction } from './lib/history';
  import { statusLimitViews } from './lib/limits';
  import { changeKey, decideLoad, POLL_INTERVAL_MS, startPolling, type LoadMark } from './lib/poll';
  import { dayBucketAllowed, hourBucketAllowed, rangeLabel, resolveRange, shiftRange, type ShiftDirection } from './lib/range';
  import { dataRequest, type DataRequest } from './lib/request';
  import { emptyStateKind } from './lib/status-view';
  import {
    effectiveView,
    parseViewState,
    serializeViewState,
    toggleProject,
    visibleModels,
    visibleStacks,
    withCustomRange,
    withPreset,
    withSettings,
    withShiftedRange,
    type RangePreset,
    type ViewSettings,
    type ViewState,
  } from './lib/view-state';
  import EmptyState from './components/EmptyState.svelte';
  import FilterBar from './components/FilterBar.svelte';
  import Footer from './components/Footer.svelte';
  import ModelsTable from './components/ModelsTable.svelte';
  import ProjectsTable from './components/ProjectsTable.svelte';
  import RateLimits from './components/RateLimits.svelte';
  import SessionsTable from './components/SessionsTable.svelte';
  import SpendHero from './components/SpendHero.svelte';
  import StatusBar from './components/StatusBar.svelte';
  import Timeline from './components/Timeline.svelte';
  import TokenTypes from './components/TokenTypes.svelte';

  const api = createApiClient();

  let status = $state.raw<StatusResponse | null>(null);
  let filters = $state.raw<FiltersResponse | null>(null);
  let view = $state.raw<ViewState>(parseViewState(window.location.search));
  let overview = $state.raw<OverviewResponse | null>(null);
  let sessions = $state.raw<SessionsResponse | null>(null);
  let loadError = $state<string | null>(null);
  let apiDown = $state(false);
  let pointerOnChart = $state(false);
  let dataVersion = $state(0);
  /** A data load is in flight: the hero section is aria-busy and dims after a short delay. */
  let loading = $state(false);
  let lastLoad: LoadMark | null = null;
  let inflight: AbortController | null = null;

  const range = $derived(status !== null && filters !== null ? resolveRange(view, status.today, filters.bounds.firstDay) : null);
  /** Clients with data; the client switch and the client stack need two. */
  const available = $derived(filters === null ? [] : filters.clients.map((client) => client.id));
  /** The view as queried and drawn: see effectiveView. The URL keeps `view`. */
  const shown = $derived(effectiveView(view, available));
  const request = $derived(range === null ? null : dataRequest(shown, range));
  const empty = $derived(status === null ? null : emptyStateKind(status, overview));
  /** The filter bar lists the models used in the period, plus any the view has checked. */
  const shownModels = $derived(
    filters === null ? [] : visibleModels(filters.models, overview === null ? null : overview.modelsInRange, view.models),
  );
  /** The Claude and Codex rate-limit blocks; none until a reading exists. */
  const limitBlocks = $derived(status === null ? [] : statusLimitViews(status));

  /** One poll: refresh the status; reload filters and data only when the change key moved. */
  async function refreshStatus(): Promise<void> {
    const next = await api.status();
    const changed = status === null || filters === null || changeKey(status) !== changeKey(next);
    if (changed) {
      // Filters before status: if this request fails, status keeps the old key and the next poll retries.
      filters = await api.filters();
      dataVersion += 1;
    }
    status = next;
    apiDown = false;
  }

  function onPollError(error: unknown): void {
    apiDown = true;
    if (status === null) loadError = describeError(error);
  }

  /** Loads overview and sessions together; a newer request aborts the one in flight. */
  async function loadData(next: DataRequest): Promise<void> {
    inflight?.abort();
    const controller = new AbortController();
    inflight = controller;
    loading = true;
    try {
      const [nextOverview, nextSessions] = await Promise.all([
        api.overview(next.overview, controller.signal),
        api.sessions(next.sessions, controller.signal),
      ]);
      if (controller.signal.aborted) return;
      overview = nextOverview;
      sessions = nextSessions;
      loadError = null;
    } catch (error) {
      if (controller.signal.aborted) return;
      loadError = describeError(error);
      // Forget the mark so the next status poll (a new request object) retries this load.
      lastLoad = null;
    } finally {
      // An aborted load leaves `loading` to the load that replaced it.
      if (inflight === controller) {
        inflight = null;
        loading = false;
      }
    }
  }

  onMount(() => {
    const poller = startPolling({ intervalMs: POLL_INTERVAL_MS, tick: refreshStatus, onError: onPollError });
    // Timers in a background tab are throttled: refresh as soon as the tab is visible again.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') poller.runNow();
    };
    // Back and Forward restore an earlier view; each range change pushed its own entry.
    const onPopState = (): void => {
      view = parseViewState(window.location.search);
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('popstate', onPopState);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('popstate', onPopState);
      poller.stop();
    };
  });

  $effect(() => {
    const search = serializeViewState(view);
    const wanted = search.length > 0 ? `?${search}` : '';
    const action = historyAction(window.location.search, wanted);
    if (action === 'none') return;
    const url = wanted.length > 0 ? wanted : window.location.pathname;
    if (action === 'push') window.history.pushState(null, '', url);
    else window.history.replaceState(window.history.state, '', url);
  });

  $effect(() => {
    if (request === null) return;
    const mark: LoadMark = { key: request.key, version: dataVersion };
    if (decideLoad(lastLoad, mark, pointerOnChart) !== 'load') return;
    lastLoad = mark;
    void loadData(request);
  });

  function setPreset(preset: RangePreset): void {
    view = withPreset(view, preset);
  }

  function setCustomRange(from: Day, to: Day): void {
    view = withCustomRange(view, from, to);
  }

  function setSettings(patch: Partial<ViewSettings>): void {
    view = withSettings(view, patch);
  }

  function shiftBy(direction: ShiftDirection): void {
    if (range === null || status === null || filters === null) return;
    const next = shiftRange(view.range, range, direction, { today: status.today, firstDay: filters.bounds.firstDay });
    if (next !== null) view = withShiftedRange(view, next, status.today);
  }
</script>

<div class="page">
  <StatusBar {status} {apiDown} />
  <main class="body">
    {#if status === null || filters === null || range === null}
      <EmptyState kind={loadError === null ? 'loading' : 'error'} {status} message={loadError} />
    {:else if empty !== null && status.data.rows === 0}
      <EmptyState kind={empty} {status} message={null} />
    {:else}
      <FilterBar
        view={shown}
        {range}
        today={status.today}
        firstDay={filters.bounds.firstDay}
        models={shownModels}
        projects={filters.projects}
        clients={filters.clients}
        onPreset={setPreset}
        onCustomRange={setCustomRange}
        onSettings={setSettings}
        onShift={shiftBy}
      />
      {#if loadError !== null}
        <p class="load-error" role="alert">⚠ {loadError}</p>
      {/if}
      {#if empty !== null}
        <EmptyState kind={empty} {status} message={`${range.from} → ${range.to}`} />
      {:else if overview !== null && sessions !== null}
        <section class="hero" aria-busy={loading}>
          <div class="side">
            <SpendHero {overview} unit={view.unit} rangeText={rangeLabel(view, range)} firstDay={filters.bounds.firstDay} />
            {#if limitBlocks.length > 0}
              <RateLimits views={limitBlocks} />
            {/if}
          </div>
          <Timeline
            series={overview.series}
            bucket={overview.range.bucket}
            stack={shown.stack}
            stacks={visibleStacks(available)}
            unit={view.unit}
            cumulative={view.cumulative}
            dayAllowed={dayBucketAllowed(range)}
            hourAllowed={hourBucketAllowed(range)}
            onStack={(stack) => setSettings({ stack })}
            onBucket={(bucket) => setSettings({ bucket })}
            onCumulative={(cumulative) => setSettings({ cumulative })}
            onBrush={(picked) => setCustomRange(picked.from, picked.to)}
            onPointer={(inside) => (pointerOnChart = inside)}
          />
        </section>
        <section class="row2">
          <TokenTypes totals={overview.totals} />
          <ModelsTable rows={overview.byModel} />
        </section>
        <ProjectsTable
          rows={overview.byProject}
          selected={view.projects}
          onToggle={(id) => setSettings({ projects: toggleProject(view.projects, id) })}
        />
        <SessionsTable data={sessions} sort={view.sort} timeZone={status.tz} onSort={(sort) => setSettings({ sort })} />
      {/if}
    {/if}
  </main>
  <Footer {status} />
</div>

<style>
  .body {
    flex: 1;
  }

  .hero {
    display: grid;
    grid-template-columns: 290px minmax(0, 1fr);
    gap: 20px;
    padding: 16px 18px 6px;
    transition: opacity 0s;
  }

  /* Dims only when a load takes longer than 250ms, so fast local loads never flicker; undimming is immediate. */
  .hero[aria-busy='true'] {
    opacity: 0.55;
    transition: opacity 0s linear 250ms;
  }

  .side {
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-width: 0;
  }

  .row2 {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 22px;
    padding: 14px 18px;
    border-top: 1px solid var(--line);
  }

  .load-error {
    margin: 0;
    padding: 6px 18px;
    color: var(--err);
    border-bottom: 1px solid var(--line);
  }

  @media (max-width: 1023px) {
    .hero,
    .row2 {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
