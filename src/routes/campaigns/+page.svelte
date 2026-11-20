<script lang="ts">
  import { listHref, roleLabel } from '$lib/campaigns/listParams';

  let { data, form } = $props();
  const list = $derived(data.list);
  const here = $derived({ q: list.q, includeArchived: list.includeArchived });
</script>

<section class="page-head">
  <div>
    <p class="eyebrow">Campaigns</p>
    <h1>{data.isAdmin ? 'All campaigns' : 'Your campaigns'}</h1>
  </div>
</section>

{#if form?.error}
  <p class="form-error">{form.error}</p>
{/if}

<!--
  Layout: the main column has Create / Join side by side, then the campaign cards and the pager.
  The search sits in a narrow sidebar on the right on wide screens, and above the cards on a phone.
-->
<div class="campaigns-layout">
  <div class="campaigns-main">
    <div class="campaign-forms">
      <details class="panel campaign-panel">
        <summary>Create a campaign</summary>
        <form method="POST" action="?/create" class="stack">
          <label>
            Name
            <input name="name" maxlength="80" value={form?.createName ?? ''} required />
          </label>
          <label>
            Description (optional)
            <textarea name="description" rows="3" maxlength="2000">{form?.createDescription ?? ''}</textarea>
          </label>
          <button type="submit" class="compact-button stack-button">Create campaign</button>
        </form>
      </details>

      <details class="panel campaign-panel">
        <summary>Join with a code</summary>
        <form method="POST" action="?/join" class="campaign-row">
          <input
            name="code"
            placeholder="ABCDE-FGHJK"
            autocomplete="off"
            autocapitalize="characters"
            value={form?.joinCode ?? ''}
            aria-label="Invite code"
            required
          />
          <button type="submit" class="compact-button">Join</button>
        </form>
      </details>
    </div>

    {#if list.items.length === 0}
      <p class="panel muted">
        {#if list.q}
          No campaigns match '{list.q}'.
        {:else}
          No campaigns yet. Create one above, or join with an invite code.
        {/if}
      </p>
    {:else}
      <div class="campaign-card-grid">
        {#each list.items as campaign (campaign.id)}
          <a class="campaign-card" href={`/campaigns/${campaign.id}`}>
            <div class="campaign-card-head">
              <h3>{campaign.name}</h3>
              <span class="campaign-badges">
                <span class="badge">{roleLabel(campaign.myRole)}</span>
                {#if campaign.isArchived}<span class="badge badge-muted">Archived</span>{/if}
              </span>
            </div>
            <p class="muted">DM: {campaign.dmName ?? 'none'}</p>
            <p class="muted">
              {campaign.memberCount} {campaign.memberCount === 1 ? 'member' : 'members'},
              {campaign.characterCount} {campaign.characterCount === 1 ? 'character' : 'characters'}
            </p>
          </a>
        {/each}
      </div>
    {/if}

    {#if list.pageCount > 1}
      <nav class="pager" aria-label="Campaign pages">
        {#if list.page > 1}
          <a class="button-link compact-link" href={listHref({ ...here, page: list.page - 1 })}>Previous</a>
        {:else}
          <span class="button-link compact-link disabled" aria-disabled="true">Previous</span>
        {/if}
        <span class="muted">Page {list.page} of {list.pageCount}</span>
        {#if list.page < list.pageCount}
          <a class="button-link compact-link" href={listHref({ ...here, page: list.page + 1 })}>Next</a>
        {:else}
          <span class="button-link compact-link disabled" aria-disabled="true">Next</span>
        {/if}
      </nav>
    {/if}
  </div>

  <aside class="campaigns-side">
    <section class="panel campaign-box">
      <h2>Find a campaign</h2>
      <!-- Plain GET form: the search is in the URL, so it can be linked and works without JS. -->
      <form method="GET" action="/campaigns" class="stack campaign-search-form">
        <div class="campaign-row">
          <input name="q" type="search" placeholder="Search by name" maxlength="80" value={list.q} aria-label="Search campaigns" />
          <button type="submit" class="compact-button">Search</button>
        </div>
        {#if data.isAdmin}
          <label class="toggle-row">
            <input type="checkbox" name="archived" value="1" checked={list.includeArchived} />
            Include archived
          </label>
        {/if}
      </form>
      <div class="campaign-box-foot">
        <span class="muted">{list.total} {list.total === 1 ? 'campaign' : 'campaigns'}{list.q ? ` matching '${list.q}'` : ''}</span>
        {#if list.q}
          <a class="text-button" href={listHref({ q: '', page: 1, includeArchived: list.includeArchived })}>Clear</a>
        {/if}
      </div>
    </section>
  </aside>
</div>
