<script lang="ts">
  import { deserialize, enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { invalidate } from '$app/navigation';
  import { page } from '$app/state';
  import MapUploadForm from '$lib/components/overworld/MapUploadForm.svelte';
  import MapViewport from '$lib/components/overworld/MapViewport.svelte';
  import PinLayer from '$lib/components/overworld/PinLayer.svelte';
  import PinPanel from '$lib/components/overworld/PinPanel.svelte';
  import RouteLayer from '$lib/components/overworld/RouteLayer.svelte';
  import RoutePanel from '$lib/components/overworld/RoutePanel.svelte';
  import { formatDistance, legMiles, milesAcrossFromCalibration, nearestLeg, routeMiles } from '$lib/overworld/geometry';
  import { COLOURS, DEFAULT_PIN_COLOUR, DEFAULT_PIN_ICON, ICONS, PARTY_GLYPH, type OverworldColour, type OverworldIcon } from '$lib/overworld/palette';
  import { subscribeTopic } from '$lib/stores/liveUpdates';
  import type { OverworldVisibility, PinDraft, Pt } from '$lib/types/overworld';

  let { data } = $props();

  const view = $derived(data.view);
  const map = $derived(view.map);
  const dims = $derived({ width: map.imageWidth, height: map.imageHeight });
  const embed = $derived(page.url.searchParams.get('embed') === '1');
  const listHref = $derived(`/campaigns/${data.campaignId}/overworld${embed ? '?embed=1' : ''}`);
  // The settings forms post to the list page's actions.
  const listActions = $derived(`/campaigns/${data.campaignId}/overworld`);

  let viewport = $state<ReturnType<typeof MapViewport> | null>(null);

  // What the next tap on the map does.
  type Mode = { type: 'idle' } | { type: 'place'; kind: 'pin' | 'party' } | { type: 'move'; pinId: string };
  let mode = $state<Mode>({ type: 'idle' });
  let selectedId = $state<string | null>(null);
  let editing = $state(false);
  let draft = $state<(PinDraft & { x: number; y: number }) | null>(null);
  let busy = $state(false);
  let message = $state('');
  let listOpen = $state(false);
  // Result of the map settings forms (which post to the list page's actions).
  let settingsMessage = $state('');
  const settingsEnhance: SubmitFunction = () => async ({ result, update }) => {
    settingsMessage = result.type === 'failure' ? String(result.data?.error ?? 'That did not work.') : result.type === 'success' ? 'Saved.' : '';
    await update();
  };

  const selected = $derived(view.pins.find((p) => p.id === selectedId) ?? null);
  const partyPins = $derived(view.pins.filter((p) => p.kind === 'party'));
  const otherPins = $derived(view.pins.filter((p) => p.kind !== 'party'));

  // The pin being looked at was deleted (here or by someone else).
  $effect(() => {
    if (selectedId && !selected) {
      selectedId = null;
      editing = false;
      message = 'That was just deleted.';
    }
  });

  // ---- Remembered colour / icon for the next new pin ----
  const STYLE_KEY = 'overworld-pin-style';
  function lastStyle(): { colour: OverworldColour; icon: OverworldIcon } {
    try {
      const saved = JSON.parse(localStorage.getItem(STYLE_KEY) ?? 'null');
      if (saved && saved.colour in COLOURS && saved.icon in ICONS) return saved;
    } catch {
      // fall through to the defaults
    }
    return { colour: DEFAULT_PIN_COLOUR, icon: DEFAULT_PIN_ICON };
  }

  // ---- Talking to the server actions (no form element: the tap itself is the input) ----
  async function post(action: string, fields: Record<string, string>, base = ''): Promise<{ ok: boolean; data: any; status: number }> {
    const body = new FormData();
    for (const [key, value] of Object.entries(fields)) body.set(key, value);
    busy = true;
    message = '';
    try {
      const response = await fetch(`${base}?/${action}`, { method: 'POST', body, headers: { 'x-sveltekit-action': 'true' } });
      // An expired session redirects the fetch to the login page, which is HTML, not an action result.
      if (response.redirected && new URL(response.url).pathname === '/login') {
        message = 'login';
        return { ok: false, data: null, status: 0 };
      }
      const result = deserialize(await response.text());
      if (result.type === 'redirect') {
        message = 'login';
        return { ok: false, data: null, status: 0 };
      }
      if (result.type === 'success') {
        await invalidate('overworld:map');
        return { ok: true, data: result.data, status: 200 };
      }
      message = result.type === 'failure' ? String(result.data?.error ?? 'That did not work.') : 'Something went wrong, please try again.';
      // A failed action usually means the data is stale (deleted, rights changed): refresh it.
      await invalidate('overworld:map');
      return { ok: false, data: null, status: result.type === 'failure' ? result.status : 500 };
    } catch {
      message = 'Could not reach the server.';
      return { ok: false, data: null, status: 0 };
    } finally {
      busy = false;
    }
  }

  // ---- Routes: tracing ----
  // Same feel as VTT movement: tap to add waypoints, a preview leg follows the mouse, undo the last
  // point (button, right-click, Backspace), Save (button or Enter), Cancel (button or Esc).
  // 'measure' reuses the tracer to tap both ends of the map's scale bar.
  type Trace = {
    mode: 'route' | 'measure';
    points: Pt[];
    hover: Pt | null;
    // Continuing a saved route: points[0] is its current end.
    continueOf: { routeId: string; colour: OverworldColour } | null;
  };
  const SAME_POINT = 1e-6;
  const VIS_KEY = 'overworld-route-visibility';
  const COLOUR_KEY = 'overworld-route-colour';
  // Screen pixels: a finger is much less precise than a mouse.
  const HIT_TOLERANCE_MOUSE_PX = 12;
  const HIT_TOLERANCE_TOUCH_PX = 20;

  let trace = $state<Trace | null>(null);
  let savingRoute = $state(false);
  let measureMiles = $state('');
  let routeVisibility = $state<OverworldVisibility>('everyone');
  try {
    if (localStorage.getItem(VIS_KEY) === 'private') routeVisibility = 'private';
  } catch {
    // no storage (server render or blocked): keep the default
  }
  function lastRouteColour(): OverworldColour {
    try {
      const saved = localStorage.getItem(COLOUR_KEY);
      if (saved && saved in COLOURS) return saved as OverworldColour;
    } catch {
      // fall through
    }
    return 'white';
  }

  let selectedLeg = $state<{ routeId: string; legId: string } | null>(null);
  const selectedRoute = $derived(view.routes.find((r) => r.id === selectedLeg?.routeId) ?? null);

  // The route (or leg) being looked at was deleted by someone else.
  $effect(() => {
    if (selectedLeg && !selectedRoute) {
      selectedLeg = null;
      message = 'That was just deleted.';
    } else if (selectedLeg && selectedRoute && !selectedRoute.legs.some((l) => l.id === selectedLeg!.legId)) {
      selectedLeg = null;
    }
  });

  const legsOf = (points: Pt[]) => points.slice(0, -1).map((p, i) => ({ x1: p.x, y1: p.y, x2: points[i + 1].x, y2: points[i + 1].y }));
  const traceMiles = $derived(trace && trace.mode === 'route' ? routeMiles(legsOf(trace.points), dims, map.milesAcross) : null);
  const traceText = $derived(trace && trace.mode === 'route' ? (trace.points.length > 1 ? formatDistance(traceMiles) || `${trace.points.length - 1} legs` : '') : '');

  function startTrace(kind: 'route' | 'measure') {
    draft = null;
    selectedId = null;
    selectedLeg = null;
    editing = false;
    mode = { type: 'idle' };
    savingRoute = false;
    measureMiles = '';
    trace = { mode: kind, points: [], hover: null, continueOf: null };
  }

  function cancelTrace() {
    trace = null;
    savingRoute = false;
  }

  function traceTap(point: Pt) {
    if (!trace || savingRoute) return;
    if (trace.mode === 'measure') {
      // Two points only: a third tap starts over.
      trace.points = trace.points.length >= 2 ? [point] : [...trace.points, point];
      return;
    }
    const last = trace.points[trace.points.length - 1];
    if (last && Math.abs(last.x - point.x) < SAME_POINT && Math.abs(last.y - point.y) < SAME_POINT) return;
    if (trace.points.length >= 201) {
      message = 'A route can have up to 200 legs.';
      return;
    }
    trace.points = [...trace.points, point];
  }

  function undoTrace() {
    if (!trace || savingRoute) return;
    // When continuing, the first point is the route's end and stays.
    const keep = trace.continueOf ? 1 : 0;
    if (trace.points.length > keep) trace.points = trace.points.slice(0, -1);
  }

  async function saveTrace() {
    if (!trace || busy) return;
    if (trace.mode === 'measure') return saveMeasure();
    if (trace.points.length < 2) {
      message = 'Add at least two points first.';
      return;
    }
    if (trace.continueOf) {
      const result = await post('continueRoute', { routeId: trace.continueOf.routeId, points: JSON.stringify(trace.points) });
      // On success, or when the route changed under us (409: the message and a refresh are already done), the trace is over.
      // (A 404 or 403 means the route is gone or no longer yours to extend, so the trace is over too.)
      if (result.ok || result.status === 409 || result.status === 404 || result.status === 403) trace = null;
      return;
    }
    savingRoute = true;
  }

  async function submitNewRoute(values: { label: string; colour: OverworldColour }) {
    if (!trace) return;
    const result = await post('saveRoute', {
      points: JSON.stringify(trace.points),
      label: values.label,
      colour: values.colour,
      visibility: routeVisibility
    });
    if (result.ok) {
      try {
        localStorage.setItem(COLOUR_KEY, values.colour);
      } catch {
        // not important
      }
      trace = null;
      savingRoute = false;
    }
  }

  // Scale calibration: the two tapped points and the typed miles give "miles across the map's width".
  async function saveMeasure() {
    if (!trace || trace.points.length < 2) {
      message = 'Tap both ends of the scale bar first.';
      return;
    }
    const miles = Number(measureMiles);
    const across = milesAcrossFromCalibration(trace.points[0], trace.points[1], miles, dims);
    if (across === null) {
      message = 'Enter how many miles the two points are apart (more than zero, and not the same spot).';
      return;
    }
    const result = await post('updateMap', { mapId: map.id, name: map.name, milesAcross: String(across) }, listActions);
    if (result.ok) trace = null;
  }

  function setRouteVisibility(value: OverworldVisibility) {
    routeVisibility = value;
    try {
      localStorage.setItem(VIS_KEY, value);
    } catch {
      // not important
    }
  }

  // Keyboard, desktop only (touch has the buttons): ignored while typing in a field.
  function onkeydown(e: KeyboardEvent) {
    if (!trace) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      undoTrace();
    } else if (e.key === 'Enter') {
      // A focused button or link keeps its own Enter behaviour.
      if (target?.closest('button, a, [role="button"]')) return;
      e.preventDefault();
      if (!savingRoute) void saveTrace();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelTrace();
    }
  }

  // ---- Routes: saved ones ----
  function routeLegText(): string {
    if (!selectedRoute || !selectedLeg) return '';
    const index = selectedRoute.legs.findIndex((l) => l.id === selectedLeg!.legId);
    if (index < 0) return '';
    const leg = selectedRoute.legs[index];
    const miles = legMiles({ x: leg.x1, y: leg.y1 }, { x: leg.x2, y: leg.y2 }, dims, map.milesAcross);
    return `Leg ${index + 1} of ${selectedRoute.legs.length}${miles === null ? '' : ' - ' + formatDistance(miles)}`;
  }
  function routeTotalText(): string {
    if (!selectedRoute) return '';
    const total = formatDistance(routeMiles(selectedRoute.legs, dims, map.milesAcross));
    return `${selectedRoute.label || 'Route'}${total ? ' - ' + total : ''}`;
  }

  async function deleteLeg() {
    if (!selectedLeg || !confirm('Delete this leg?')) return;
    const { routeId, legId } = selectedLeg;
    selectedLeg = null;
    await post('deleteLeg', { routeId, legId });
  }
  async function deleteWholeRoute() {
    if (!selectedLeg || !confirm('Delete the whole route?')) return;
    const routeId = selectedLeg.routeId;
    selectedLeg = null;
    await post('deleteRoute', { routeId });
  }
  async function updateRouteFields(values: { label: string; colour: OverworldColour; visibility?: OverworldVisibility }): Promise<boolean> {
    if (!selectedLeg) return false;
    const fields: Record<string, string> = { routeId: selectedLeg.routeId, label: values.label, colour: values.colour };
    if (values.visibility) fields.visibility = values.visibility;
    return (await post('updateRoute', fields)).ok;
  }
  function continueRoute() {
    if (!selectedRoute || selectedRoute.legs.length === 0) return;
    const end = selectedRoute.legs[selectedRoute.legs.length - 1];
    const routeId = selectedRoute.id;
    const colour = selectedRoute.colour;
    selectedLeg = null;
    trace = { mode: 'route', points: [{ x: end.x2, y: end.y2 }], hover: null, continueOf: { routeId, colour } };
  }

  // ---- Map taps ----
  function ontap(point: { x: number; y: number }, zoom: number, pointerType: string) {
    if (trace) {
      traceTap(point);
      return;
    }
    if (mode.type === 'place') {
      const style = lastStyle();
      draft = {
        x: point.x,
        y: point.y,
        kind: mode.kind,
        label: '',
        note: '',
        colour: style.colour,
        icon: style.icon,
        visibility: 'everyone'
      };
      selectedId = null;
      mode = { type: 'idle' };
    } else if (mode.type === 'move') {
      const pinId = mode.pinId;
      mode = { type: 'idle' };
      void post('movePin', { pinId, x: String(point.x), y: String(point.y) });
    } else {
      // Nothing armed: a tap near a route leg selects it, otherwise it clears the selection.
      const hit = nearestLeg(view.routes, point, dims, (pointerType === 'mouse' ? HIT_TOLERANCE_MOUSE_PX : HIT_TOLERANCE_TOUCH_PX) / zoom);
      selectedId = null;
      editing = false;
      message = '';
      selectedLeg = hit ? { routeId: hit.routeId, legId: hit.legId } : null;
    }
  }

  function arm(kind: 'pin' | 'party') {
    if (trace) return;
    draft = null;
    selectedLeg = null;
    selectedId = null;
    mode = mode.type === 'place' && mode.kind === kind ? { type: 'idle' } : { type: 'place', kind };
  }

  function select(id: string) {
    if (mode.type === 'move' || trace) return;
    selectedLeg = null;
    draft = null;
    editing = false;
    selectedId = id;
    message = '';
  }

  async function save(values: PinDraft) {
    if (draft) {
      const fields: Record<string, string> = {
        x: String(draft.x),
        y: String(draft.y),
        kind: values.kind,
        label: values.label,
        note: values.note,
        colour: values.colour,
        icon: values.icon,
        visibility: values.visibility
      };
      const result = await post('addPin', fields);
      if (result.ok) {
        try {
          localStorage.setItem(STYLE_KEY, JSON.stringify({ colour: values.colour, icon: values.icon }));
        } catch {
          // not important
        }
        draft = null;
        selectedId = result.data?.pinId ?? null;
      }
    } else if (selected) {
      const fields: Record<string, string> = { pinId: selected.id, label: values.label, note: values.note, colour: values.colour, icon: values.icon };
      // Only send visibility when this viewer may change it (the server refuses it otherwise).
      if (selected.canChangeVisibility) fields.visibility = values.visibility;
      const result = await post('updatePin', fields);
      if (result.ok) editing = false;
    }
  }

  async function remove() {
    if (!selected || !confirm('Delete this pin?')) return;
    const id = selected.id;
    // Deselect first, so the "just deleted" notice is only for deletions made by someone else.
    selectedId = null;
    editing = false;
    await post('deletePin', { pinId: id });
  }

  function startMove() {
    if (!selected) return;
    mode = { type: 'move', pinId: selected.id };
    editing = false;
  }

  // ---- Party button: centre on each party pin in turn ----
  let partyIndex = 0;
  function cycleParty() {
    if (partyPins.length === 0) return;
    const pin = partyPins[partyIndex % partyPins.length];
    partyIndex += 1;
    viewport?.centerOn(pin);
    selectedId = pin.id;
    draft = null;
    editing = false;
  }

  function focusPin(id: string) {
    const pin = view.pins.find((p) => p.id === id);
    if (!pin) return;
    viewport?.centerOn(pin);
    select(id);
  }

  // ---- Live refresh ----
  // Anyone changing the map pings this topic (no content, just "re-fetch"). Debounced, and the first
  // resync on connect is skipped because the page has just loaded.
  $effect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let first = true;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void invalidate('overworld:map'), 300);
    };
    const stop = subscribeTopic(`overworld:${data.campaignId}`, {
      onMessage: (msg) => {
        if (msg.type === 'overworld:changed') refresh();
      },
      onResync: () => {
        if (first) first = false;
        else refresh();
      }
    });
    return () => {
      clearTimeout(timer);
      stop();
    };
  });

  const placing = $derived(mode.type === 'place' || mode.type === 'move');
  const banner = $derived(
    mode.type === 'place'
      ? mode.kind === 'party'
        ? 'Tap the map to place the party pin'
        : 'Tap the map to place the pin'
      : mode.type === 'move'
        ? 'Tap the map to move the pin'
        : ''
  );
