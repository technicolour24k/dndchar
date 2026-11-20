<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';

  let { data, form } = $props();

  // Form actions post to "?/name", which would drop the filters from the URL on a no-JS submit, so
  // the current filters ride along on the action URL.
  const filterQuery = $derived(
    new URLSearchParams(Object.entries(data.filter).filter(([, value]) => value) as [string, string][]).toString()
  );
  const actionUrl = (name: string) => `?/${name}${filterQuery ? `&${filterQuery}` : ''}`;

  const STATUS_OPTIONS: Array<[string, string]> = [
    ['all', 'All'], ['found', 'Found'], ['reverted', 'Undone'], ['failed', 'Failed'],
    ['checked', 'Unmarked checks'], ['self', 'Self-served'], ['dm', 'DM-approved']
  ];

  const when = (iso: string) => new Date(iso).toLocaleString();
  const modeLabel = (mode: string) => (mode === 'self' ? 'Self-served' : 'DM-approved');
  const statusLabel = (status: string) =>
    ({ found: 'Found', reverted: 'Undone', failed: 'Failed', checked: 'Unmarked check' } as Record<string, string>)[status] ?? status;

  // Plain confirm before an undo: it changes the player's inventory.
  // Asks first, through enhance's cancel() (enhance ignores preventDefault() from onsubmit).
  function confirmUndo(characterName: string): SubmitFunction {
    return ({ cancel }) => {
      if (!confirm(`Undo ${characterName}'s find? This reduces or removes the inventory rows it added.`)) cancel();
    };
  }
</script>

<section class="page-head">
  <div>
    <p class="eyebrow">Administration</p>
    <h1>Finds Review</h1>
    <p class="muted">
      Every forage find, newest first (200 at most). Find tables are edited at <a href="/forage/tables">/forage/tables</a>.
    </p>
  </div>
</section>

{#if form?.error}<p class="form-error">{form.error}</p>{/if}
{#if form?.undone}<p class="form-success">Undone. {form.note}</p>{/if}
{#if form?.cleared}<p class="form-success">Check cleared. The player can forage again.</p>{/if}

<section class="panel stack">
  <div>
    <h2>Stuck unmarked checks ({data.stuck.length})</h2>
    <p class="muted">
      A self-serve check that was rolled but never marked pass or fail blocks that player from foraging again.
      Clearing closes it as a failed find (nothing is added).
    </p>
  </div>
  {#each data.stuck as check (check.id)}
    <div class="admin-find">
      <div class="admin-find-head">
        <strong>{check.characterName}</strong>
        <span class="muted">{check.ownerName} - {when(check.createdAt)}{#if check.checkSummary} - {check.checkSummary}{/if} - {check.tableName}</span>
      </div>
      <form method="POST" action={actionUrl('clearCheck')} use:enhance>
        <input type="hidden" name="findId" value={check.id} />
        <button type="submit" class="secondary">Clear</button>
      </form>
    </div>
  {:else}
    <p class="muted">None. Nobody is stuck.</p>
  {/each}
</section>

<section class="panel stack">
  <h2>Finds</h2>
  <form method="GET" class="admin-find-filters">
    <label>Session
      <select name="session">
        <option value="">All sessions</option>
        {#each data.options.sessions as session (session.id)}
          <option value={session.id} selected={data.filter.session === session.id}>{session.name} ({new Date(session.createdAt).toLocaleDateString()})</option>
        {/each}
      </select>
    </label>
    <label>Character
      <select name="character">
        <option value="">All characters</option>
        {#each data.options.characters as character (character.id)}
          <option value={character.id} selected={data.filter.character === character.id}>{character.name}</option>
        {/each}
      </select>
    </label>
    <label>Status / mode
      <select name="status">
        {#each STATUS_OPTIONS as [value, label]}
          <option {value} selected={data.filter.status === value}>{label}</option>
        {/each}
      </select>
    </label>
    <button type="submit">Filter</button>
  </form>

  {#each data.finds as find (find.id)}
    <article class="admin-find" class:admin-find-reverted={find.status === 'reverted'}>
      <div class="admin-find-head">
        <strong>{find.characterName}</strong>
        <span class="status-chip">{statusLabel(find.status)}</span>
        <span class="status-chip">{modeLabel(find.mode)}</span>
        {#if find.shared}<span class="status-chip">Shared</span>{/if}
        <span class="muted">{find.ownerName} - {when(find.createdAt)}</span>
      </div>
      <p class="muted">
        {find.tableName}{#if find.checkSummary} - {find.checkSummary}{/if}{#if find.nat20} (nat 20, two runs){/if}
        {#if find.gameSessionName} - session: {find.gameSessionName}{:else} - no game session{/if}
      </p>
      {#if find.items.length}
        <ul class="admin-find-items">
          {#each find.items as item}
            <li>
              {item.name} x{item.qty}
              <span class="muted">
                - inventory row now:
                {#if item.row}{item.row.name} x{item.row.quantity}{:else}gone{/if}
              </span>
            </li>
          {/each}
        </ul>
      {:else if find.status !== 'checked'}
        <p class="muted">No items.</p>
      {/if}
      {#if find.revertNote}<p class="muted">Note: {find.revertNote}</p>{/if}
      {#if find.status === 'found'}
        <form method="POST" action={actionUrl('undoFind')} use:enhance={confirmUndo(find.characterName)}>
          <input type="hidden" name="findId" value={find.id} />
          <button type="submit" class="danger">Undo</button>
        </form>
      {/if}
    </article>
  {:else}
    <p class="muted">No finds match.</p>
  {/each}
</section>

<style>
  .admin-find { display: grid; gap: 6px; padding: 10px; border: 1px solid var(--line); border-radius: 6px; }
  .admin-find-reverted { opacity: .75; }
  .admin-find-head { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; }
  .admin-find-items { margin: 0; padding-left: 18px; }
  .admin-find-filters { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; align-items: end; }
  .admin-find-filters select { width: 100%; min-width: 0; }
  /* Phone width: keep every tap target comfortable and let long names wrap. */
  @media (max-width: 600px) {
    .admin-find button, .admin-find-filters button { min-height: 44px; width: 100%; }
    .admin-find-filters { grid-template-columns: 1fr; }
  }
</style>
