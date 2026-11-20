<script lang="ts">
  import CharacterSheetForm from '$lib/components/character/CharacterSheetForm.svelte';
  import CharacterCampaignPanel from '$lib/components/character/CharacterCampaignPanel.svelte';
  import VersionList from '$lib/components/character/VersionList.svelte';

  let { data, form } = $props();
  let versionHistoryOpen = $state(false);
</script>

<section class="sheet-grid single">
  <!-- Keyed on the character: the sheet keeps per-character state (forage badge, handled hauls), which must not carry over. -->
  {#key data.character.id}
  <CharacterSheetForm currentUserId={data.user?.id ?? null} character={data.character} itemCategories={data.itemCategories} result={form ?? undefined} isAdmin={data.user?.role === 'admin'} access={data.access} ownerName={data.ownerName} activeEncounterId={data.activeEncounterId} activeVttSessionId={data.activeVttSessionId} activeGameSessionId={data.activeGameSessionId} onVersionHistory={() => (versionHistoryOpen = true)} />
  {/key}
</section>

<!-- Outside the sheet's big form on purpose: forms can't nest. -->
<CharacterCampaignPanel character={data.character} campaigns={data.myCampaigns} {form} isOwner={data.access.isOwner} />

<VersionList characterId={data.character.id} open={versionHistoryOpen} onClose={() => (versionHistoryOpen = false)} />
