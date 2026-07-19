<script lang="ts">
  import CharacterSheetForm from '$lib/components/character/CharacterSheetForm.svelte';
  import VersionList from '$lib/components/character/VersionList.svelte';
  import EncounterHistoryList from '$lib/components/character/EncounterHistoryList.svelte';
  import { websocketStore } from '$lib/stores/websocketStore';

  let { data, form } = $props();
  let versionHistoryOpen = $state(false);
  let encounterHistoryOpen = $state(false);

  $effect(() => {
    websocketStore.connect();
    websocketStore.joinRoom(`character:${data.character.id}`);
  });
</script>

<section class="sheet-grid single">
  <CharacterSheetForm character={data.character} catalogue={data.catalogue} itemCategories={data.itemCategories} result={form ?? undefined} isAdmin={data.user?.role === 'admin'} activeEncounterId={data.activeEncounterId} activeVttSessionId={data.activeVttSessionId} onVersionHistory={() => (versionHistoryOpen = true)} onEncounterHistory={() => (encounterHistoryOpen = true)} />
</section>

<VersionList versions={data.versions} open={versionHistoryOpen} onClose={() => (versionHistoryOpen = false)} />
<EncounterHistoryList encounters={data.encounterHistory} characterId={data.character.id} open={encounterHistoryOpen} onClose={() => (encounterHistoryOpen = false)} />
