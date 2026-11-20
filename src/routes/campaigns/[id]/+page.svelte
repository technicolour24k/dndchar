<script lang="ts">
  import { enhance } from '$app/forms';
  import { page } from '$app/state';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { formatInviteCode, roleLabel } from '$lib/campaigns/listParams';
  import { totalLevel } from '$lib/rules/dnd5e';

  let { data, form } = $props();

  const campaign = $derived(data.campaign);
  const access = $derived(data.access);
  const archived = $derived(campaign.isArchived);
  const inviteLink = $derived(campaign.inviteCode ? `${page.url.origin}/campaigns/join/${campaign.inviteCode}` : '');
  const activeCharacters = $derived(data.characters.filter((c) => c.partyActive));
  const benchedCharacters = $derived(data.characters.filter((c) => !c.partyActive));
  // Own characters not already in THIS campaign (one in another campaign is labelled, moving confirms).
  const addable = $derived(data.myCharacters.filter((c) => c.campaignId !== campaign.id));
  let addChoice = $state('');
  const addChoiceInfo = $derived(addable.find((c) => c.id === addChoice));
  let copied = $state('');
  let codeField = $state<HTMLInputElement | null>(null);
  let linkField = $state<HTMLInputElement | null>(null);

  // Wraps a form so it asks first. Cancelling the confirm cancels the submit.
  function confirmFirst(message: string): SubmitFunction {
    return ({ cancel }) => {
      if (!confirm(message)) cancel();
    };
  }

  // Copy with the clipboard API; fall back to selecting the field so the user can press Ctrl+C.
  async function copy(text: string, label: string, field: HTMLInputElement | null) {
    try {
      await navigator.clipboard.writeText(text);
      copied = label;
      setTimeout(() => (copied = ''), 2000);
    } catch {
      field?.focus();
      field?.select();
    }
  }

  function nameOf(userId: string) {
    return data.members.find((m) => m.userId === userId)?.displayName ?? 'someone';
  }
  function makePrimaryConfirm(userId: string, demoteTo: 'co_dm' | 'player' | null) {
    const old = data.members.find((m) => m.role === 'dm');
    const who = nameOf(userId);
    if (!old) return `Make ${who} the primary DM?`;
    return `Make ${who} the primary DM? ${old.displayName} will become ${demoteTo === 'co_dm' ? 'the co-DM' : 'a player'}.`;
  }
  const levelOf = (classes: { className: string; level: number }[]) =>
    classes.length ? `${classes.map((c) => c.className).join(' / ')} ${totalLevel(classes)}` : 'No class';
</script>

<!--
  Layout: a header (name, role, description), then two columns on wide screens. The main column is
  the party, as a grid of small character cards with "add your character" underneath. The side
  column holds the smaller boxes: members, invite, table and settings (edit details, archive). On a
  phone everything stacks into one column.
