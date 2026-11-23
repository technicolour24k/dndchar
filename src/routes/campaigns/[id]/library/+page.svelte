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
      anything already in use keeps working.
    </p>
  </div>
</section>

{#if data.archived}<p class="form-error">This campaign is archived, so its libraries can no longer be changed.</p>{/if}
{#if form?.error}<p class="form-error">{form.error}</p>{/if}
{#if form?.saved}<p class="form-success">Saved.</p>{/if}
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
        </div>
        <div class="library-member-actions">
          <a class="button-link" href="/catalogue?campaign={data.campaignId}&owner={member.userId}">View</a>
          {#if data.canManage && !data.archived}
            <form method="POST" action="?/setLibrary" use:enhance>
              <input type="hidden" name="ownerUserId" value={member.userId} />
              <input type="hidden" name="enabled" value={member.enabled ? '0' : '1'} />
              <button type="submit">{member.enabled ? 'Switch off' : 'Switch on'}</button>
            </form>
          {/if}
        </div>
      </li>
    {/each}
  </ul>
</section>

<style>
  .library-member { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--line); }
  .library-member-info { min-width: 0; flex: 1 1 220px; }
  .library-member-actions { display: flex; gap: 8px; }
  .library-member-actions :global(a), .library-member-actions :global(button) { min-height: 44px; min-width: 44px; padding: 0 16px; }
  .library-on { background: #18351f; color: var(--ok); }
</style>
