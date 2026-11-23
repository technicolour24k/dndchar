<script lang="ts">
  import { enhance } from '$app/forms';
  import DeckEditor from '$lib/components/decks/DeckEditor.svelte';

  let { data, form } = $props();

  const deck = $derived(data.selected);
  const base = $derived(`/campaigns/${data.campaignId}/decks`);
  const cardText = (entry: { invalid: boolean; cardCount: number | null }) => (entry.invalid ? 'Rules invalid' : `${entry.cardCount} cards`);
</script>

<section class="page-head">
  <div>
    <p class="eyebrow"><a href="/campaigns/{data.campaignId}">{data.campaignName}</a></p>
    <h1>Manage decks</h1>
    <p class="muted">
      Decks you create here belong to this campaign only. Global decks can't be edited, but you can copy one into the
      campaign and change the copy. Rules are JSON: cards with tags, a success table and outcome templates. Decks are
      archived, never deleted. Turn a deck on for the table from the campaign page.
    </p>
  </div>
</section>

{#if data.archived}<p class="form-error">This campaign is archived, so its decks can no longer be changed.</p>{/if}
{#if form?.error}<p class="form-error">{form.error}</p>{/if}

<section class="panel stack">
  <h2>This campaign's decks</h2>
  <ul class="deck-admin-list">
    {#each data.decks.own as entry (entry.id)}
      <li class:deck-admin-current={deck?.id === entry.id}>
        <a class="deck-admin-link" href="{base}?deck={entry.id}">
          <strong>{entry.name}</strong>
          <span class="muted">{cardText(entry)}{entry.enabled ? ' - on' : ' - off'}{entry.archived ? ' - archived' : ''}</span>
        </a>
      </li>
    {:else}
      <li class="muted">None yet. Create one, or copy a global deck below.</li>
    {/each}
  </ul>
  {#if !data.archived}
    <details class="deck-admin-create">
      <summary>Create a deck</summary>
      <form method="POST" action="?/create" use:enhance class="stack">
        <label>Name <input name="name" maxlength="120" required /></label>
        <label>Description <textarea name="description" rows="3" maxlength="5000"></textarea></label>
        <p class="muted">A new deck starts empty (no cards). Add cards and outcomes in the JSON, then save.</p>
        <button type="submit">Create deck</button>
      </form>
    </details>
  {/if}
</section>

<section class="panel stack">
  <h2>Global decks</h2>
  <p class="muted">Read-only. Copy one into this campaign to edit your own version; the original stays as it is.</p>
  <ul class="deck-admin-list">
    {#each data.decks.global as entry (entry.id)}
      <li class="deck-admin-global">
        <span><strong>{entry.name}</strong> <span class="muted">{cardText(entry)}</span></span>
        {#if !data.archived}
          <form method="POST" action="?/copy" use:enhance>
            <input type="hidden" name="sourceId" value={entry.id} />
            <button type="submit" class="secondary">Copy to this campaign</button>
          </form>
        {/if}
      </li>
    {:else}
      <li class="muted">No global decks.</li>
    {/each}
  </ul>
</section>

<section class="panel stack">
  <h2>From libraries</h2>
  <p class="muted">
    Decks from members' libraries are used by reference, so the author's edits reach this campaign. They can't be edited or
    copied here, only turned on or off. A member's library is switched on from the Libraries page.
  </p>
  <ul class="deck-admin-list">
    {#each data.decks.library as entry (entry.id)}
      <li class="deck-admin-global">
        <span>
          <strong>{entry.name}</strong>
          <span class="muted">{cardText(entry)}{entry.enabled ? ' - on' : ' - off'}{entry.archived ? ' - archived' : ''}</span><br />
          <span class="muted">{entry.libraryOn ? `From ${entry.mine ? 'your' : `${entry.ownerName}'s`} library` : 'From a library not enabled here'}</span>
        </span>
        {#if !data.archived}
          {#if entry.enabled}
            <form method="POST" action="?/setEnabled" use:enhance>
              <input type="hidden" name="deckId" value={entry.id} />
              <input type="hidden" name="enabled" value="0" />
              <button type="submit" class="secondary">Turn off</button>
            </form>
          {:else if entry.libraryOn && !entry.archived}
            <form method="POST" action="?/setEnabled" use:enhance>
              <input type="hidden" name="deckId" value={entry.id} />
              <input type="hidden" name="enabled" value="1" />
              <button type="submit" class="secondary">Turn on</button>
            </form>
          {/if}
        {/if}
      </li>
    {:else}
      <li class="muted">No library decks here. Ask a member with a deck to share their library, then switch it on from the Libraries page.</li>
    {/each}
  </ul>
  <a class="button-link" href="/campaigns/{data.campaignId}/library">Libraries</a>
</section>

{#if !data.requested}
  <p class="muted">Pick one of this campaign's decks above to edit it.</p>
{:else if deck}
  <DeckEditor {deck} {form} saveDisabled={data.archived} archiveDisabled={data.archived}>
    {#snippet extra()}
      {#if data.decks.canSaveToLibrary && !data.archived}
        <form method="POST" action="?/saveToLibrary" use:enhance class="stack">
          <input type="hidden" name="id" value={deck.id} />
          <button type="submit" class="secondary">Save to my library</button>
          <p class="muted">Makes a separate copy in your library, so you can use this deck in your other campaigns. This campaign's deck stays as it is, and later edits to either one don't reach the other.</p>
        </form>
      {/if}
      {#if form?.savedToLibrary}
        <p class="form-success">Saved to your library. <a href="/library/decks?deck={form.savedToLibrary}">Open it</a></p>
      {/if}
    {/snippet}
  </DeckEditor>
{:else}
  <p class="form-error">That deck was not found in this campaign.</p>
{/if}

<style>
  .deck-admin-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  .deck-admin-link { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; min-height: 44px; padding: 8px 10px; border: 1px solid #444; border-radius: 6px; text-decoration: none; color: inherit; box-sizing: border-box; }
  .deck-admin-current .deck-admin-link { border-color: #4a7fff; }
  .deck-admin-global { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; justify-content: space-between; min-height: 44px; padding: 4px 10px; border: 1px solid #444; border-radius: 6px; }
  .deck-admin-create summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; }
  button, input:not([type='hidden']), summary { min-height: 44px; }
</style>
