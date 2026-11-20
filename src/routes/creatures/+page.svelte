<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';

  let { data, form } = $props();

  // Search and type filter run in the browser: the whole list is already loaded (a GM's own
  // templates, a few dozen at most), so there is no reason to hit the server for it.
  let search = $state('');
  let typeFilter = $state('');

  type Token = {
    type?: string;
    ac?: number | null;
    stats?: { hp?: number | null; maxHp?: number | null } | null;
    speedFt?: number | null;
    visionNormalFt?: number | null;
    visionDarkFt?: number | null;
    imageUrl?: string | null;
    actions?: { name?: string }[];
  };

  // token_json is untyped jsonb, so every read below tolerates missing fields.
  const tokenOf = (t: { tokenJson: unknown }) => (t.tokenJson ?? {}) as Token;
  const typeOf = (t: { tokenJson: unknown }) => tokenOf(t).type || 'enemy';

  const types = $derived([...new Set(data.templates.map(typeOf))].sort());
  const shown = $derived(
    data.templates.filter((t) => {
      if (typeFilter && typeOf(t) !== typeFilter) return false;
      return !search.trim() || t.name.toLowerCase().includes(search.trim().toLowerCase());
    })
  );

  const num = (value: number | null | undefined) => (typeof value === 'number' ? value : '-');
  const actionNames = (t: { tokenJson: unknown }) =>
    (tokenOf(t).actions ?? []).map((a) => a?.name).filter((n): n is string => !!n);

  // Asks first. Has to go through enhance's cancel(): enhance ignores a preventDefault() from a
  // plain onsubmit handler and would send the delete anyway.
  function confirmDelete(name: string): SubmitFunction {
    return ({ cancel }) => {
      if (!confirm(`Delete the "${name}" template? This cannot be undone.`)) cancel();
    };
  }
</script>

<section class="page-head">
  <div>
    <p class="eyebrow">Creatures</p>
    <h1>Creature templates</h1>
  </div>
</section>

{#if form?.error}
  <p class="form-error">{form.error}</p>
{/if}

<div class="campaigns-layout">
  <div class="campaigns-main">
    {#if data.templates.length === 0}
      <p class="panel muted">
        No templates yet. In the VTT, build a token and use "Save as Template" - it will show up here.
      </p>
    {:else if shown.length === 0}
      <p class="panel muted">No creatures match your search.</p>
    {:else}
      <div class="card-grid creature-grid">
        {#each shown as t (t.id)}
          {@const tok = tokenOf(t)}
          {@const isProp = typeOf(t) === 'prop'}
          {@const names = actionNames(t)}
          <article class="panel creature-card">
            <div class="creature-head">
              {#if tok.imageUrl}
                <img class="creature-thumb" src={tok.imageUrl} alt="" loading="lazy" />
              {:else}
                <span class="token creature-thumb">{t.name.slice(0, 2).toUpperCase()}</span>
              {/if}
              <div class="creature-title">
                <h3>{t.name}</h3>
                <span class="badge">{typeOf(t)}</span>
                {#if form?.saved === t.id}<span class="badge badge-admin">Saved</span>{/if}
              </div>
            </div>

            {#if !isProp}
              <p class="creature-stats">
                <span>AC <strong>{num(tok.ac)}</strong></span>
                <span>HP <strong>{num(tok.stats?.hp)} / {num(tok.stats?.maxHp)}</strong></span>
                <span>Speed <strong>{num(tok.speedFt)}</strong> ft</span>
                <span>Vision <strong>{num(tok.visionNormalFt)}</strong> / dark <strong>{num(tok.visionDarkFt)}</strong> ft</span>
              </p>
            {/if}

            {#if names.length}
              <p class="creature-actions muted">Actions: {names.join(', ')}</p>
            {/if}

            <details class="creature-edit">
              <summary>Edit</summary>
              <form method="POST" action="?/save" class="stack creature-form" use:enhance={() => async ({ update }) => update({ reset: false })}>
                <input type="hidden" name="id" value={t.id} />
                <label>
                  Name
                  <input name="name" maxlength="80" value={t.name} required />
                </label>
                {#if !isProp}
                  <div class="creature-numbers">
                    <label>AC<input name="ac" type="number" min="0" max="999" value={tok.ac ?? ''} /></label>
                    <label>HP<input name="hp" type="number" min="0" max="9999" value={tok.stats?.hp ?? ''} /></label>
                    <label>Max HP<input name="maxHp" type="number" min="0" max="9999" value={tok.stats?.maxHp ?? ''} /></label>
                    <label>Speed (ft)<input name="speedFt" type="number" min="0" max="999" value={tok.speedFt ?? ''} /></label>
                    <label>Vision (ft)<input name="visionNormalFt" type="number" min="0" max="999" value={tok.visionNormalFt ?? ''} /></label>
                    <label>Dark vision (ft)<input name="visionDarkFt" type="number" min="0" max="999" value={tok.visionDarkFt ?? ''} /></label>
                  </div>
                {/if}
                <button type="submit" class="compact-button">Save</button>
              </form>
              <form method="POST" action="?/delete" use:enhance={confirmDelete(t.name)}>
                <input type="hidden" name="id" value={t.id} />
                <button type="submit" class="compact-button danger">Delete</button>
              </form>
            </details>
          </article>
        {/each}
      </div>
    {/if}
  </div>

  <aside class="campaigns-side">
    <section class="panel campaign-box">
      <h2>Find a creature</h2>
      <input type="search" placeholder="Search by name" maxlength="80" bind:value={search} aria-label="Search creatures" />
      {#if types.length > 1}
        <select bind:value={typeFilter} aria-label="Filter by type">
          <option value="">All types</option>
          {#each types as type (type)}<option value={type}>{type}</option>{/each}
        </select>
      {/if}
      <div class="campaign-box-foot">
        <span class="muted">{shown.length} of {data.templates.length} {data.templates.length === 1 ? 'creature' : 'creatures'}</span>
        {#if search || typeFilter}
          <button type="button" class="text-button" onclick={() => { search = ''; typeFilter = ''; }}>Clear</button>
        {/if}
      </div>
      <p class="muted">New templates are made in the VTT with "Save as Template". Actions can only be edited there too.</p>
    </section>
  </aside>
</div>
