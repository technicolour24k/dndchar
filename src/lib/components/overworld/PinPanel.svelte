<script lang="ts">
  import { COLOUR_KEYS, COLOURS, ICON_KEYS, ICONS, MAX_LABEL, MAX_NOTE, PARTY_GLYPH, type OverworldColour, type OverworldIcon } from '$lib/overworld/palette';
  import type { PinDraft, PinKind, PinView } from '$lib/types/overworld';

  // One panel for a pin: details with the actions the server said are allowed, or the form for a new /
  // edited pin. It never decides rights itself (the server sends canEdit / canChangeVisibility and
  // re-checks every action); it only hides buttons.
  let {
    pin = null,
    draft = null,
    editing = false,
    canChangeVisibilityNew = true,
    busy = false,
    onsave,
    oncancel,
    onedit,
    onmove,
    ondelete,
    onclose
  }: {
    // An existing pin to show (details, or its edit form when editing).
    pin?: PinView | null;
    // Starting values for a NEW pin (the placement tap already chose the position).
    draft?: PinDraft | null;
    editing?: boolean;
    canChangeVisibilityNew?: boolean;
    busy?: boolean;
    onsave: (values: PinDraft) => void;
    oncancel: () => void;
    onedit: () => void;
    onmove: () => void;
    ondelete: () => void;
    onclose: () => void;
  } = $props();

  const showForm = $derived(draft !== null || (pin !== null && editing));
  const kind = $derived<PinKind>(draft?.kind ?? pin?.kind ?? 'pin');

  // Form state, seeded from the draft or the pin being edited.
  let label = $state('');
  let note = $state('');
  let colour = $state<OverworldColour>('red');
  let icon = $state<OverworldIcon>('dot');
  let visibility = $state<PinDraft['visibility']>('everyone');

  // Seed the form once per thing being edited. A live refresh replaces the pin object with a fresh copy,
  // and that must not wipe what the user is typing.
  let seededKey = '';
  $effect(() => {
    const source = draft ?? (editing ? pin : null);
    const key = draft ? `new:${draft.kind}` : editing && pin ? pin.id : '';
    if (!source) {
      seededKey = '';
      return;
    }
    if (key === seededKey) return;
    seededKey = key;
    label = source.label;
    note = source.note;
    colour = source.colour;
    icon = source.icon;
    visibility = source.visibility;
  });

  // Visibility can only be changed by the creator or a DM; a new pin always may.
  const mayChangeVisibility = $derived(draft ? canChangeVisibilityNew : (pin?.canChangeVisibility ?? false));

  function submit(event: Event) {
    event.preventDefault();
    onsave({ kind, label, note, colour, icon, visibility });
  }
</script>

<div class="ow-panel">
  {#if showForm}
    <form onsubmit={submit} class="ow-pin-form">
      <strong>{draft ? (kind === 'party' ? 'New party pin' : 'New pin') : 'Edit pin'}</strong>
      <label>
        Label
        <input bind:value={label} maxlength={MAX_LABEL} />
      </label>
      <label>
        Note (shown on hover)
        <textarea bind:value={note} rows="3" maxlength={MAX_NOTE}></textarea>
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
      {#if kind === 'pin'}
        <div class="ow-icons" role="group" aria-label="Icon">
          {#each ICON_KEYS as key (key)}
            <button type="button" class="ow-icon" class:on={icon === key} title={ICONS[key].label} aria-label={ICONS[key].label} aria-pressed={icon === key} onclick={() => (icon = key)}>
              {ICONS[key].glyph}
            </button>
          {/each}
        </div>
      {/if}
      {#if mayChangeVisibility}
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
        <button type="button" class="compact-button" onclick={oncancel}>Cancel</button>
      </div>
    </form>
  {:else if pin}
    <div class="ow-pin-details">
      <div class="ow-pin-title">
        <span class="ow-pin-dot" style="background: {COLOURS[pin.colour].hex}">{pin.kind === 'party' ? PARTY_GLYPH : ICONS[pin.icon].glyph}</span>
        <strong>{pin.label || (pin.kind === 'party' ? 'Party' : 'Pin')}</strong>
        {#if pin.visibility === 'private'}<span class="badge badge-muted">Private</span>{/if}
        {#if pin.dmLocked && pin.kind !== 'party'}<span class="badge badge-muted">DM</span>{/if}
        <button type="button" class="compact-button" onclick={onclose} aria-label="Close">x</button>
      </div>
      {#if pin.note}<p class="ow-note">{pin.note}</p>{/if}
      {#if pin.createdByName}<p class="muted">By {pin.createdByName}</p>{/if}
      {#if pin.canEdit}
        <div class="ow-actions">
          <button type="button" class="compact-button" onclick={onedit} disabled={busy}>Edit</button>
          <button type="button" class="compact-button" onclick={onmove} disabled={busy}>Move</button>
          <button type="button" class="compact-button danger" onclick={ondelete} disabled={busy}>Delete</button>
        </div>
      {:else}
        <p class="muted">{pin.dmLocked ? 'Only a DM can change this pin.' : ''}</p>
      {/if}
    </div>
  {/if}
</div>
