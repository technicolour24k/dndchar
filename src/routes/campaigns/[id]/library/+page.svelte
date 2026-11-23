<script lang="ts">
  import { enhance } from '$app/forms';

  let { data, form } = $props();
  const roleLabel = (role: string) => (role === 'dm' ? 'DM' : role === 'co_dm' ? 'Co-DM' : 'Player');
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
</script>

<section class="page-head">
  <div>
    <p class="eyebrow"><a href="/campaigns/{data.campaignId}">{data.campaignName}</a></p>
    <h1>Member libraries</h1>
    <p class="muted">
      Everyone keeps their own homebrew library. Until you switch a member's library on here, nothing in it can be
      added to this campaign's characters, find tables or decks. Switching it off later stops new additions, but
      anything already in use keeps working. To freeze what a member's library is doing in this campaign, use Keep a
      campaign copy: it copies everything of theirs that the campaign uses, so their later edits or archives no longer
      reach it.
    </p>
    {#if data.canManage}
      <p><a class="button-link library-copies-link" href="/campaigns/{data.campaignId}/homebrew">Campaign copies ({data.copies})</a></p>
    {/if}
  </div>
</section>

{#if data.archived}<p class="form-error">This campaign is archived, so its libraries can no longer be changed.</p>{/if}
{#if form?.error}<p class="form-error">{form.error}</p>{/if}
{#if form?.saved}<p class="form-success">Saved.</p>{/if}
{#if form?.forked}
  <p class="form-success">{form.forked}{form.reused ? ` ${plural(form.reused, 'entry')} already had a copy, which was used as it is.` : ''}</p>
  {#each form.skipped ?? [] as note}<p class="muted">{note}</p>{/each}
{/if}
{#if !data.canManage}<p class="muted">Only the DM can switch libraries on or off. You can see what is in use here.</p>{/if}

<section class="panel stack library-members">
  <h2>Members</h2>
  <ul class="member-list">
    {#each data.members as member (member.userId)}
      <li class="library-member">
        <div class="library-member-info">
          <strong>{member.displayName}</strong> <span class="muted">{roleLabel(member.role)}</span>
          <span class="status-chip" class:library-on={member.enabled}>{member.enabled ? 'On' : 'Off'}</span>
          <p class="muted">
            {#if !member.counts}Contents are shown once the DM switches this library on.{:else if member.counts.total === 0}Nothing in their library yet.{:else}{plural(member.counts.item, 'item')}, {plural(member.counts.spell, 'spell')}, {plural(member.counts.feat, 'feat or feature')}.{/if}
          </p>
          {#if data.canManage && member.uses}<p class="muted">{plural(member.uses, 'use')} in this campaign.</p>{/if}
        </div>
        <div class="library-member-actions">
          <a class="button-link" href="/catalogue?campaign={data.campaignId}&owner={member.userId}">View</a>
          {#if data.canManage && !data.archived}
            <form method="POST" action="?/setLibrary" use:enhance>
              <input type="hidden" name="ownerUserId" value={member.userId} />
              <input type="hidden" name="enabled" value={member.enabled ? '0' : '1'} />
              <button type="submit">{member.enabled ? 'Switch off' : 'Switch on'}</button>
            </form>
            {#if member.uses}
              <form method="POST" action="?/keepCampaignCopy" use:enhance={({ cancel }) => { if (!confirm(`Copy everything of ${member.displayName}'s that this campaign uses into the campaign. Their later edits or archives won't affect those uses. New uses can still pick from their library while it's enabled.`)) cancel(); }}>
                <input type="hidden" name="ownerUserId" value={member.userId} />
                <button type="submit">Keep a campaign copy</button>
              </form>
            {/if}
          {/if}
        </div>
      </li>
    {/each}
  </ul>
</section>

<style>
  .library-member { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--line); }
  .library-member-info { min-width: 0; flex: 1 1 220px; }
  .library-member-actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .library-member-actions :global(a), .library-member-actions :global(button) { min-height: 44px; min-width: 44px; padding: 0 16px; }
  .library-copies-link { display: inline-flex; align-items: center; min-height: 44px; padding: 0 16px; }
  .library-on { background: #18351f; color: var(--ok); }
</style>
