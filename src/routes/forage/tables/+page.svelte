<script lang="ts">
  import CatalogueSearch from '$lib/components/character/CatalogueSearch.svelte';

  let { data, form } = $props();

  let search = $state('');
  let newItemId = $state('');

  const selected = $derived(data.selected);
  const canEdit = $derived(!!selected?.canEdit);

  const filtered = $derived(
    data.tables.filter((table: (typeof data.tables)[number]) =>
      `${table.name} ${table.areaType} ${table.category}`.toLowerCase().includes(search.trim().toLowerCase())
    )
  );

  // Group the list by area type, as the plan's left-hand panel asks.
  const groups = $derived.by(() => {
    const map = new Map<string, typeof filtered>();
    for (const table of filtered) {
      const list = map.get(table.areaType) ?? [];
      list.push(table);
      map.set(table.areaType, list);
    }
    return [...map.entries()];
  });

  // Chance is each pickable entry's share of the pickable weight (weight 0 and archived items get 0%).
  // It is the chance of being among the picks given a pick happens, not of appearing in a run,
  // because the type die decides how many distinct items come out.
  const totalWeight = $derived(
    data.entries.reduce((sum: number, entry: (typeof data.entries)[number]) => sum + (entry.weight > 0 && !entry.itemArchived ? entry.weight : 0), 0)
  );
  function chance(entry: (typeof data.entries)[number]): string {
    if (entry.weight <= 0 || entry.itemArchived || totalWeight <= 0) return '0%';
    return `${Math.round((entry.weight / totalWeight) * 100)}%`;
  }
</script>

<section class="page-head">
  <div>
    <p class="eyebrow">Forage</p>
    <h1>Find Tables</h1>
    <p>
      Weighted loot tables for foraging, one per area type and category. Anyone can make a table and use
      anyone's. You can edit your own, and admins can edit any.
    </p>
  </div>
