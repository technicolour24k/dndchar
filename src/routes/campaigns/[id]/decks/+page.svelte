<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';

  let { data, form } = $props();

  const deck = $derived(data.selected);
  const base = $derived(`/campaigns/${data.campaignId}/decks`);
  // After a failed save the typed text comes back in form.draft; otherwise show what is stored.
  const draft = $derived(form?.draft && form.draft.id === deck?.id ? form.draft : null);

  // The forms keep what was typed after a submit (no reset), so a warning-only save doesn't blank the box.
  const keepTyping: SubmitFunction = () => async ({ update }) => {
    await update({ reset: false });
  };
  const confirmArchive = (archived: boolean): SubmitFunction => ({ cancel }) => {
    if (!confirm(archived ? 'Archive this deck? It stays listed but nobody can draw from it.' : 'Restore this deck?')) cancel();
  };
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

{#if !data.requested}
  <p class="muted">Pick one of this campaign's decks above to edit it.</p>
{:else if deck}
  <section class="panel stack">
    <h2>{deck.name}{deck.archived ? ' (archived)' : ''}</h2>
    {#if form?.saveErrors}
      <div class="form-error" role="alert">
        <strong>Not saved. Fix these and save again:</strong>
        <ul>{#each form.saveErrors as message}<li>{message}</li>{/each}</ul>
      </div>
    {/if}
    {#if form?.saved === deck.id}
      <p class="form-success">Saved.</p>
      {#if form.warnings?.length}<ul class="deck-admin-warnings">{#each form.warnings as message}<li>{message}</li>{/each}</ul>{/if}
    {/if}
    {#if deck.errors.length}
      <div class="form-error"><strong>The stored rules are invalid, so this deck can't be drawn from:</strong>
        <ul>{#each deck.errors as message}<li>{message}</li>{/each}</ul></div>
    {/if}

    <form method="POST" action="?/save" use:enhance={keepTyping} class="stack">
      <input type="hidden" name="id" value={deck.id} />
      <label>Name <input name="name" maxlength="120" required value={draft?.name ?? deck.name} /></label>
      <label>Description <textarea name="description" rows="4" maxlength="5000" value={draft?.description ?? deck.description}></textarea></label>
      <label>Rules (JSON)
        <textarea name="rulesText" class="deck-admin-json" rows="18" spellcheck="false" autocomplete="off" required value={draft?.rulesText ?? deck.rulesText}></textarea>
      </label>
      <p class="muted">Saved only when the JSON parses, the limits hold, and every condition key is a live global condition.</p>
      <button type="submit" disabled={data.archived}>Save deck</button>
    </form>

    <form method="POST" action="?/archive" use:enhance={confirmArchive(!deck.archived)}>
      <input type="hidden" name="id" value={deck.id} />
      <input type="hidden" name="archived" value={deck.archived ? '0' : '1'} />
      <button type="submit" class="secondary" disabled={data.archived}>{deck.archived ? 'Restore deck' : 'Archive deck'}</button>
    </form>
  </section>

  {#if deck.warnings.length}
    <section class="panel stack">
      <h2>Warnings</h2>
      <ul class="deck-admin-warnings">{#each deck.warnings as message}<li>{message}</li>{/each}</ul>
    </section>
  {/if}

  {#if deck.summary}
    <section class="panel stack">
      <h2>Summary</h2>
      <p>{deck.summary.cardCount} cards: {deck.summary.byBack.map((entry) => `${entry.count} ${entry.back}`).join(', ') || 'none'}.</p>
      <h3>Success table (first match wins)</h3>
      <ul>{#each deck.summary.success as row}<li>{row}</li>{/each}</ul>
      <h3>Outcomes ({deck.summary.outcomes.length}, first match wins)</h3>
      <div class="deck-admin-outcomes">
        {#each deck.summary.outcomes as outcome (outcome.id)}
          <article class="deck-admin-outcome">
            <strong>{outcome.name}</strong> <span class="muted">{outcome.when}</span>
            <ul>{#each outcome.steps as step}<li>{step}</li>{/each}</ul>
          </article>
        {/each}
      </div>
    </section>

    <section class="panel stack">
      <h2>Test draw</h2>
      <p class="muted">Plans one card for a made-up party (Aria draws, with Brom and Cass) using the saved rules. Nothing is written.</p>
      <form method="POST" action="?/testDraw" use:enhance={keepTyping} class="stack">
        <input type="hidden" name="id" value={deck.id} />
        <label>Card
          <select name="cardId" required>
            {#each deck.cards as card (card.id)}<option value={card.id}>{card.label} ({card.id}){card.needsValue ? ' - needs a value' : ''}</option>{/each}
          </select>
        </label>
        <label>Result
          <select name="success">
            <option value="auto">As the rules say</option>
            <option value="success">Force success</option>
            <option value="failure">Force failure</option>
          </select>
        </label>
        <label>Value for a card with options (e.g. an Ace) <input name="value" type="number" min="0" max="999" /></label>
        <button type="submit">Test draw</button>
      </form>
      {#if form?.testError}<p class="form-error">{form.testError}</p>{/if}
      {#if form?.testLines}<ul class="deck-admin-test">{#each form.testLines as line}<li>{line}</li>{/each}</ul>{/if}
    </section>
  {/if}
{:else}
  <p class="form-error">That deck was not found in this campaign.</p>
{/if}

<style>
  .deck-admin-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  .deck-admin-link { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; min-height: 44px; padding: 8px 10px; border: 1px solid #444; border-radius: 6px; text-decoration: none; color: inherit; box-sizing: border-box; }
  .deck-admin-current .deck-admin-link { border-color: #4a7fff; }
  .deck-admin-global { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; justify-content: space-between; min-height: 44px; padding: 4px 10px; border: 1px solid #444; border-radius: 6px; }
  .deck-admin-create summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; }
  .deck-admin-json { font-family: ui-monospace, Consolas, monospace; font-size: 13px; width: 100%; box-sizing: border-box; }
  .deck-admin-warnings { color: #ffb300; }
  .deck-admin-outcome { padding: 6px 0; border-top: 1px solid #444; }
  .deck-admin-outcome ul { margin: 4px 0 0; padding-left: 18px; }
  .deck-admin-test { padding-left: 18px; }
  button, select, input:not([type='hidden']), summary { min-height: 44px; }
</style>
