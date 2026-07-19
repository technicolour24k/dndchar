<script lang="ts">
  type EncounterHistoryItem = { id: string; name: string; isActive: boolean; createdAt: string };

  let {
    encounters,
    characterId,
    open,
    onClose
  }: {
    encounters: EncounterHistoryItem[];
    characterId: string;
    open: boolean;
    onClose: () => void;
  } = $props();

  function handleKeydown(event: KeyboardEvent) {
    if (open && event.key === 'Escape') onClose();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
  <div class="modal-backdrop" role="presentation" onpointerdown={onClose}>
    <div class="panel version-modal" role="dialog" aria-modal="true" aria-labelledby="encounter-history-title" tabindex="-1" onpointerdown={(event) => event.stopPropagation()}>
      <div class="panel-head">
        <div>
          <h2 id="encounter-history-title">Combat History</h2>
          <p class="muted">{encounters.length} encounters</p>
        </div>
        <button type="button" class="text-button" onclick={onClose}>Close</button>
      </div>

      <div class="stack version-list">
        {#each encounters as encounter}
          <article class="version-row with-actions">
            <div>
              <strong>{encounter.name}</strong>
              <span>{new Date(encounter.createdAt).toLocaleString()} - {encounter.isActive ? 'Active' : 'Ended'}</span>
            </div>
            <a class="button-link" href="/characters/{characterId}/encounters/{encounter.id}">View</a>
          </article>
        {:else}
          <p class="muted">No combat encounters yet.</p>
        {/each}
      </div>
    </div>
  </div>
{/if}
