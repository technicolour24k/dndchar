<script lang="ts">
  let {data,form}=$props();
  let search=$state('');let category=$state('');let change=$state('');let usage=$state('');

  type Modifier = typeof data.modifiers[number];
  let editing=$state<Modifier|null>(null);

  const categories=$derived([...new Set(data.modifiers.map((m)=>m.category))].sort());
  const filtered=$derived(data.modifiers.filter((m)=>{
    const needle=search.trim().toLowerCase();
    return(!needle||[m.label,m.hookLabel,m.operation,m.baseValue].join(' ').toLowerCase().includes(needle))
      &&(!category||m.category===category)&&(!change||m.operation===change)
      &&(!usage||(usage==='used'?m.referenceCount>0:m.referenceCount===0));
  }));

  function startEdit(m:Modifier){editing=m;document.getElementById('modifier-panel')?.scrollIntoView({behavior:'smooth',block:'start'});}
  function cancelEdit(){editing=null;}

  $effect(()=>{if(form?.saved)editing=null;});
</script>

{#if form?.error}<p class="form-error">{form.error}</p>{/if}
{#if form?.saved}<p class="form-success">Modifier saved.</p>{/if}

<div class="rules-workspace admin-workspace-frame two-panel">
  <section class="panel stack rules-library">
    <div class="panel-head"><h2>Modifier Library</h2><span class="muted">{filtered.length}</span></div>
    <label class="admin-search-field"><span class="sr-only">Search modifiers</span><input bind:value={search} placeholder="Search modifiers..."/></label>
    <div class="library-filter-grid">
      <label>Category<select bind:value={category}><option value="">All Categories</option>{#each categories as value}<option {value}>{value}</option>{/each}</select></label>
      <label>Change<select bind:value={change}><option value="">All Changes</option>{#each data.operations as op}<option value={op.key}>{op.label}</option>{/each}</select></label>
      <label>Used By<select bind:value={usage}><option value="">All</option><option value="used">In Use</option><option value="unused">Unused</option></select></label>
    </div>
    <div class="admin-library-list modifier-library-list">
      {#each filtered as modifier}
        <div class="modifier-list-item" class:archived={modifier.isArchived}>
          <div class="modifier-list-main">
            <div class="modifier-list-info">
              <strong>{modifier.label||`${modifier.hookLabel} ${modifier.operation}`}</strong>
              <small>{modifier.hookLabel} · {modifier.operation}{modifier.baseValue?` · ${modifier.baseValue}`:''}</small>
              {#if modifier.references.length}
                <span class="modifier-used-by">Used by: {modifier.references.map((r)=>r.name).join(', ')}</span>
              {:else}
                <span class="modifier-used-by muted">Unused</span>
              {/if}
            </div>
            <div class="modifier-list-actions">
              <button class="compact-button secondary" onclick={()=>startEdit(modifier)}>Edit</button>
              <form method="POST" action="?/archive" style="display:contents">
                <input type="hidden" name="modifierId" value={modifier.id}/>
                <button class="compact-button danger">{modifier.isArchived?'Restore':'Archive'}</button>
              </form>
            </div>
          </div>
        </div>
      {:else}
        <p class="muted">No Modifiers match.</p>
      {/each}
    </div>
  </section>

  <section class="panel stack rules-create" id="modifier-panel">
    {#if editing}
      <div><h2>Edit Modifier</h2><p class="muted record-id">ID: {editing.id.slice(0,8)}</p></div>
      <form method="POST" action="?/update" class="stack admin-form">
        <input type="hidden" name="modifierId" value={editing.id}/>
        <label>Applies To<select name="target">{#each data.hooks.filter((h)=>!h.isArchived) as hook}<option value={hook.key} selected={hook.key===editing.target}>{hook.label}</option>{/each}</select></label>
        <label>Change<select name="operation">{#each data.operations as op}<option value={op.key} selected={op.key===editing.operation}>{op.label}</option>{/each}</select></label>
        <label>Base Value<input name="baseValue" value={editing.baseValue}/></label>
        <label>Display Name<input name="label" value={editing.label}/></label>
        <label>Description<textarea name="description">{editing.description}</textarea></label>
        {#if editing.references.length}
          <div class="usage-block">
            <h3>Used By</h3>
            <p class="muted">Saving will affect all {editing.referenceCount} references.</p>
            {#each editing.references as ref}
              <div class="usage-row"><strong>{ref.name}</strong><span class="muted">{ref.ownerType}</span>{#if ref.overrideValue}<span class="muted">{ref.overrideValue}</span>{/if}</div>
            {/each}
          </div>
        {/if}
        <label class="inline"><input type="checkbox" name="confirmShared"/> Confirm shared update ({editing.referenceCount} references)</label>
        <div class="button-row">
          <button formaction="?/update">Save Modifier</button>
          <button formaction="?/copy" class="secondary">Create Copy</button>
          <button type="button" class="secondary" onclick={cancelEdit}>Cancel</button>
        </div>
      </form>
    {:else}
      <div><h2>Create Modifier</h2><p class="muted">Create a reusable mechanical instruction.</p></div>
      <form method="POST" action="?/create" class="stack admin-form">
        <label>Applies To<select name="target">{#each data.hooks.filter((h)=>!h.isArchived) as hook}<option value={hook.key}>{hook.label}</option>{/each}</select></label>
        <label>Change<select name="operation">{#each data.operations as op}<option value={op.key}>{op.label}</option>{/each}</select></label>
        <label>Base Value<input name="baseValue" placeholder="2, 1d4, proficiency_bonus"/></label>
        <label>Display Name<input name="label" placeholder="Generated automatically when omitted"/></label>
        <label>Description<textarea name="description"></textarea></label>
        <button>+ Create New Modifier</button>
      </form>
      <p class="admin-info-note">Modifiers are reusable and can be attached to Effects, Items, Spells, Feats, and Features.</p>
    {/if}
  </section>
</div>
