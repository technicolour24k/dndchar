<script lang="ts">
  import { enhance } from '$app/forms';
  import DeckEditor from '$lib/components/decks/DeckEditor.svelte';

  let { data, form } = $props();

  const deck = $derived(data.selected);
  const cardText = (entry: { invalid: boolean; cardCount: number | null }) => (entry.invalid ? 'Rules invalid' : `${entry.cardCount} cards`);
  const tabs = [['/library?type=item', 'Items'], ['/library?type=spell', 'Spells'], ['/library?type=feat', 'Feats and features']] as const;
</script>

<section class="page-head">
  <div>
    <h1>Deck Library</h1>
    <p class="muted">
      Your own decks. A DM switches your library on for a campaign, then turns a deck on for the table. The campaign uses
      your deck by reference, so changes you save here reach every campaign using it. Rules are JSON. Decks are archived,
      never deleted.
    </p>
  </div>
</section>

<nav class="library-tabs" aria-label="Library sections">
  {#each tabs as tab}<a href={tab[0]}>{tab[1]}</a>{/each}
  <a href="/library/decks" class="active" aria-current="page">Decks</a>
  <a href="/library/conditions">Conditions</a>
</nav>

{#if !data.canAuthorMechanics}
  <p class="panel library-banner">Decks are for DMs and admins, because their rules count as mechanics. You can still archive or restore any you already have.</p>
{/if}
{#if form?.error}<p class="form-error">{form.error}</p>{/if}

<section class="panel stack">
  <h2>Your decks</h2>
  <ul class="deck-admin-list">
    {#each data.decks as entry (entry.id)}
      <li class:deck-admin-current={deck?.id === entry.id}>
        <a class="deck-admin-link" href="/library/decks?deck={entry.id}">
          <strong>{entry.name}</strong>
          <span class="muted">{cardText(entry)} - used in {entry.enabledIn} {entry.enabledIn === 1 ? 'campaign' : 'campaigns'}{entry.archived ? ' - archived' : ''}</span>
        </a>
      </li>
    {:else}
      <li class="muted">No decks yet.</li>
    {/each}
  </ul>
  {#if data.canAuthorMechanics}
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

{#if !data.requested}
  <p class="muted">Pick one of your decks above to edit it.</p>
{:else if deck}
  <p class="panel library-banner">Used in {data.campaigns} {data.campaigns === 1 ? 'campaign' : 'campaigns'}. Changes apply to all of them.</p>
  <DeckEditor {deck} {form} saveDisabled={!data.canAuthorMechanics} />
{:else}
  <p class="form-error">That deck was not found in your library.</p>
{/if}

<style>
  .library-tabs { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
  .library-tabs a { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 16px; border: 1px solid var(--line); border-radius: 8px; color: var(--text); text-decoration: none; font-weight: 700; }
  .library-tabs a.active { background: #153045; border-color: #62b7f0; }
  .library-banner { padding: 12px; margin: 0; }
  .deck-admin-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  .deck-admin-link { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; min-height: 44px; padding: 8px 10px; border: 1px solid #444; border-radius: 6px; text-decoration: none; color: inherit; box-sizing: border-box; }
  .deck-admin-current .deck-admin-link { border-color: #4a7fff; }
  .deck-admin-create summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; }
  button, input:not([type='hidden']), summary { min-height: 44px; }
  @media (max-width: 720px) { .library-tabs a { flex: 1 1 auto; } }
</style>
