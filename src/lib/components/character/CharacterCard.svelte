<script lang="ts">
  import type { CharacterListItem } from '$lib/types/character';
  import { totalLevel } from '$lib/rules/dnd5e';

  let { character }: { character: CharacterListItem } = $props();
</script>

<article class="character-card">
  <div class="token">{character.name.slice(0, 2).toUpperCase()}</div>
  <div>
    <h3>{character.name}</h3>
    <p>{character.ancestry || 'Unknown ancestry'} - {character.classes.map((c) => c.className).join(' / ') || 'Adventurer'}</p>
  </div>
  <dl>
    <div><dt>Level</dt><dd>{totalLevel(character.classes)}</dd></div>
    <div><dt>HP</dt><dd>{character.hpCurrent} / {character.hpMax}</dd></div>
  </dl>
  <a class="button-link" href={`/characters/${character.id}`}>Open</a>
</article>
