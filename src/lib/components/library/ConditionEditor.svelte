<script lang="ts">
  import { enhance } from '$app/forms';

  // The condition editor shared by /library/conditions (your own conditions) and /campaigns/[id]/homebrew (the campaign's
  // copies). The two pages differ only in what they list, where a list row links, and whether a new condition can be made
  // (a campaign copy is never made from scratch). The form actions are relative (?/save, ?/archive, ...), so each page
  // supplies the same action names.
  let { data, form, selectHref, listTitle = 'Your conditions', emptyText = 'No conditions yet.', canCreate = true, note = '' }: {
    data: any; form: any; selectHref: (id: string) => string; listTitle?: string; emptyText?: string; canCreate?: boolean; note?: string;
  } = $props();

  const sel = $derived(data.selected);
  const modifierLabel = (m: any) => m.label || `${m.hookLabel} / ${m.operation}${m.baseValue ? ' / ' + m.baseValue : ''}`;
</script>

<section class="panel stack">
  <h2>{listTitle}</h2>
  <ul class="cond-list">
    {#each data.conditions as entry (entry.id)}
      <li class:cond-current={sel?.id === entry.id}>
        <a class="cond-link" href={selectHref(entry.id)}>
          <strong>{entry.name}</strong>
          <span class="muted">{entry.modifierCount} modifier{entry.modifierCount === 1 ? '' : 's'}{entry.isArchived ? ' - archived' : ''}</span>
        </a>
      </li>
    {:else}
      <li class="muted">{emptyText}</li>
    {/each}
  </ul>
  {#if canCreate && data.canAuthorMechanics}
    <details class="cond-create">
      <summary>Create a condition</summary>
      <form method="POST" action="?/create" use:enhance class="stack">
        <input type="hidden" name="sourceType" value="homebrew" />
        <input type="hidden" name="isSelectable" value="on" />
        <label>Name <input name="name" maxlength="200" required /></label>
        <label>Description <textarea name="description" rows="3"></textarea></label>
        <p class="muted">Duration, stacking and the rest can be set once it exists. Then attach modifiers.</p>
        <button type="submit">Create condition</button>
      </form>
    </details>
  {/if}
</section>

{#if sel}
  <section class="panel stack">
    <h2>{sel.name}{sel.isArchived ? ' (archived)' : ''}</h2>
    {#if note}<p class="muted">{note}</p>{/if}
    {#if data.holders}
      <p class="muted">Held by {data.holders.characters} {data.holders.characters === 1 ? 'character' : 'characters'}, named by {data.holders.decks} {data.holders.decks === 1 ? 'deck' : 'decks'}. Changes apply to all of them.</p>
    {/if}
    {#if data.canAuthorMechanics}
      <form method="POST" action="?/save" use:enhance={() => async ({ update }) => { await update({ reset: false }); }} class="stack">
        <input type="hidden" name="effectId" value={sel.id} />
        <input type="hidden" name="sourceType" value="homebrew" />
        <input type="hidden" name="isSelectable" value="on" />
        <label>Name <input name="name" maxlength="200" required value={sel.name} /></label>
        <label>Description <textarea name="description" rows="4">{sel.description}</textarea></label>
        <div class="cond-grid">
          <label>Duration
            <select name="durationType">
              <option value="variable" selected={sel.durationType === 'variable'}>Variable</option>
              <option value="timed" selected={sel.durationType === 'timed'}>Timed</option>
              <option value="concentration" selected={sel.durationType === 'concentration'}>Concentration</option>
              <option value="while_applicable" selected={sel.durationType === 'while_applicable'}>While applicable</option>
            </select>
          </label>
          <label>Rounds <input type="number" min="0" name="durationRounds" value={sel.durationRounds ?? ''} /></label>
          <label>Stacking
            <select name="stackBehavior">
              <option value="refresh" selected={sel.stackBehavior === 'refresh'}>Refresh</option>
              <option value="stack" selected={sel.stackBehavior === 'stack'}>Stack</option>
              <option value="reject" selected={sel.stackBehavior === 'reject'}>Reject</option>
            </select>
          </label>
          <label>Expiry
            <select name="expiryBoundary">
              <option value="round_end" selected={sel.expiryBoundary === 'round_end'}>End of round</option>
              <option value="turn_start" selected={sel.expiryBoundary === 'turn_start'}>Start of turn</option>
              <option value="turn_end" selected={sel.expiryBoundary === 'turn_end'}>End of turn</option>
              <option value="manual" selected={sel.expiryBoundary === 'manual'}>Manual</option>
              <option value="next_attack" selected={sel.expiryBoundary === 'next_attack'}>Until next attack</option>
            </select>
          </label>
        </div>
        <label class="inline"><input type="checkbox" name="requiresConcentration" checked={sel.requiresConcentration} /> Concentration</label>
        <label class="inline"><input type="checkbox" name="isCondition" checked={sel.isCondition} /> Harmful condition</label>
        <button type="submit">Save condition</button>
      </form>
    {:else}
      <p>{sel.description}</p>
    {/if}

    <form method="POST" action="?/archive" use:enhance={({ cancel }) => { if (!confirm(sel.isArchived ? 'Restore this condition?' : 'Archive this condition? It stays on whoever has it, but is no longer offered.')) cancel(); }}>
      <input type="hidden" name="effectId" value={sel.id} />
      <button type="submit" class="secondary">{sel.isArchived ? 'Restore condition' : 'Archive condition'}</button>
    </form>
  </section>

  <section class="panel stack">
    <h2>Modifiers</h2>
    {#if data.canAuthorMechanics}
      <form method="POST" action="?/attach" use:enhance class="stack">
        <input type="hidden" name="effectId" value={sel.id} />
        <label>Modifier
          <select name="modifierId" required>
            {#each data.modifiers as m (m.id)}<option value={m.id}>{modifierLabel(m)}</option>{/each}
          </select>
        </label>
        <label>Value override <input name="valueOverride" /></label>
        <label>Condition <input name="condition" /></label>
        <label>Priority <input type="number" name="priority" value="0" /></label>
        <button type="submit">Attach modifier</button>
      </form>
    {/if}
    <ul class="cond-list">
      {#each data.links as link (link.id)}
        <li class="cond-row">
          <span><strong>{link.hookLabel} / {link.operation}</strong><br /><span class="muted">{link.valueExpression || 'Default value'}{link.condition ? ' - ' + link.condition : ''}</span></span>
          <form method="POST" action="?/detach" use:enhance>
            <input type="hidden" name="effectId" value={sel.id} />
            <input type="hidden" name="linkId" value={link.id} />
            <button type="submit" class="secondary">Remove</button>
          </form>
        </li>
      {:else}
        <li class="muted">No modifiers attached.</li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .cond-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  .cond-link { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; min-height: 44px; padding: 8px 10px; border: 1px solid #444; border-radius: 6px; text-decoration: none; color: inherit; box-sizing: border-box; }
  .cond-current .cond-link { border-color: #4a7fff; }
  .cond-row { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; justify-content: space-between; min-height: 44px; padding: 4px 10px; border: 1px solid #444; border-radius: 6px; }
  .cond-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
  .cond-create summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; }
  button, select, input:not([type='hidden']):not([type='checkbox']), summary { min-height: 44px; }
  .inline { min-height: 44px; display: flex; align-items: center; gap: 8px; }
</style>
