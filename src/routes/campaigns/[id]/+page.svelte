<script lang="ts">
  import { enhance } from '$app/forms';
  import { page } from '$app/state';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { formatInviteCode, roleLabel } from '$lib/campaigns/listParams';
  import { canOpenAsGm, tableHref } from '$lib/campaigns/vttLinks';
  import { totalLevel } from '$lib/rules/dnd5e';
  import { PROFILES } from '$lib/rules/actionEconomy';
  import { cardTitle, resultLines, statusTag, successLabel } from '../../../../static/vtt-app/shared/deckView.js';

  let { data, form } = $props();

  // Identity for the table links (the static VTT client shows the name before the ticket answers).
  const me = $derived({ id: data.viewerId, name: page.data.user?.displayName ?? '' });
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

  // Decks: which draws are still open to undo, and whether the section has anything to show.
  const showDecks = $derived(access.canManage || data.decks.length > 0 || data.draws.length > 0);
  const when = (iso: string) => new Date(iso).toLocaleString();

  // Wraps a form so it asks first. Cancelling the confirm cancels the submit.
  function confirmFirst(message: string): SubmitFunction {
    return ({ cancel }) => {
      if (!confirm(message)) cancel();
    };
  }

  // Removing someone else's character as a DM asks whether the player should go too. Only offered
  // when this viewer may remove that player (data.controls already encodes the rank rules, e.g. a
  // co-DM can't remove the primary DM); otherwise it's the plain confirm.
  type PendingRemoval = { characterId: string; name: string; ownerUserId: string; ownerName: string };
  let removing = $state<PendingRemoval | null>(null);
  function canAlsoRemoveOwner(ownerUserId: string) {
    return access.canManage && ownerUserId !== data.viewerId && !!data.controls[ownerUserId]?.remove;
  }
  // Close the popup once the chosen form has gone through, then refresh the page data as usual.
  const closeAfterSubmit: SubmitFunction = () => async ({ update }) => {
    removing = null;
    await update();
  };

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
              {#if canAlsoRemoveOwner(c.ownerUserId)}
                <button
                  type="button"
                  class="text-button danger-text"
                  onclick={() => (removing = { characterId: c.id, name: c.name, ownerUserId: c.ownerUserId, ownerName: c.ownerName })}
                >Remove</button>
              {:else}
                <form method="POST" action="?/removeCharacter" use:enhance={confirmFirst(`Remove ${c.name} from the campaign?`)}>
                  <input type="hidden" name="characterId" value={c.id} />
                  <button type="submit" class="text-button danger-text">Remove</button>
                </form>
              {/if}
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

    <!-- Real members only: a site admin who isn't a member gets no table ticket, so no link. -->
    {#if !archived && access.role}
      <section class="panel campaign-box">
        <div class="campaign-row">
          <h2>Table</h2>
          <span class="campaign-box-foot">
            {#if canOpenAsGm(access.role)}
              <a class="button-link compact-link" href={tableHref(campaign.id, 'gm', me)}>Open as DM</a>
            {/if}
            <a class="button-link compact-link" href={tableHref(campaign.id, 'player', me)}>Open as player</a>
          </span>
        </div>
      </section>
    {/if}

    {#if data.overworld}
      <section class="panel campaign-box">
        <div class="campaign-row">
          <h2>Overworld</h2>
          <span class="campaign-box-foot">
            <a class="button-link compact-link" href="/campaigns/{campaign.id}/overworld">
              {data.overworld.viewer.canManage ? 'Manage maps' : 'All maps'}
            </a>
          </span>
        </div>
        {#if data.overworld.maps.length === 0}
          <p class="muted">{data.overworld.viewer.canManage ? 'No maps yet.' : "Your DM hasn't shared a map yet."}</p>
        {:else}
          <ul class="member-list">
            {#each data.overworld.maps.slice(0, 5) as map (map.id)}
              <li>
                <div class="member-name">
                  <strong>{map.name}</strong>
                  {#if data.overworld.viewer.canManage && !map.granted}<span class="badge badge-muted">Not shared yet</span>{/if}
                </div>
                <a class="button-link compact-link" href="/campaigns/{campaign.id}/overworld/{map.id}">Open</a>
              </li>
            {/each}
          </ul>
          {#if data.overworld.maps.length > 5}
            <p class="muted">and {data.overworld.maps.length - 5} more.</p>
          {/if}
        {/if}
      </section>
    {/if}

    {#if data.findTableCount !== null}
      <section class="panel campaign-box">
        <div class="campaign-row">
          <h2>Foraging</h2>
          <span class="campaign-box-foot">
            <span class="muted">Find tables: {data.findTableCount} active</span>
            <a class="button-link compact-link" href="/forage/tables">Manage</a>
          </span>
        </div>
        {#if data.findTableCount === 0}
          <p class="muted">Foraging is off for this campaign until it has a find table with something to find.</p>
        {/if}
      </section>
    {/if}

    {#if data.overrideReviews.length}
      <section class="panel campaign-box">
        <h2>Over-budget uses to review</h2>
        <p class="muted">A player said you OK'd these. Mark OK, or Undo to refund what they spent.</p>
        <ul class="member-list">
          {#each data.overrideReviews as review (review.activationId)}
            <li>
              <div class="member-name">
                <strong>{review.characterName}</strong> - {review.sourceLabel}
                <span class="muted">{review.playerName}, {new Date(review.createdAt).toLocaleString()}{review.shortText ? `, short ${review.shortText}` : ''}</span>
              </div>
              <span class="campaign-box-foot">
                <form method="POST" action="?/reviewOk" use:enhance>
                  <input type="hidden" name="activationId" value={review.activationId} />
                  <button type="submit" class="compact-button">OK</button>
                </form>
                <form method="POST" action="?/reviewUndo" use:enhance={confirmFirst(`Undo ${review.characterName}'s ${review.sourceLabel}? What it spent is given back. Anything it did needs fixing by hand.`)}>
                  <input type="hidden" name="activationId" value={review.activationId} />
                  <button type="submit" class="compact-button danger">Undo</button>
                </form>
              </span>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
    {#if form?.reviewed}<p class="muted">{form.reviewed}</p>{/if}

    {#if !archived && showDecks}
      <section class="panel campaign-box">
        <div class="campaign-row">
          <h2>Decks</h2>
          {#if access.canManage}<a class="button-link compact-link deck-button" href="/campaigns/{campaign.id}/decks">Manage decks</a>{/if}
        </div>
        {#if data.decks.length === 0}
          <p class="muted">{access.canManage ? 'No decks on this campaign yet. Add one below, or create your own under Manage decks, and players can draw from it on their sheets and at the table.' : 'This campaign has no decks yet.'}</p>
        {:else}
          <ul class="member-list">
            {#each data.decks as deck (deck.id)}
              <li>
                <div class="member-name">
                  <strong>{deck.name}</strong>
                  {#if !deck.enabled}<span class="badge badge-muted">Off</span>{/if}
                  {#if deck.archived}<span class="badge badge-muted">Archived</span>{/if}
                </div>
                {#if access.canManage}
                  <form method="POST" action="?/setDeck" use:enhance>
                    <input type="hidden" name="deckId" value={deck.id} />
                    <input type="hidden" name="enabled" value={deck.enabled ? '0' : '1'} />
                    <button type="submit" class="compact-button deck-button" disabled={deck.archived && !deck.enabled}>{deck.enabled ? 'Disable' : 'Enable'}</button>
                  </form>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
        {#if access.canManage && data.availableDecks.length}
          <form method="POST" action="?/setDeck" use:enhance class="stack">
            <input type="hidden" name="enabled" value="1" />
            <label>
              Add a deck
              <select name="deckId" required>
                {#each data.availableDecks as deck (deck.id)}<option value={deck.id}>{deck.name}</option>{/each}
              </select>
            </label>
            <button type="submit" class="compact-button stack-button deck-button">Add deck</button>
          </form>
        {/if}
        {#if form?.saved === 'decks'}<p class="muted">Saved.</p>{/if}
      </section>

      {#if access.canManage && data.deckTasks.length}
        <section class="panel campaign-box">
          <h2>Waiting on you</h2>
          <p class="muted">Things a card left for the DM to sort out.</p>
          <ul class="member-list">
            {#each data.deckTasks as task (task.taskId)}
              <li>
                <div class="member-name"><strong>{task.cardLabel}</strong> <span>{task.text}</span></div>
                <form method="POST" action="?/taskDone" use:enhance>
                  <input type="hidden" name="drawId" value={task.drawId} />
                  <input type="hidden" name="taskId" value={task.taskId} />
                  <button type="submit" class="compact-button deck-button">Done</button>
                </form>
              </li>
            {/each}
          </ul>
        </section>
      {/if}

      {#if data.draws.length}
        <section class="panel campaign-box">
          <h2>Deck draws <span class="muted">(last {data.draws.length})</span></h2>
          {#if form?.saved === 'draws'}<p class="muted">{form.note ? `Undone. ${form.note}` : 'Saved.'}</p>{/if}
          <ul class="member-list deck-draws">
            {#each data.draws as draw (draw.id)}
              <li>
                <div class="deck-draw-body">
                  <strong>{draw.drawerName}</strong> drew the {cardTitle(draw.card)}
                  {#if draw.status !== 'cancelled' && draw.status !== 'choosing'}<span class="badge">{successLabel(draw.success)}</span>{/if}
                  {#if statusTag(draw)}<span class="badge badge-muted">{statusTag(draw)}</span>{/if}
                  <span class="muted">{draw.deckName} - {when(draw.createdAt)}</span>
                  {#if draw.status === 'resolved' || draw.status === 'reverted'}
                    {#if draw.outcome?.name}<span>{draw.outcome.name}</span>{/if}
                    {#each resultLines(draw) as line}<span class="muted">{line}</span>{/each}
                    {#if draw.status === 'reverted' && draw.revertNote}<span class="muted">{draw.revertNote}</span>{/if}
                  {/if}
                </div>
                {#if access.canManage && (draw.status === 'resolved' || draw.status === 'choosing')}
                  <form
                    method="POST"
                    action="?/undoDraw"
                    use:enhance={confirmFirst(draw.status === 'choosing' ? `Cancel ${draw.drawerName}'s undecided card?` : `Undo ${draw.drawerName}'s draw? Gold, HP and effects it changed are reversed where they still can be.`)}
                  >
                    <input type="hidden" name="drawId" value={draw.id} />
                    <button type="submit" class="compact-button danger deck-button">{draw.status === 'choosing' ? 'Cancel' : 'Undo'}</button>
                  </form>
                {/if}
              </li>
            {/each}
          </ul>
        </section>
      {/if}
    {/if}

    {#if !archived}
      <section class="panel campaign-box">
        <h2>Rules</h2>
        {#if access.canManage}
          <form method="POST" action="?/setActionEconomy" use:enhance class="stack">
            <label>
              Action economy
              <select name="actionEconomy" value={campaign.actionEconomy}>
                <option value="dnd5e">D&amp;D 5e (Action, Bonus action, Reaction per turn)</option>
                <option value="attack_utility">Attack &amp; Utility (2 Attack + 2 Utility per turn, homebrew)</option>
              </select>
            </label>
            <p class="muted">{PROFILES[campaign.actionEconomy]?.description} Characters in this campaign track their actions per turn this way.</p>
            <button type="submit" class="compact-button stack-button">Save rules</button>
          </form>
          {#if form?.saved === 'actionEconomy'}<p class="muted">Saved.</p>{/if}
        {:else}
          <p class="muted">Action economy: {PROFILES[campaign.actionEconomy]?.label}. {PROFILES[campaign.actionEconomy]?.description}</p>
        {/if}
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

<svelte:window onkeydown={(e) => { if (e.key === 'Escape' && removing) removing = null; }} />

{#if removing}
  <!-- "Remove the player as well?" Yes removes the member (which takes all their characters out and
       kicks them from the table); No removes just this character. Clicking the backdrop cancels. -->
  <div class="modal-backdrop" role="presentation" onpointerdown={(e) => { if (e.target === e.currentTarget) removing = null; }}>
    <div class="panel remove-character-modal" role="dialog" aria-modal="true" aria-labelledby="remove-character-title">
      <h2 id="remove-character-title">Remove {removing.name}?</h2>
      <p>Do you want to remove {removing.ownerName} from the campaign as well?</p>
      <p class="muted">Removing the player takes all their characters out of the campaign and removes them from the table.</p>
      <div class="remove-character-actions">
        <form method="POST" action="?/removeMember" use:enhance={closeAfterSubmit}>
          <input type="hidden" name="userId" value={removing.ownerUserId} />
          <button type="submit" class="compact-button danger">Yes, remove {removing.ownerName} too</button>
        </form>
        <form method="POST" action="?/removeCharacter" use:enhance={closeAfterSubmit}>
          <input type="hidden" name="characterId" value={removing.characterId} />
          <button type="submit" class="compact-button">No, just the character</button>
        </form>
        <button type="button" class="text-button" onclick={() => (removing = null)}>Cancel</button>
      </div>
    </div>
  </div>
{/if}

<style>
  /* Decks section: 44px tap targets, and the draw rows stack like cards on a phone. */
  .deck-button { min-height: 44px; min-width: 44px; }
  .deck-draw-body { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; min-width: 0; flex: 1 1 220px; overflow-wrap: anywhere; }
  .deck-draw-body > span:not(.badge) { flex-basis: 100%; }
</style>
