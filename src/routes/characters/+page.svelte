<script lang="ts">
  import CharacterCard from '$lib/components/character/CharacterCard.svelte';

  let { data, form } = $props();
</script>

<section class="page-head">
  <div>
    <p class="eyebrow">Roster</p>
    <h1>Characters</h1>
  </div>
  <form method="POST" action="?/create" class="inline-form">
    <input name="name" placeholder="New character name" required />
    <button type="submit">Add Character</button>
  </form>
</section>

{#if form?.error}
  <p class="form-error">{form.error}</p>
{/if}

<div class="card-grid">
  {#each data.characters as character}
    <CharacterCard {character} />
  {:else}
    <section class="panel">
      <p class="muted">Create your first D&D 5E 2014 character to begin.</p>
    </section>
  {/each}
</div>

{#if data.campaignCharacters.length > 0}
  <section class="campaign-characters">
    <h2>Campaign characters</h2>
    {#each data.campaignCharacters as group (group.campaignId)}
      <h3 class="campaign-characters-heading"><a class="text-button" href={`/campaigns/${group.campaignId}`}>{group.campaignName}</a></h3>
      <div class="card-grid">
        {#each group.characters as character (character.id)}
          <CharacterCard {character} ownerName={character.ownerName} />
        {/each}
      </div>
    {/each}
  </section>
{/if}