</script>

<svelte:window {onkeydown} />

<div class="ow-page">
  <div class="ow-toolbar">
    {#if !embed}<a class="button-link compact-link" href={listHref}>Maps</a>{:else}<a class="button-link compact-link" href={listHref}>All maps</a>{/if}
    <strong class="ow-title">{map.name}</strong>
    <span class="ow-toolbar-buttons">
      <button type="button" class="compact-button" onclick={() => viewport?.zoomBy(1 / 1.4)} aria-label="Zoom out">-</button>
      <button type="button" class="compact-button" onclick={() => viewport?.zoomBy(1.4)} aria-label="Zoom in">+</button>
      <button type="button" class="compact-button" onclick={() => viewport?.fit()}>Fit</button>
      {#if partyPins.length > 0}<button type="button" class="compact-button" onclick={cycleParty}>Party</button>{/if}
      {#if view.viewer.canCreatePin}<button type="button" class="compact-button" class:active={trace?.mode === 'route'} onclick={() => (trace?.mode === 'route' ? cancelTrace() : startTrace('route'))}>Draw route</button>{/if}
      {#if view.viewer.canCreatePin}<button type="button" class="compact-button" class:active={mode.type === 'place' && mode.kind === 'pin'} onclick={() => arm('pin')}>Add pin</button>{/if}
      {#if view.viewer.canCreateParty}<button type="button" class="compact-button" class:active={mode.type === 'place' && mode.kind === 'party'} onclick={() => arm('party')}>Party pin</button>{/if}
      {#if view.viewer.canManage}<button type="button" class="compact-button" class:active={trace?.mode === 'measure'} onclick={() => (trace?.mode === 'measure' ? cancelTrace() : startTrace('measure'))}>Scale</button>{/if}
      <button type="button" class="compact-button" onclick={() => (listOpen = !listOpen)}>List</button>
    </span>
  </div>

  {#if banner}
    <p class="ow-banner">
      {banner}
      <button type="button" class="compact-button" onclick={() => (mode = { type: 'idle' })}>Cancel</button>
    </p>
  {/if}
  {#if trace}
    <div class="ow-banner ow-trace-banner">
      {#if trace.mode === 'measure'}
        <span>
          {#if trace.points.length < 2}Tap both ends of the map's scale bar ({trace.points.length}/2){:else}Miles between the two points:{/if}
        </span>
        {#if trace.points.length >= 2}
          <input
            class="ow-miles"
            bind:value={measureMiles}
            inputmode="decimal"
            placeholder="miles"
            aria-label="Miles between the two points"
            onkeydown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void saveMeasure();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelTrace();
              }
            }}
          />
        {/if}
      {:else if trace.points.length === 0 || (trace.continueOf && trace.points.length === 1)}
        <span>{trace.continueOf ? 'Tap the map to continue the route' : 'Tap the map to start the route'}</span>
      {:else}
        <strong>{traceText}</strong>
      {/if}
      {#if trace.mode === 'route' && !trace.continueOf}
        <select value={routeVisibility} onchange={(e) => setRouteVisibility(e.currentTarget.value as OverworldVisibility)} aria-label="Who sees this route">
          <option value="everyone">Everyone</option>
          <option value="private">Only me</option>
        </select>
      {/if}
      <button type="button" class="compact-button" onclick={undoTrace} disabled={savingRoute || trace.points.length <= (trace.continueOf ? 1 : 0)}>Undo</button>
      <button type="button" class="compact-button active" onclick={saveTrace} disabled={busy || savingRoute}>Save</button>
      <button type="button" class="compact-button" onclick={cancelTrace}>Cancel</button>
    </div>
  {/if}
  {#if message === 'login'}
    <p class="form-error ow-message">Your login has expired - please <a href="/login?next={encodeURIComponent(page.url.pathname + page.url.search)}">log in again</a>.</p>
  {:else if message}
    <p class="form-error ow-message">{message}</p>
  {/if}

  <div class="ow-stage">
    <MapViewport bind:this={viewport} imageUrl={map.imageUrl} {dims} mapId={map.id} armed={placing || trace !== null} {ontap} onhover={(p) => { if (trace && !savingRoute) trace.hover = p; }} oncontext={(e) => { if (trace) { e.preventDefault(); if ((e as PointerEvent).pointerType !== 'touch') undoTrace(); } }}>
      {#snippet overlay({ toScreen })}
        <RouteLayer
          routes={view.routes}
          {toScreen}
          selectedRouteId={selectedLeg?.routeId ?? null}
          selectedLegId={selectedLeg?.legId ?? null}
          tracing={trace
            ? {
                points: trace.points,
                hover: trace.hover,
                colour: trace.mode === 'measure' ? '#f5d90a' : trace.continueOf ? COLOURS[trace.continueOf.colour].hex : '#ffffff',
                label: traceText
              }
            : null}
        />
        <PinLayer pins={view.pins} {toScreen} {selectedId} movingId={mode.type === 'move' ? mode.pinId : null} onselect={select} />
        {#if draft}
          {@const at = toScreen(draft)}
          <span class="ow-pin ow-draft" style="left: {at.x}px; top: {at.y}px; --pin: {COLOURS[draft.colour].hex}; --ink: #fff;">
            <span class="ow-pin-glyph">{draft.kind === 'party' ? PARTY_GLYPH : ICONS[draft.icon].glyph}</span>
          </span>
        {/if}
      {/snippet}
    </MapViewport>

    {#if savingRoute}
      <div class="ow-sheet">
        <RoutePanel
          mode="save"
          saveColour={lastRouteColour()}
          {busy}
          onsave={submitNewRoute}
          oncancel={() => (savingRoute = false)}
          ondeleteleg={() => {}}
          ondeleteroute={() => {}}
          oncontinue={() => {}}
          onupdate={() => false}
          onclose={() => (savingRoute = false)}
        />
      </div>
    {:else if selectedRoute && !draft && !selected}
      <div class="ow-sheet">
        {#key selectedRoute.id}
        <RoutePanel
          mode="details"
          route={selectedRoute}
          legText={routeLegText()}
          routeText={routeTotalText()}
          {busy}
          onsave={() => {}}
          oncancel={() => {}}
          ondeleteleg={deleteLeg}
          ondeleteroute={deleteWholeRoute}
          oncontinue={continueRoute}
          onupdate={updateRouteFields}
          onclose={() => (selectedLeg = null)}
        />
        {/key}
      </div>
    {/if}

    {#if draft || selected}
      <div class="ow-sheet">
        <PinPanel
          pin={draft ? null : selected}
          draft={draft}
          {editing}
          {busy}
          onsave={save}
          oncancel={() => {
            draft = null;
            editing = false;
          }}
          onedit={() => (editing = true)}
          onmove={startMove}
          ondelete={remove}
          onclose={() => (selectedId = null)}
        />
      </div>
    {/if}
  </div>

  {#if listOpen}
    <div class="panel ow-list">
      {#if view.pins.length === 0}
        <p class="muted">No pins yet.</p>
      {/if}
      {#if partyPins.length > 0}
        <h3>Party</h3>
        <ul class="ow-list-items">
          {#each partyPins as pin (pin.id)}
            <li><button type="button" class="text-button" onclick={() => focusPin(pin.id)}>{PARTY_GLYPH} {pin.label || 'Party'}</button></li>
          {/each}
        </ul>
      {/if}
      {#if otherPins.length > 0}
        <h3>Pins</h3>
        <ul class="ow-list-items">
          {#each otherPins as pin (pin.id)}
            <li>
              <button type="button" class="text-button" onclick={() => focusPin(pin.id)}>
                <span class="ow-dot" style="background: {COLOURS[pin.colour].hex}"></span>
                {pin.label || 'Pin'}
              </button>
              {#if pin.visibility === 'private'}<span class="badge badge-muted">Private</span>{/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}

  {#if view.viewer.canManage}
    <details class="panel campaign-panel ow-settings-card">
      <summary>Map settings</summary>
      <div class="ow-settings">
        {#if settingsMessage}<p class="muted">{settingsMessage}</p>{/if}
        <form method="POST" action="{listActions}?/updateMap" use:enhance={settingsEnhance}>
          <input type="hidden" name="mapId" value={map.id} />
          <label>
            Name
            <input name="name" maxlength="80" value={map.name} required />
          </label>
          <label>
            Miles across the width
            <input name="milesAcross" inputmode="decimal" value={map.milesAcross ?? ''} placeholder="no scale" />
          </label>
          <button type="submit" class="compact-button">Save</button>
        </form>
        <form method="POST" action="{listActions}?/{map.grantedAt ? 'ungrant' : 'grant'}" use:enhance={settingsEnhance}>
          <input type="hidden" name="mapId" value={map.id} />
          <button type="submit" class="compact-button">{map.grantedAt ? 'Unshare from the party' : 'Share with the party'}</button>
        </form>
        <MapUploadForm
          action="{listActions}?/replaceImage"
          mapId={map.id}
          submitLabel="Replace image"
          current={{ width: map.imageWidth, height: map.imageHeight }}
        />
      </div>
    </details>
  {/if}
</div>
