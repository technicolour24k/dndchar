<script lang="ts">
  import { listHref, roleLabel } from '$lib/campaigns/listParams';
  import { canOpenAsGm, quickRoomHref, tableHref } from '$lib/campaigns/vttLinks';

  let { data } = $props();
  const list = $derived(data.list);
  const here = $derived({ q: list.q, includeArchived: false });
</script>

<section class="page-head">
  <div>
    <p class="eyebrow">Virtual tabletop</p>
    <h1>Tables</h1>
  </div>
</section>

<!-- Same two-column shape as /campaigns: the campaign tables on the left, search and the Quick room in a narrow side column. -->
<div class="campaigns-layout">
  <div class="campaigns-main">
    {#if list.items.length === 0}
      <p class="panel muted">
        {#if list.q}
          No campaigns match '{list.q}'.
        {:else}
          You're not in a campaign yet. <a href="/campaigns">Create or join one</a> to get a table, or use a Quick room.
        {/if}
      </p>
    {:else}
      <div class="campaign-card-grid">
        {#each list.items as campaign (campaign.id)}
          <section class="panel campaign-box">
            <div class="campaign-row">
              <h2>{campaign.name}</h2>
              <span class="badge">{roleLabel(campaign.myRole)}</span>
            </div>
            <p class="muted">DM: {campaign.dmName ?? 'none'}</p>
            <div class="campaign-box-foot">
              {#if canOpenAsGm(campaign.myRole)}
                <a class="button-link compact-link" href={tableHref(campaign.id, 'gm', data.me)}>Open as DM</a>
              {/if}
              <a class="button-link compact-link" href={tableHref(campaign.id, 'player', data.me)}>Open as player</a>
              <a class="text-button" href={`/campaigns/${campaign.id}`}>Campaign page</a>
            </div>
          </section>
        {/each}
      </div>
    {/if}

    {#if list.pageCount > 1}
      <nav class="pager" aria-label="Table pages">
        {#if list.page > 1}
          <a class="button-link compact-link" href={listHref({ ...here, page: list.page - 1 }, '/vtt')}>Previous</a>
        {:else}
          <span class="button-link compact-link disabled" aria-disabled="true">Previous</span>
        {/if}
        <span class="muted">Page {list.page} of {list.pageCount}</span>
        {#if list.page < list.pageCount}
          <a class="button-link compact-link" href={listHref({ ...here, page: list.page + 1 }, '/vtt')}>Next</a>
        {:else}
          <span class="button-link compact-link disabled" aria-disabled="true">Next</span>
        {/if}
      </nav>
    {/if}
  </div>

  <aside class="campaigns-side">
    <section class="panel campaign-box">
      <h2>Find a campaign</h2>
      <!-- Plain GET form, like /campaigns: the search is in the URL and works without JS. -->
      <form method="GET" action="/vtt" class="stack campaign-search-form">
        <div class="campaign-row">
          <input name="q" type="search" placeholder="Search by name" maxlength="80" value={list.q} aria-label="Search your campaigns" />
          <button type="submit" class="compact-button">Search</button>
        </div>
      </form>
      <div class="campaign-box-foot">
        <span class="muted">{list.total} {list.total === 1 ? 'campaign' : 'campaigns'}{list.q ? ` matching '${list.q}'` : ''}</span>
        {#if list.q}
          <a class="text-button" href="/vtt">Clear</a>
        {/if}
      </div>
    </section>

    <section class="panel campaign-box">
      <div class="campaign-row">
        <h2>Quick room</h2>
        <a class="button-link compact-link" href={quickRoomHref(data.me)}>Open</a>
      </div>
      <p class="muted">
        For testing or one-off games, with no campaign. Anyone with the code can join, and the first GM in wins.
        Foraging isn't available in Quick rooms.
      </p>
    </section>
  </aside>
</div>
