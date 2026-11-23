<script lang="ts">
  import { catalogueSourceLabel } from '$lib/library/rules';

  let { data } = $props();
  const label = (entry: (typeof data.content)[number]) => catalogueSourceLabel({
    sourceKind: entry.sourceKind, scope: entry.scope, ownerName: entry.ownerName, forkedFromOwnerName: entry.forkedFromOwnerName
  });
</script>

<section class="page-head">
  <div>
    <p class="eyebrow">{data.campaign ? data.campaign.name : 'Rules'}</p>
    <h1>{data.owner ? `${data.owner.name}'s library` : data.campaign ? 'Campaign homebrew' : 'Content Catalogue'}</h1>
    <p class="muted">
      {#if data.owner && !data.owner.enabled}This library is switched off for this campaign, so nothing in it can be added yet. Only you can see this preview.
      {:else if data.campaign}What this campaign can use: the core rules, the libraries its DM has switched on, and the campaign's own copies.
      {:else}The core rules and your own homebrew. This page is read-only.{/if}
    </p>
    <p class="catalogue-links">
      <a href="/library">Your library</a>
      {#if data.campaign}<a href="/campaigns/{data.campaign.id}/library">Member libraries</a><a href="/campaigns/{data.campaign.id}">Back to campaign</a>{/if}
      {#if data.user?.role === 'admin'}<a href="/admin/items">Admin items</a>{/if}
    </p>
  </div>
</section>

<section class="panel stack catalogue-toolbar">
  <form method="GET" class="catalogue-filter">
    {#if data.campaign}<input type="hidden" name="campaign" value={data.campaign.id} />{/if}
    {#if data.owner}<input type="hidden" name="owner" value={data.owner.id} />{/if}
    <label>Search<input name="search" value={data.search} /></label>
    <label>Type
      <select name="type">
        <option value="">All</option>
        <option value="item" selected={data.type === 'item'}>Items</option>
        <option value="spell" selected={data.type === 'spell'}>Spells</option>
        <option value="feat" selected={data.type === 'feat'}>Feats</option>
        <option value="class_feature" selected={data.type === 'class_feature'}>Class Features</option>
      </select>
    </label>
    <button type="submit">Search</button>
  </form>
</section>

<section class="panel stack">
  <div class="panel-head"><h2>Available Content</h2><span class="muted">{data.content.length} entries</span></div>
  <div class="catalogue-list">
    {#each data.content as entry}
      <article class="catalogue-card">
        <div><span class="eyebrow">{entry.type.replace('_', ' ')}</span><h3>{entry.name}</h3><p>{entry.description}</p></div>
        <span class="status-chip">{label(entry)}</span>
      </article>
    {:else}<p class="muted">No catalogue entries match.</p>{/each}
  </div>
</section>

<style>
  .catalogue-links { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .catalogue-links a { display: inline-flex; align-items: center; min-height: 44px; padding: 0 12px; }
  .catalogue-filter button, .catalogue-filter input, .catalogue-filter select { min-height: 44px; }
</style>
