<script lang="ts">
  import { enhance } from '$app/forms';
  import type { CharacterDetail } from '$lib/types/character';

  // The owner's campaign controls for one character. Lives outside the sheet's big form (forms
  // can't nest) and posts to the sheet page's setCampaign / leaveCampaign / setPartyActive actions.
  let {
    character,
    campaigns,
    form,
    isOwner = true
  }: {
    character: CharacterDetail;
    campaigns: { id: string; name: string }[];
    form?: { campaignError?: string } | null;
    /** Only the owner adds or moves a character between campaigns; a DM or admin can still toggle and remove. */
    isOwner?: boolean;
  } = $props();

  let choice = $state('');
  // Other campaigns than the current one; picking one while already in a campaign is a move.
  const options = $derived(campaigns.filter((c) => c.id !== character.campaignId));
</script>

<details class="panel campaign-panel campaign-sheet-panel">
  <summary>Campaign{character.campaignName ? `: ${character.campaignName}` : ''}</summary>
  <div class="stack">
    {#if form?.campaignError}
      <p class="form-error">{form.campaignError}</p>
    {/if}

    {#if character.campaignId}
      <div class="member-actions">
        <form method="POST" action="?/setPartyActive" use:enhance={() => async ({ update }) => update({ reset: false })}>
          <input type="hidden" name="active" value={character.partyActive ? '0' : '1'} />
          <label class="toggle-row">
            <input type="checkbox" checked={character.partyActive} onchange={(e) => e.currentTarget.form?.requestSubmit()} />
            Active in party
          </label>
        </form>
        <form
          method="POST"
          action="?/leaveCampaign"
          use:enhance={({ cancel }) => {
            if (!confirm(`Remove ${character.name} from ${character.campaignName}?`)) cancel();
            return async ({ update }) => update({ reset: false });
          }}
        >
          <button type="submit" class="compact-button danger">Remove from campaign</button>
        </form>
      </div>
    {/if}

    {#if !isOwner}
      <!-- A DM or site admin editing someone else's character: no add/move, that is the owner's call. -->
    {:else if options.length === 0}
      <p class="muted">
        {#if campaigns.length === 0}
          You are not in any campaign yet. <a class="text-button" href="/campaigns">Create or join one</a>.
        {:else}
          You are not in any other campaign.
        {/if}
      </p>
    {:else}
      <form
        method="POST"
        action="?/setCampaign"
        class="stack"
        use:enhance={({ cancel }) => {
          if (character.campaignId && !confirm(`Move ${character.name} from ${character.campaignName} to another campaign?`)) cancel();
          return async ({ update }) => {
            await update({ reset: false });
            choice = '';
          };
        }}
      >
        <label>
          {character.campaignId ? 'Move to another campaign' : 'Add to a campaign'}
          <select name="campaignId" bind:value={choice} required>
            <option value="">Choose...</option>
            {#each options as c (c.id)}
              <option value={c.id}>{c.name}</option>
            {/each}
          </select>
        </label>
        <button type="submit">{character.campaignId ? 'Move' : 'Add'}</button>
      </form>
    {/if}
  </div>
</details>
