<script lang="ts">
  import type { CharacterListItem } from '$lib/types/character';
  import { totalLevel } from '$lib/rules/dnd5e';

  let { character }: { character: CharacterListItem } = $props();

  const classLine = $derived(character.classes.map((c) => c.className).join(' / ') || 'Adventurer');
</script>

<!-- A compact card; the whole card opens the sheet (same size and feel as the campaign party cards). -->
<a class="character-card" href={`/characters/${character.id}`}>
  <div class="token">{character.name.slice(0, 2).toUpperCase()}</div>
  <div class="character-card-body">
    <h3>{character.name}</h3>
    <p class="muted">{character.ancestry || 'Unknown ancestry'} - {classLine}</p>
  </div>
  <div class="character-card-foot">
    <span>Level <strong>{totalLevel(character.classes)}</strong></span>
    <span>HP <strong>{character.hpCurrent} / {character.hpMax}</strong></span>
    {#if character.campaignName}<span class="badge">{character.campaignName}</span>{/if}
  </div>
</a>
