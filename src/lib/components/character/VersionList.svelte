<script lang="ts">
  import type { CharacterVersion } from '$lib/types/character';

  let {
    characterId,
    open,
    onClose
  }: {
    characterId: string;
    open: boolean;
    onClose: () => void;
  } = $props();

  let versions = $state<CharacterVersion[]>([]);
  let loading = $state(false);
  let loadError = $state(false);

  // db-traffic-reduction Phase 4: versions used to be passed in as a prop, loaded by the
  // sheet's load() on every single page view even though this modal is rarely opened.
  // Fetched fresh from GET /characters/[id]/versions every time the modal opens instead -
  // same "own its data, fetch on open" idiom as SessionNotesModal.svelte.
  $effect(() => {
    if (!open) return;
    let cancelled = false;
    loading = true;
    loadError = false;
    (async () => {
      try {
        const res = await fetch(`/characters/${characterId}/versions`);
        if (cancelled) return;
        if (!res.ok) {
          loadError = true;
          return;
        }
        const body = await res.json();
        versions = body.versions ?? [];
      } catch {
        if (!cancelled) loadError = true;
      } finally {
        if (!cancelled) loading = false;
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  function handleKeydown(event: KeyboardEvent) {
    if (open && event.key === 'Escape') onClose();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
  <div class="modal-backdrop" role="presentation" onpointerdown={onClose}>
    <div class="panel version-modal" role="dialog" aria-modal="true" aria-labelledby="version-history-title" tabindex="-1" onpointerdown={(event) => event.stopPropagation()}>
      <div class="panel-head">
        <div>
          <h2 id="version-history-title">Version History</h2>
          <p class="muted">{versions.length} entries</p>
        </div>
        <button type="button" class="text-button" onclick={onClose}>Close</button>
      </div>

      <div class="stack version-list">
        {#if loading}
          <p class="muted">Loading...</p>
        {:else if loadError}
          <p class="muted">Could not load version history.</p>
        {:else}
          {#each versions as version}
            <article class="version-row with-actions">
              <div>
                <strong>{version.changeSummary || 'Snapshot'}</strong>
                <span>{new Date(version.createdAt).toLocaleString()}</span>
              </div>
              <form method="POST" action="?/restoreVersion">
                <input name="versionId" type="hidden" value={version.id} />
                <button type="submit">Restore</button>
              </form>
            </article>
          {:else}
            <p class="muted">No snapshots yet.</p>
          {/each}
        {/if}
      </div>
    </div>
  </div>
{/if}
