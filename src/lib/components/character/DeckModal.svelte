<script lang="ts">
  import { untrack } from 'svelte';
  import { backdropPress } from '$lib/ui/backdropPress';
  import type { DrawView } from '$lib/types/decks';
  import {
    cardTitle, choiceOptions, errorText, recentLine, resultLines, rollLines, statusTag, successLabel, taskLine, taskLines
  } from '../../../../static/vtt-app/shared/deckView.js';

  // The character sheet's Decks popup (decks plan, unit 7): draw a card, pick the Ace's value, read the result,
  // and (campaign DMs) undo a draw or tick off a "waiting on the DM" task. All rules and randomness live on the
  // server (/vtt/api/decks); this only shows what came back. Closing never cancels anything: an undecided Ace
  // stays undecided and reopens at the choice.
  let {
    characterId,
    decks,
    canManage,
    refreshTick,
    onChanged,
    onClose
  }: {
    characterId: string;
    decks: Array<{ id: string; name: string; description: string }>;
    // Campaign DM / co-DM: may undo a draw and mark DM tasks done (the server checks it again).
    canManage: boolean;
    // Bumped by the sheet (a deck:ping, a resync) so an open popup refetches.
    refreshTick: number;
    // A draw, choice or undo changed the character: the sheet decides whether to reload now or wait for Save.
    onChanged: () => void;
    onClose: () => void;
  } = $props();

  const API = '/vtt/api/decks';

  async function api(method: string, url: string, body?: unknown) {
    try {
      const res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined
      });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, data };
    } catch {
      return { ok: false, status: 0, data: { error: 'network' } };
    }
  }

  let deckId = $state(untrack(() => decks[0]?.id ?? ''));
  let busy = $state(false);
  let loading = $state(true);
  let message = $state('');
  let choosing = $state<DrawView | null>(null);
  let result = $state<DrawView | null>(null);
  let recent = $state<DrawView[]>([]);
  const deck = $derived(decks.find((entry) => entry.id === deckId) ?? decks[0] ?? null);

  // Only the latest load may write state: an older GET that returns after an action must not flip the modal back
  // (e.g. to the Ace screen after choose()). Every action bumps this too, so loads started before it are dropped.
  let loadSeq = 0;
  async function load() {
    const seq = ++loadSeq;
    const { ok, data } = await api('GET', `${API}?characterId=${encodeURIComponent(characterId)}`);
    if (seq !== loadSeq) return;
    loading = false;
    if (!ok) { message = errorText(data?.error); return; }
    choosing = data.choosing ?? null;
    recent = data.recent ?? [];
  }

  // Loads on open and whenever the sheet bumps the tick.
  $effect(() => {
    void refreshTick;
    void load();
  });

  async function draw() {
    if (!deck || busy) return;
    busy = true; loadSeq += 1; message = ''; result = null;
    const { ok, status, data } = await api('POST', `${API}/draw`, { characterId, deckId: deck.id });
    busy = false;
    if (ok) {
      if (data.status === 'choosing') choosing = data.draw; else { result = data.draw; onChanged(); }
    } else {
      // 409 'choosing' carries the undecided draw: resume at the choice.
      if (status === 409 && data?.draw) choosing = data.draw;
      message = errorText(data?.error);
    }
    await load();
  }

  async function choose(value: number) {
    if (!choosing || busy) return;
    busy = true; loadSeq += 1; message = '';
    const { ok, data } = await api('POST', `${API}/draws/${choosing.id}/choose`, { value });
    busy = false;
    if (ok) { result = data.draw; choosing = null; onChanged(); } else message = errorText(data?.error);
    await load();
  }

  async function undo(draw: DrawView) {
    if (busy || !window.confirm(`Undo ${recentLine(draw)}? This reverses what it changed.`)) return;
    busy = true; loadSeq += 1; message = '';
    const { ok, data } = await api('POST', `${API}/draws/${draw.id}/undo`);
    busy = false;
    if (ok) { if (result?.id === draw.id) result = data.draw; onChanged(); } else message = errorText(data?.error);
    await load();
  }

  async function taskDone(draw: DrawView, taskId: string, done: boolean) {
    if (busy) return;
    busy = true; loadSeq += 1; message = '';
    const { ok, data } = await api('POST', `${API}/draws/${draw.id}/tasks`, { taskId, done });
    busy = false;
    if (ok) { if (result?.id === draw.id) result = data.draw; } else message = errorText(data?.error);
    await load();
  }