-->
<section class="page-head campaign-head">
  <div>
    <p class="eyebrow">Campaign{archived ? ' - archived' : ''}</p>
    <h1>{campaign.name}</h1>
    <div class="campaign-head-meta">
      <span class="badge">{access.role ? roleLabel(access.role) : 'Not a member'}</span>
      {#if data.viaAdmin}<span class="badge badge-admin">Editing as site admin</span>{/if}
    </div>
    {#if campaign.description}<p class="campaign-description">{campaign.description}</p>{/if}
  </div>
  <a class="text-button" href="/campaigns">All campaigns</a>
</section>

{#if data.hasNoDm && access.isAdmin}
  <p class="form-error">This campaign has no DM. Join with the invite code, then make yourself DM, or make another member DM.</p>
{/if}
{#if archived}
  <p class="form-error">This campaign is archived. It is read-only and its characters have been released.</p>
{/if}
{#if form?.error}
  <p class="form-error">{form.error}</p>
{/if}

<div class="campaign-layout">
  <div class="campaign-main">
    <section class="panel campaign-box">
      <h2>
        Party
        <span class="muted">({activeCharacters.length} active{benchedCharacters.length ? `, ${benchedCharacters.length} away` : ''})</span>
      </h2>

      {#snippet characterCard(c: (typeof data.characters)[number])}
        {@const canChange = !archived && (c.ownerUserId === data.viewerId || access.canManage)}
        <li class="party-card" class:benched={!c.partyActive}>
          <a class="party-card-name" href={`/characters/${c.id}`}>{c.name}</a>
          <span class="muted">{c.ownerName}</span>
          <span class="party-card-stats">{levelOf(c.classes)} - HP {c.hpCurrent}/{c.hpMax}</span>
          {#if canChange}
            <div class="party-card-actions">
              <form method="POST" action="?/setActive" use:enhance>
                <input type="hidden" name="characterId" value={c.id} />
                <input type="hidden" name="active" value={c.partyActive ? '0' : '1'} />
                <label class="toggle-row">
                  <input type="checkbox" checked={c.partyActive} onchange={(e) => e.currentTarget.form?.requestSubmit()} />
                  In party
                </label>
                <noscript><button type="submit" class="compact-button">Save</button></noscript>
              </form>
              <form method="POST" action="?/removeCharacter" use:enhance={confirmFirst(`Remove ${c.name} from the campaign?`)}>
                <input type="hidden" name="characterId" value={c.id} />
                <button type="submit" class="text-button danger-text">Remove</button>
              </form>
            </div>
          {/if}
        </li>
      {/snippet}

      {#if data.characters.length === 0}
        <p class="muted">No characters yet.</p>
      {/if}
      {#if activeCharacters.length}
        <ul class="party-grid">{#each activeCharacters as c (c.id)}{@render characterCard(c)}{/each}</ul>
      {/if}
      {#if benchedCharacters.length}
        <h3 class="party-subhead">Not in the party right now</h3>
        <ul class="party-grid">{#each benchedCharacters as c (c.id)}{@render characterCard(c)}{/each}</ul>
      {/if}

      {#if access.role && !archived}
        {#if addable.length === 0}
          <p class="muted party-add">All your characters are already here, or you have none yet.</p>
        {:else}
          <form
            method="POST"
            action="?/addCharacter"
            use:enhance={({ cancel }) => {
              // Decided at submit time (not when the form mounts), so it sees the current choice.
              const picked = addable.find((c) => c.id === addChoice);
              if (picked?.campaignId && !confirm(`${picked.name} is in ${picked.campaignName}. Move it to ${campaign.name}?`)) cancel();
            }}
            class="party-add"
          >
            <select name="characterId" bind:value={addChoice} required aria-label="Add your character">
              <option value="">Add your character...</option>
              {#each addable as c (c.id)}
                <option value={c.id}>{c.name}{c.campaignName ? ` (in ${c.campaignName})` : ''}</option>
              {/each}
            </select>
            <button type="submit" class="compact-button">{addChoiceInfo?.campaignId ? 'Move here' : 'Add'}</button>
          </form>
        {/if}
      {/if}
    </section>
  </div>

  <div class="campaign-side">
    <section class="panel campaign-box">
      <h2>Members <span class="muted">({data.members.length})</span></h2>
      <ul class="member-list">
        {#each data.members as member (member.userId)}
          {@const c = data.controls[member.userId]}
          <li>
            <div class="member-name">
              <strong>{member.displayName}</strong>
              <span class="badge">{roleLabel(member.role)}</span>
              {#if member.userId === data.viewerId}<span class="muted">(you)</span>{/if}
            </div>
            {#if c?.makeCoDm || c?.makePrimary || c?.makePlayer || c?.remove}
              <div class="member-actions">
                {#if c?.makeCoDm}
                  <form method="POST" action="?/setRole" use:enhance>
                    <input type="hidden" name="userId" value={member.userId} />
                    <input type="hidden" name="role" value="co_dm" />
                    <button type="submit" class="compact-button">Make co-DM</button>
                  </form>
                {/if}
                {#if c?.makePrimary}
                  <form method="POST" action="?/setRole" use:enhance={confirmFirst(makePrimaryConfirm(member.userId, c.demoteOldPrimaryTo))}>
                    <input type="hidden" name="userId" value={member.userId} />
                    <input type="hidden" name="role" value="dm" />
                    <button type="submit" class="compact-button">{access.isAdmin && !access.isPrimaryDm ? 'Make primary DM' : 'Hand over DM role'}</button>
                  </form>
                {/if}
                {#if c?.makePlayer}
                  <form method="POST" action="?/setRole" use:enhance>
                    <input type="hidden" name="userId" value={member.userId} />
                    <input type="hidden" name="role" value="player" />
                    <button type="submit" class="compact-button">Make player</button>
                  </form>
                {/if}
                {#if c?.remove}
                  <form
                    method="POST"
                    action="?/removeMember"
                    use:enhance={confirmFirst(`Remove ${member.displayName}? Their characters will leave the campaign and they will lose access.`)}
                  >
                    <input type="hidden" name="userId" value={member.userId} />
                    <button type="submit" class="compact-button danger">Remove</button>
                  </form>
                {/if}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
      {#if data.leave.show}
        {#if data.leave.allowed}
          <form
            method="POST"
            action="?/leave"
            class="campaign-box-foot"
            use:enhance={confirmFirst(
              data.leave.coDmInherits ? 'Leave this campaign? Your co-DM will become the DM.' : 'Leave this campaign? Your characters here will leave it too.'
            )}
          >
            <button type="submit" class="text-button danger-text">Leave campaign</button>
            {#if data.leave.coDmInherits}<span class="muted">Your co-DM will take over as DM.</span>{/if}
          </form>
        {:else}
          <p class="muted campaign-box-foot">{data.leave.reason}</p>
        {/if}
      {/if}
    </section>

    {#if access.canManage && !archived && campaign.inviteCode}
      <section class="panel campaign-box">
        <h2>Invite</h2>
        <div class="campaign-row">
          <input
            bind:this={codeField}
            class="invite-code"
            readonly
            value={formatInviteCode(campaign.inviteCode)}
            aria-label="Invite code"
            onfocus={(e) => e.currentTarget.select()}
          />
          <button type="button" class="compact-button" onclick={() => copy(formatInviteCode(campaign.inviteCode ?? ''), 'code', codeField)}>
            {copied === 'code' ? 'Copied' : 'Copy code'}
          </button>
        </div>
        <div class="campaign-row">
          <input bind:this={linkField} class="invite-link" readonly value={inviteLink} aria-label="Invite link" onfocus={(e) => e.currentTarget.select()} />
          <button type="button" class="compact-button" onclick={() => copy(inviteLink, 'link', linkField)}>{copied === 'link' ? 'Copied' : 'Copy link'}</button>
        </div>
        <form method="POST" action="?/regenerate" class="campaign-box-foot" use:enhance={confirmFirst('The old code and link will stop working. Make a new one?')}>
          <button type="submit" class="text-button danger-text">New code</button>
          {#if form?.saved === 'invite'}<span class="muted">New code ready.</span>{/if}
        </form>
      </section>
    {/if}

    {#if !archived}
      <section class="panel campaign-box">
        <div class="campaign-row">
          <h2>Table</h2>
          <a class="button-link compact-link" href="/vtt">Open table</a>
        </div>
      </section>
    {/if}

    {#if access.canManage && !archived}
      <section class="panel campaign-box">
        <h2>Settings</h2>
        <details class="campaign-sub">
          <summary>Edit name and description</summary>
          <form method="POST" action="?/update" use:enhance class="stack">
            <label>
              Name
              <input name="name" maxlength="80" value={campaign.name} required />
            </label>
            <label>
              Description
              <textarea name="description" rows="3" maxlength="2000">{campaign.description}</textarea>
            </label>
            <button type="submit" class="compact-button stack-button">Save details</button>
          </form>
        </details>
        {#if form?.saved === 'details'}<p class="muted">Saved.</p>{/if}
        {#if access.isPrimaryDm || access.isAdmin}
          <details class="campaign-sub">
            <summary>Archive campaign</summary>
            <form
              method="POST"
              action="?/archive"
              use:enhance={confirmFirst('Archive this campaign? Its invite code stops working and every character is released. This cannot be undone here.')}
              class="stack"
            >
              <p class="muted">Archiving hides the campaign, stops the invite code and releases every character.</p>
              <button type="submit" class="compact-button danger stack-button">Archive campaign</button>
            </form>
          </details>
        {/if}
      </section>
    {/if}
  </div>
</div>
