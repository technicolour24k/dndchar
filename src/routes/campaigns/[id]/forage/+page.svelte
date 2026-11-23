<script lang="ts">
  import CatalogueSearch from '$lib/components/character/CatalogueSearch.svelte';
  import { CHANCE_OPTIONS, DEFAULT_CHANCE } from '$lib/rules/forage';

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

  // Group the list by area type (tables arrive sorted by area, category, name).
  const groups = $derived.by(() => {
    const map = new Map<string, typeof filtered>();
    for (const table of filtered) map.set(table.areaType, [...(map.get(table.areaType) ?? []), table]);
    return [...map.entries()].map(([area, tables]) => ({ area, tables }));
  });

</script>

<section class="page-head">
  <div>
    <p class="eyebrow"><a href="/campaigns/{data.campaignId}">{data.campaignName}</a> / Forage</p>
    <h1>Find Tables</h1>
    <p>
      Loot tables for foraging, one per area type and category. The DM and co-DM of this campaign manage them (admins too).
      A campaign with no table that has something to find has foraging switched off for its characters.
      Finds review and undo is on <a href="/admin/forage">/admin/forage</a> (admins).
    </p>
  </div>
</section>
{#if data.archived}<p class="panel muted">This campaign is archived, so its tables can't be changed.</p>{/if}
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
        <label>Suggested check (DM reminder)<input name="suggestedCheck" maxlength="80" placeholder="Nature DC 12" /></label>
        <button type="submit">Create table</button>
      </form>
    </details>

    <div class="admin-library-list">
      {#each groups as group (group.area)}
        <p class="forage-group-label">{group.area}</p>
        {#each group.tables as table (table.id)}
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
          <label>Suggested check (DM reminder)<input name="suggestedCheck" value={selected.suggestedCheck} maxlength="80" /></label>
          <p class="muted">Only this campaign's DMs, and admins, see the suggested check. Players never do.</p>
          <div class="button-row">
            <button type="submit">Save table</button>
            <button type="submit" formaction="?/archiveTable" class="danger">{selected.isArchived ? 'Restore' : 'Archive'}</button>
          </div>
        </form>
      {:else}
        <p class="muted">
          {selected.areaType} / {selected.category}. You can't edit this table.
        </p>
      {/if}

      <h3>Entries <span class="muted">({data.entries.length}, {selected.pickableCount} pickable)</span></h3>
      <p class="muted">
        On a successful forage every entry is rolled on its own: it is found if a d100 comes up at or under its chance, so a find can
        contain several items or none. A found entry then rolls its quantity die. Archived items and Off entries are never found.
      </p>

      {#if !data.entries.length}
        <p class="muted forage-empty">This table is empty. Players can't forage from it until it has a pickable item.</p>
      {:else}
        <form method="POST" action="?/saveEntries" class="stack">
          <input type="hidden" name="tableId" value={selected.id} />
          <div class="forage-entries">
            <div class="forage-entry forage-entry-head" aria-hidden="true">
              <span>Item</span><span>Chance</span><span>Qty die (1dN, 1 = always one)</span><span></span>
            </div>
            {#each data.entries as entry (entry.itemId)}
              <div class="forage-entry" class:forage-entry-dead={entry.itemArchived || entry.chance <= 0}>
                <input type="hidden" name="entryItem" value={entry.itemId} />
                <span class="forage-entry-name">
                  <strong>{entry.itemName}</strong>
                  <small class="muted">{entry.itemCategory}</small>
                  {#if entry.itemArchived}<span class="status-chip">Archived item</span>{/if}
                  {#if entry.sourceLabel}<span class="status-chip">{entry.sourceLabel}</span>{/if}
                </span>
                <label class="forage-entry-field"><span class="forage-entry-label">Chance</span>
                  <select name="chance" disabled={!canEdit}>
                    {#each CHANCE_OPTIONS as option (option.percent)}
                      <option value={option.percent} selected={option.percent === entry.chance}>{option.label}</option>
                    {/each}
                  </select>
                </label>
                <label class="forage-entry-field"><span class="forage-entry-label">Qty die (1dN, 1 = always one)</span>
                  <input name="qtyDie" type="number" min="1" max="100" value={entry.qtyDie} disabled={!canEdit} />
                </label>
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
          <CatalogueSearch campaignId={selected.campaignId} type="item" placeholder="Search items..." onPick={(id) => { newItemId = id; }} />
          <div class="mini-grid">
            <label>Chance
              <select name="chance">
                {#each CHANCE_OPTIONS as option (option.percent)}
                  <option value={option.percent} selected={option.percent === DEFAULT_CHANCE}>{option.label}</option>
                {/each}
              </select>
            </label>
            <label>Qty die (1dN, 1 = always one)<input name="qtyDie" type="number" min="1" max="100" value="1" /></label>
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