</section>
{#if form?.error}<p class="form-error">{form.error}</p>{/if}

<div class="forage-layout">
  <aside class="panel stack forage-list-panel">
    <div class="panel-head"><h2>Tables</h2><span class="muted">{data.tables.length}</span></div>
    <label class="admin-search-field">
      <span class="sr-only">Search tables</span>
      <input bind:value={search} placeholder="Search tables..." />
    </label>

    <details class="admin-create-disclosure">
      <summary>+ New table</summary>
      <form method="POST" action="?/createTable" class="stack admin-form">
        <h3>Create table</h3>
        <label>Name<input name="name" maxlength="80" placeholder="Meadow - plants" required /></label>
        <div class="mini-grid">
          <label>Area type<input name="areaType" list="forage-areas" maxlength="40" placeholder="meadow" required /></label>
          <label>Category<input name="category" list="forage-categories" maxlength="40" placeholder="plant" required /></label>
        </div>
        <label>Type die<input name="typeDie" type="number" min="1" max="100" value="6" required /></label>
        <label>Suggested check (DM reminder)<input name="suggestedCheck" maxlength="80" placeholder="Nature DC 12" /></label>
        <button type="submit">Create table</button>
      </form>
    </details>

    <div class="admin-library-list">
      {#each groups as [area, tables] (area)}
        <p class="forage-group-label">{area}</p>
        {#each tables as table (table.id)}
          <a href={`?table=${table.id}`} class="admin-library-item forage-list-item" class:active={table.id === selected?.id}>
            <span class="admin-library-icon" aria-hidden="true">{table.category.slice(0, 1).toUpperCase()}</span>
            <span>
              <strong>{table.name}</strong>
              <small>{table.category} · {table.pickableCount} pickable{table.isArchived ? ' · archived' : ''}</small>
            </span>
            <span class="admin-library-arrow" aria-hidden="true">›</span>
          </a>
        {/each}
      {:else}
        <p class="muted">{data.tables.length ? 'No matching tables.' : 'No tables yet. Create one to begin.'}</p>
      {/each}
    </div>
  </aside>

  <section class="panel stack forage-editor-panel">
    {#if selected}
      <div class="panel-head">
        <div>
          <p class="eyebrow">{selected.areaType} / {selected.category}</p>
          <h2>{selected.name}</h2>
          <p class="muted">By {selected.ownerName ?? 'nobody (admin only)'}</p>
        </div>
        <span class="status-chip">{selected.isArchived ? 'Archived' : 'Active'}</span>
      </div>

      {#if canEdit}
        <form method="POST" action="?/updateTable" class="stack">
          <input type="hidden" name="tableId" value={selected.id} />
          <label>Name<input name="name" value={selected.name} maxlength="80" required /></label>
          <div class="mini-grid">
            <label>Area type<input name="areaType" list="forage-areas" value={selected.areaType} maxlength="40" required /></label>
            <label>Category<input name="category" list="forage-categories" value={selected.category} maxlength="40" required /></label>
          </div>
          <div class="mini-grid">
            <label>Type die<input name="typeDie" type="number" min="1" max="100" value={selected.typeDie} required /></label>
            <label>Suggested check (DM reminder)<input name="suggestedCheck" value={selected.suggestedCheck} maxlength="80" /></label>
          </div>
          <p class="muted">
            The type die sets how many different items a find can contain: roll 1d{selected.typeDie}, capped at the pickable items below.
            Only you, and admins, see the suggested check. Players never do.
          </p>
          <div class="button-row">
            <button type="submit">Save table</button>
            <button type="submit" formaction="?/archiveTable" class="danger">{selected.isArchived ? 'Restore' : 'Archive'}</button>
          </div>
        </form>
      {:else}
        <p class="muted">
          {selected.areaType} / {selected.category}, type die d{selected.typeDie}. This is {selected.ownerName ?? 'someone else'}'s table, so it is read-only for you.
        </p>
      {/if}

      <h3>Entries <span class="muted">({data.entries.length}, {selected.pickableCount} pickable)</span></h3>
      <p class="muted">
        Weight is the relative chance of being picked (0 never picks it). The quantity die is rolled for how many you get (d1 is always one).
        Archived items and weight 0 are not pickable.
      </p>

      {#if !data.entries.length}
        <p class="muted forage-empty">This table is empty. Players can't forage from it until it has a pickable item.</p>
      {:else}
        <form method="POST" action="?/saveEntries" class="stack">
          <input type="hidden" name="tableId" value={selected.id} />
          <div class="forage-entries">
            <div class="forage-entry forage-entry-head" aria-hidden="true">
              <span>Item</span><span>Weight</span><span>Qty die</span><span>Chance</span><span></span>
            </div>
            {#each data.entries as entry (entry.itemId)}
              <div class="forage-entry" class:forage-entry-dead={entry.itemArchived || entry.weight <= 0}>
                <input type="hidden" name="entryItem" value={entry.itemId} />
                <span class="forage-entry-name">
                  <strong>{entry.itemName}</strong>
                  <small class="muted">{entry.itemCategory}</small>
                  {#if entry.itemArchived}<span class="status-chip">Archived item</span>{/if}
                </span>
                <label class="forage-entry-field"><span class="forage-entry-label">Weight</span>
                  <input name="weight" type="number" min="0" max="1000" value={entry.weight} disabled={!canEdit} />
                </label>
                <label class="forage-entry-field"><span class="forage-entry-label">Qty die d</span>
                  <input name="qtyDie" type="number" min="1" max="100" value={entry.qtyDie} disabled={!canEdit} />
                </label>
                <span class="forage-entry-chance"><span class="forage-entry-label">Chance </span>{chance(entry)}</span>
                {#if canEdit}
                  <button type="submit" form={`remove-${entry.itemId}`} class="danger">Remove</button>
                {:else}<span></span>{/if}
              </div>
            {/each}
          </div>
          {#if canEdit}<button type="submit">Save entries</button>{/if}
        </form>
        <!-- Remove lives in its own small forms (linked by the form attribute) so Enter in a number
             field submits Save entries, never the first row's Remove. -->
        {#if canEdit}
          {#each data.entries as entry (entry.itemId)}
            <form id={`remove-${entry.itemId}`} method="POST" action="?/removeEntry" hidden>
              <input type="hidden" name="tableId" value={selected.id} />
              <input type="hidden" name="itemId" value={entry.itemId} />
            </form>
          {/each}
        {/if}
      {/if}

      {#if canEdit}
        <form method="POST" action="?/addEntry" class="stack admin-form forage-add">
          <h3>Add item</h3>
          <input type="hidden" name="tableId" value={selected.id} />
          <input type="hidden" name="itemId" value={newItemId} />
          <CatalogueSearch type="item" placeholder="Search items..." onPick={(id) => { newItemId = id; }} />
          <div class="mini-grid">
            <label>Weight<input name="weight" type="number" min="0" max="1000" value="1" /></label>
            <label>Qty die d<input name="qtyDie" type="number" min="1" max="100" value="1" /></label>
          </div>
          <button type="submit" disabled={!newItemId}>Add item</button>
        </form>
      {/if}
    {:else}
      <p class="muted">Pick a table on the left, or create one.</p>
    {/if}
  </section>
</div>

<datalist id="forage-areas">{#each data.areaSuggestions as area}<option value={area}></option>{/each}</datalist>
<datalist id="forage-categories">{#each data.categorySuggestions as category}<option value={category}></option>{/each}</datalist>
