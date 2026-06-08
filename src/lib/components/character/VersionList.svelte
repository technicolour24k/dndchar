<script lang="ts">
  import type { CharacterVersion } from '$lib/types/character';

  let {
    versions,
    open,
    onClose
  }: {
    versions: CharacterVersion[];
    open: boolean;
    onClose: () => void;
  } = $props();
</script>

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
      </div>
    </div>
  </div>
{/if}
