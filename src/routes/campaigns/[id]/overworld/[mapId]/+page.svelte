<script lang="ts">
  import { deserialize, enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { invalidate } from '$app/navigation';
  import { page } from '$app/state';
  import MapUploadForm from '$lib/components/overworld/MapUploadForm.svelte';
  import MapViewport from '$lib/components/overworld/MapViewport.svelte';
  import PinLayer from '$lib/components/overworld/PinLayer.svelte';
  import PinPanel from '$lib/components/overworld/PinPanel.svelte';
  import { COLOURS, DEFAULT_PIN_COLOUR, DEFAULT_PIN_ICON, ICONS, PARTY_GLYPH, type OverworldColour, type OverworldIcon } from '$lib/overworld/palette';
  import { subscribeTopic } from '$lib/stores/liveUpdates';
  import type { PinDraft } from '$lib/types/overworld';

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
  async function post(action: string, fields: Record<string, string>): Promise<{ ok: boolean; data: any }> {
    const body = new FormData();
    for (const [key, value] of Object.entries(fields)) body.set(key, value);
    busy = true;
    message = '';
    try {
      const response = await fetch(`?/${action}`, { method: 'POST', body, headers: { 'x-sveltekit-action': 'true' } });
      // An expired session redirects the fetch to the login page, which is HTML, not an action result.
      if (response.redirected && new URL(response.url).pathname === '/login') {
        message = 'login';
        return { ok: false, data: null };
      }
      const result = deserialize(await response.text());
      if (result.type === 'redirect') {
        message = 'login';
        return { ok: false, data: null };
      }
      if (result.type === 'success') {
        await invalidate('overworld:map');
        return { ok: true, data: result.data };
      }
      message = result.type === 'failure' ? String(result.data?.error ?? 'That did not work.') : 'Something went wrong, please try again.';
      // A failed action usually means the data is stale (deleted, rights changed): refresh it.
      await invalidate('overworld:map');
      return { ok: false, data: null };
    } catch {
      message = 'Could not reach the server.';
      return { ok: false, data: null };
    } finally {
      busy = false;
    }
  }

  // ---- Map taps ----
  function ontap(point: { x: number; y: number }) {
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
      selectedId = null;
      editing = false;
      message = '';
    }
  }

  function arm(kind: 'pin' | 'party') {
    draft = null;
    selectedId = null;
    mode = mode.type === 'place' && mode.kind === kind ? { type: 'idle' } : { type: 'place', kind };
  }

  function select(id: string) {
    if (mode.type === 'move') return;
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

<div class="ow-page">
  <div class="ow-toolbar">
    {#if !embed}<a class="button-link compact-link" href={listHref}>Maps</a>{:else}<a class="button-link compact-link" href={listHref}>All maps</a>{/if}
    <strong class="ow-title">{map.name}</strong>
    <span class="ow-toolbar-buttons">
      <button type="button" class="compact-button" onclick={() => viewport?.zoomBy(1 / 1.4)} aria-label="Zoom out">-</button>
      <button type="button" class="compact-button" onclick={() => viewport?.zoomBy(1.4)} aria-label="Zoom in">+</button>
      <button type="button" class="compact-button" onclick={() => viewport?.fit()}>Fit</button>
      {#if partyPins.length > 0}<button type="button" class="compact-button" onclick={cycleParty}>Party</button>{/if}
      {#if view.viewer.canCreatePin}<button type="button" class="compact-button" class:active={mode.type === 'place' && mode.kind === 'pin'} onclick={() => arm('pin')}>Add pin</button>{/if}
      {#if view.viewer.canCreateParty}<button type="button" class="compact-button" class:active={mode.type === 'place' && mode.kind === 'party'} onclick={() => arm('party')}>Party pin</button>{/if}
      <button type="button" class="compact-button" onclick={() => (listOpen = !listOpen)}>List</button>
    </span>
  </div>

  {#if banner}
    <p class="ow-banner">
      {banner}
      <button type="button" class="compact-button" onclick={() => (mode = { type: 'idle' })}>Cancel</button>
    </p>
  {/if}
  {#if message === 'login'}
    <p class="form-error ow-message">Your login has expired - please <a href="/login?next={encodeURIComponent(page.url.pathname + page.url.search)}">log in again</a>.</p>
  {:else if message}
    <p class="form-error ow-message">{message}</p>
  {/if}

  <div class="ow-stage">
    <MapViewport bind:this={viewport} imageUrl={map.imageUrl} {dims} mapId={map.id} armed={placing} {ontap}>
      {#snippet overlay({ toScreen })}
        <PinLayer pins={view.pins} {toScreen} {selectedId} movingId={mode.type === 'move' ? mode.pinId : null} onselect={select} />
        {#if draft}
          {@const at = toScreen(draft)}
          <span class="ow-pin ow-draft" style="left: {at.x}px; top: {at.y}px; --pin: {COLOURS[draft.colour].hex}; --ink: #fff;">
            <span class="ow-pin-glyph">{draft.kind === 'party' ? PARTY_GLYPH : ICONS[draft.icon].glyph}</span>
          </span>
        {/if}
      {/snippet}
    </MapViewport>

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
