<script lang="ts">
  import CharacterSheetForm from '$lib/components/character/CharacterSheetForm.svelte';
  import VersionList from '$lib/components/character/VersionList.svelte';

  let { data, form } = $props();
  let versionHistoryOpen = $state(false);
</script>

<section class="sheet-grid single">
  <CharacterSheetForm character={data.character} itemCategories={data.itemCategories} result={form ?? undefined} isAdmin={data.user?.role === 'admin'} activeEncounterId={data.activeEncounterId} activeVttSessionId={data.activeVttSessionId} activeGameSessionId={data.activeGameSessionId} onVersionHistory={() => (versionHistoryOpen = true)} />
</section>

<VersionList characterId={data.character.id} open={versionHistoryOpen} onClose={() => (versionHistoryOpen = false)} />
