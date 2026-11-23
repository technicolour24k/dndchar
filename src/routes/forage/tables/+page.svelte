<script lang="ts">
  let { data } = $props();
</script>

<section class="page-head">
  <div>
    <p class="eyebrow">Forage</p>
    <h1>Find Tables</h1>
    <p>Find tables belong to a campaign, so they are managed from the campaign's own Forage page.</p>
  </div>
</section>

{#if data.campaigns.length}
  <div class="panel stack">
    <h2>Your campaigns</h2>
    {#each data.campaigns as campaign (campaign.id)}
      <a class="button-link" href="/campaigns/{campaign.id}/forage">{campaign.name}</a>
    {/each}
  </div>
{:else}
  <p class="panel muted">You're not a DM of any campaign. Find tables belong to a campaign; its DM creates them.</p>
{/if}
