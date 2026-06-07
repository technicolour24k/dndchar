<script lang="ts">
  import CharacterCard from '$lib/components/character/CharacterCard.svelte';

  let { data } = $props();
</script>

<section class="hero-panel">
  <div>
    <p class="eyebrow">Dashboard</p>
    <h1>Character command center</h1>
    <p>Fresh SvelteKit milestone with PostgreSQL-backed character state and version history.</p>
  </div>
  <a class="button-link" href="/characters">Open roster</a>
</section>

<section class="content-grid">
  <div class="panel">
    <div class="panel-head">
      <h2>Recent Characters</h2>
      <a href="/characters">View all</a>
    </div>
    <div class="card-grid">
      {#each data.characters.slice(0, 4) as character}
        <CharacterCard {character} />
      {:else}
        <p class="muted">No characters yet.</p>
      {/each}
    </div>
  </div>

  <aside class="panel">
    <h2>Live Sync</h2>
    <p class="muted">Socket.IO client plumbing is available. Server emits are centralized after PostgreSQL writes.</p>
  </aside>
</section>
