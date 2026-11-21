<script lang="ts">
  import { COLOURS, ICONS, PARTY_GLYPH } from '$lib/overworld/palette';
  import type { PinView, Pt } from '$lib/types/overworld';

  // Draws the pins in screen space over the map. Tap targets are at least 32 px. Party pins are bigger
  // and always show their label; other pins show label and note in a tooltip on hover (desktop) and
  // open the details panel on tap. Notes are text only (Svelte escapes them), never HTML.
  let {
    pins,
    toScreen,
    selectedId = null,
    movingId = null,
    onselect
  }: {
    pins: PinView[];
    toScreen: (p: Pt) => Pt;
    selectedId?: string | null;
    movingId?: string | null;
    onselect: (id: string) => void;
  } = $props();

  // Dark glyph on the light colours.
  const inkFor = (colour: string) => (colour === 'yellow' || colour === 'white' ? '#111' : '#fff');
</script>

{#each pins as pin (pin.id)}
  {@const at = toScreen(pin)}
  {@const party = pin.kind === 'party'}
  <button
    type="button"
    class="ow-pin"
    class:party
    class:selected={pin.id === selectedId}
    class:private={pin.visibility === 'private'}
    class:moving={pin.id === movingId}
    style="left: {at.x}px; top: {at.y}px; --pin: {COLOURS[pin.colour].hex}; --ink: {inkFor(pin.colour)};"
    aria-label={pin.label || (party ? 'Party' : 'Pin')}
    onpointerdown={(e) => e.stopPropagation()}
    onpointerup={(e) => e.stopPropagation()}
    onclick={() => onselect(pin.id)}
  >
    <span class="ow-pin-glyph">{party ? PARTY_GLYPH : ICONS[pin.icon].glyph}</span>
    {#if party && pin.label}<span class="ow-pin-label">{pin.label}</span>{/if}
    {#if !party && (pin.label || pin.note)}
      <span class="ow-tip">
        {#if pin.label}<strong>{pin.label}</strong>{/if}
        {#if pin.note}<span>{pin.note}</span>{/if}
        {#if pin.visibility === 'private'}<em>Private</em>{/if}
      </span>
    {/if}
  </button>
{/each}
