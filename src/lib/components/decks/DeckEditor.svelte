<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import type { Snippet } from 'svelte';

  // The deck editor shared by the campaign deck page and the personal library deck page: name, description, rules JSON,
  // archive, warnings, summary and the test draw. Both pages post to the same action names (?/save, ?/archive,
  // ?/testDraw), so this component only needs the deck, the form result and which buttons are allowed.
  // `extra` is for page-specific buttons (e.g. "Save to my library") placed under the archive button.
  type Props = {
    deck: {
      id: string; name: string; description: string; archived: boolean; rulesText: string; errors: string[]; warnings: string[];
      summary: { cardCount: number; byBack: Array<{ back: string; count: number }>; success: string[]; outcomes: Array<{ id: string; name: string; when: string; steps: string[] }> } | null;
      cards: Array<{ id: string; label: string; needsValue: boolean }>;
    };
    form: Record<string, any> | null | undefined;
    /** Save is off (archived campaign, or no mechanics rights). */
    saveDisabled?: boolean;
    /** Archive and restore are off (archived campaign). */
    archiveDisabled?: boolean;
    extra?: Snippet;
  };
  let { deck, form, saveDisabled = false, archiveDisabled = false, extra }: Props = $props();

  // After a failed save the typed text comes back in form.draft; otherwise show what is stored.
  const draft = $derived(form?.draft && form.draft.id === deck.id ? form.draft : null);

  // The forms keep what was typed after a submit (no reset), so a warning-only save doesn't blank the box.
  const keepTyping: SubmitFunction = () => async ({ update }) => {
    await update({ reset: false });
  };
  const confirmArchive = (archived: boolean): SubmitFunction => ({ cancel }) => {
    if (!confirm(archived ? 'Archive this deck? It stays listed but nobody can draw from it.' : 'Restore this deck?')) cancel();
  };
</script>

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
    <p class="muted">Saved only when the JSON parses, the limits hold, and every condition key is a live condition this deck may use: a global one, or one from a library or campaign it belongs to.</p>
    <button type="submit" disabled={saveDisabled}>Save deck</button>
  </form>

  <form method="POST" action="?/archive" use:enhance={confirmArchive(!deck.archived)}>
    <input type="hidden" name="id" value={deck.id} />
    <input type="hidden" name="archived" value={deck.archived ? '0' : '1'} />
    <button type="submit" class="secondary" disabled={archiveDisabled}>{deck.archived ? 'Restore deck' : 'Archive deck'}</button>
  </form>

  {@render extra?.()}
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

<style>
  .deck-admin-json { font-family: ui-monospace, Consolas, monospace; font-size: 13px; width: 100%; box-sizing: border-box; }
  .deck-admin-warnings { color: #ffb300; }
  .deck-admin-outcome { padding: 6px 0; border-top: 1px solid #444; }
  .deck-admin-outcome ul { margin: 4px 0 0; padding-left: 18px; }
  .deck-admin-test { padding-left: 18px; }
  button, select, input:not([type='hidden']) { min-height: 44px; }
</style>