</script>

<div class="modal-backdrop" role="presentation" onpointerdown={backdropPress(onClose)}>
  <div
    class="panel compact-modal roll-options deck-sheet"
    role="dialog"
    aria-modal="true"
    aria-labelledby="deck-title"
    tabindex="-1"
    onpointerdown={(event) => event.stopPropagation()}
  >
    <div class="panel-head">
      <h2 id="deck-title">Decks</h2>
      <button type="button" class="text-button" onclick={onClose}>Close</button>
    </div>

    {#snippet drawCard(entry: DrawView)}
      <section class="roll-options-section deck-result">
        <h3>{cardTitle(entry.card)} <span class="deck-badge" class:good={entry.success === true} class:neutral={entry.success == null}>{successLabel(entry.success)}</span></h3>
        {#if entry.outcome?.name}<p><strong>{entry.outcome.name}</strong>{#if entry.outcome.text}: {entry.outcome.text}{/if}</p>{/if}
        {#each rollLines(entry) as line}<p class="muted">{line}</p>{/each}
        {#if resultLines(entry).length}
          <ul class="deck-lines">{#each resultLines(entry) as line}<li>{line}</li>{/each}</ul>
        {/if}
        {#each taskLines(entry) as line}<p class="forage-warn">{line}</p>{/each}
        {#if entry.status === 'reverted'}<p class="muted">Undone by the DM{entry.revertNote ? `: ${entry.revertNote}` : ''}</p>{/if}
      </section>
    {/snippet}

    {#if loading}
      <p class="muted">Loading...</p>
    {:else if choosing}
      <!-- An Ace: nothing has been applied yet. Closing leaves it here to finish later. -->
      <section class="roll-options-section">
        <h3>{cardTitle(choosing.card)} <span class="deck-badge" class:good={choosing.success === true} class:neutral={choosing.success == null}>{successLabel(choosing.success)}</span></h3>
        <p>An Ace counts as 1 or 11. Pick one: nothing happens until you do.</p>
        {#each choiceOptions(choosing) as option (option.value)}
          <div class="deck-choice">
            <button type="button" disabled={busy} onclick={() => choose(option.value)}>{option.label}</button>
            {#if option.preview}<span class="muted">{option.preview}</span>{/if}
          </div>
        {/each}
      </section>
    {:else}
      {#if decks.length > 1}
        <label class="forage-field">Deck
          <select bind:value={deckId}>{#each decks as entry (entry.id)}<option value={entry.id}>{entry.name}</option>{/each}</select>
        </label>
      {:else if deck}
        <p><strong>{deck.name}</strong></p>
      {/if}
      {#if deck?.description}<details><summary>About this deck</summary><p class="muted deck-description">{deck.description}</p></details>{/if}
      {#if result}{@render drawCard(result)}{/if}
      <div class="roll-options-actions forage-actions">
        <button type="button" disabled={busy || !deck} onclick={draw}>{result ? 'Draw another card' : 'Draw a card'}</button>
      </div>
    {/if}

    {#if message}<p class="forage-error" role="alert">{message}</p>{/if}

    {#if recent.length}
      <details class="deck-recent">
        <summary>Recent draws ({recent.length})</summary>
        {#each recent as entry (entry.id)}
          <div class="deck-recent-row">
            <p>{recentLine(entry)}{#if statusTag(entry)} <span class="deck-badge">{statusTag(entry)}</span>{/if}</p>
            {#if entry.status === 'resolved'}
              {#each resultLines(entry) as line}<p class="muted">{line}</p>{/each}
            {/if}
            {#if entry.status === 'resolved'}
              {#each entry.dmTasks.filter((task) => !task.done) as task (task.id)}
                <p class="forage-warn">{taskLine(task)}
                  {#if canManage}<button type="button" class="text-button" disabled={busy} onclick={() => taskDone(entry, task.id, true)}>Done</button>{/if}
                </p>
              {/each}
            {/if}
            {#if canManage && (entry.status === 'resolved')}
              <button type="button" class="text-button" disabled={busy} onclick={() => undo(entry)}>Undo</button>
            {/if}
          </div>
        {/each}
      </details>
    {/if}
  </div>
</div>
