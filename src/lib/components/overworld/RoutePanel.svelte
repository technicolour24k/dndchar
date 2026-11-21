<script lang="ts">
  import { COLOUR_KEYS, COLOURS, MAX_LABEL, type OverworldColour } from '$lib/overworld/palette';
  import type { OverworldVisibility, RouteView } from '$lib/types/overworld';

  // The route sheet: either the "save this route" form (label + colour), or the details of a tapped
  // leg with the actions the server said are allowed (canEdit) and an edit form. It only hides
  // buttons; the server re-checks every action.
  let {
    mode,
    route = null,
    legText = '',
    routeText = '',
    saveColour = 'white',
    busy = false,
    onsave,
    oncancel,
    ondeleteleg,
    ondeleteroute,
    oncontinue,
    onupdate,
    onclose
  }: {
    mode: 'save' | 'details';
    // The route shown in 'details'.
    route?: RouteView | null;
    // "Leg 3 of 5 - 4.2 mi" and "Road - 38 mi - about 1.5 days" (the page works these out).
    legText?: string;
    routeText?: string;
    // Colour pre-selected in the save form (the last one used).
    saveColour?: OverworldColour;
    busy?: boolean;
    onsave: (values: { label: string; colour: OverworldColour }) => void;
    oncancel: () => void;
    ondeleteleg: () => void;
    ondeleteroute: () => void;
    oncontinue: () => void;
    // Resolves true when the server accepted the change (the form closes only then).
    onupdate: (values: { label: string; colour: OverworldColour; visibility?: OverworldVisibility }) => Promise<boolean> | boolean;
    onclose: () => void;
  } = $props();

  let editing = $state(false);
  let label = $state('');
  let colour = $state<OverworldColour>('white');
  let visibility = $state<OverworldVisibility>('everyone');

  // Seed once per route / mode, so a live refresh cannot wipe what is being typed.
  let seededKey = '';
  $effect(() => {
    const key = mode === 'save' ? 'save' : editing && route ? route.id : '';
    if (!key) {
      seededKey = '';
      return;
    }
    if (key === seededKey) return;
    seededKey = key;
    if (mode === 'save') {
      label = '';
      colour = saveColour;
    } else if (route) {
      label = route.label;
      colour = route.colour;
      visibility = route.visibility;
    }
  });

  function submitSave(event: Event) {
    event.preventDefault();
    onsave({ label, colour });
  }
  async function submitEdit(event: Event) {
    event.preventDefault();
    const ok = await onupdate({ label, colour, visibility: route?.canChangeVisibility ? visibility : undefined });
    if (ok) editing = false;
  }
</script>

<div class="ow-panel">
  {#if mode === 'save' || editing}
    <form onsubmit={mode === 'save' ? submitSave : submitEdit} class="ow-pin-form">
      <strong>{mode === 'save' ? 'Save route' : 'Edit route'}</strong>
      <label>
        Label (optional)
        <input bind:value={label} maxlength={MAX_LABEL} />
      </label>
      <div class="ow-swatches" role="group" aria-label="Colour">
        {#each COLOUR_KEYS as key (key)}
          <button
            type="button"
            class="ow-swatch"
            class:on={colour === key}
            style="background: {COLOURS[key].hex}"
            title={COLOURS[key].label}
            aria-label={COLOURS[key].label}
            aria-pressed={colour === key}
            onclick={() => (colour = key)}
          ></button>
        {/each}
      </div>
      {#if mode === 'details' && route?.canChangeVisibility}
        <label>
          Visibility
          <select bind:value={visibility}>
            <option value="everyone">Everyone</option>
            <option value="private">Only me (and the DMs)</option>
          </select>
        </label>
      {/if}
      <div class="ow-actions">
        <button type="submit" class="compact-button" disabled={busy}>Save</button>
        <button type="button" class="compact-button" onclick={mode === 'save' ? oncancel : () => (editing = false)}>Cancel</button>
      </div>
    </form>
  {:else if route}
    <div class="ow-pin-details">
      <div class="ow-pin-title">
        <span class="ow-pin-dot" style="background: {COLOURS[route.colour].hex}"></span>
        <strong>{route.label || 'Route'}</strong>
        {#if route.visibility === 'private'}<span class="badge badge-muted">Private</span>{/if}
        {#if route.dmLocked}<span class="badge badge-muted">DM</span>{/if}
        <button type="button" class="compact-button" onclick={onclose} aria-label="Close">x</button>
      </div>
      {#if legText}<p class="ow-note">{legText}</p>{/if}
      {#if routeText}<p class="ow-note">{routeText}</p>{/if}
      {#if route.createdByName}<p class="muted">By {route.createdByName}</p>{/if}
      {#if route.canEdit}
        <div class="ow-actions">
          <button type="button" class="compact-button" onclick={oncontinue} disabled={busy}>Continue</button>
          <button type="button" class="compact-button" onclick={() => (editing = true)} disabled={busy}>Edit route</button>
          <button type="button" class="compact-button danger" onclick={ondeleteleg} disabled={busy}>Delete leg</button>
          <button type="button" class="compact-button danger" onclick={ondeleteroute} disabled={busy}>Delete route</button>
        </div>
      {:else}
        <p class="muted">{route.dmLocked ? 'Only a DM can change this route.' : ''}</p>
      {/if}
    </div>
  {/if}
</div>
