<script lang="ts">
  let {data,form}=$props();
  const selected=$derived(data.modifiers.find((item)=>item.id===data.selectedModifierId));
  let search=$state('');let category=$state('');let change=$state('');let usage=$state('');
  const categories=$derived([...new Set(data.modifiers.map((item)=>item.category))].sort());
  const filtered=$derived(data.modifiers.filter((item)=>{
    const needle=search.trim().toLowerCase();
    return(!needle||[item.label,item.hookLabel,item.operation,item.baseValue].join(' ').toLowerCase().includes(needle))
      &&(!category||item.category===category)&&(!change||item.operation===change)
      &&(!usage||(usage==='used'?item.referenceCount>0:item.referenceCount===0));
  }));
</script>
{#if form?.error}<p class="form-error">{form.error}</p>{/if}{#if form?.saved}<p class="form-success">Modifier saved.</p>{/if}
<div class="rules-workspace admin-workspace-frame">
  <section class="panel stack rules-library">
    <div class="panel-head"><h2>Modifier Library</h2><span class="muted">{filtered.length}</span></div>
    <label class="admin-search-field"><span class="sr-only">Search modifiers</span><input bind:value={search} placeholder="Search modifiers..."/></label>
    <div class="library-filter-grid"><label>Category<select bind:value={category}><option value="">All Categories</option>{#each categories as value}<option value={value}>{value}</option>{/each}</select></label><label>Change<select bind:value={change}><option value="">All Changes</option>{#each data.operations as operation}<option value={operation.key}>{operation.label}</option>{/each}</select></label><label>Used By<select bind:value={usage}><option value="">All</option><option value="used">In Use</option><option value="unused">Unused</option></select></label></div>
    <a class="button-link admin-new-button" href="#new-modifier">+ New Modifier</a>
    <div class="admin-library-list modifier-library-list">{#each filtered as modifier}<a class:active={modifier.id===data.selectedModifierId} class="admin-library-item" href={`?modifier=${modifier.id}`}><span class="admin-library-icon" aria-hidden="true">{modifier.operation==='advantage'?'★':modifier.operation==='resistance'?'◆':'+'}</span><span><strong>{modifier.label||`${modifier.hookLabel} ${modifier.operation}`}</strong><small>{modifier.hookLabel} · {modifier.operation}{modifier.baseValue?` · ${modifier.baseValue}`:''}</small></span><small>Used by <b>{modifier.referenceCount}</b></small><span class="admin-library-arrow">›</span></a>{:else}<p class="muted">No Modifiers match.</p>{/each}</div>
  </section>
  <section class="panel stack rules-editor">
    <div class="panel-head"><h2>Modifier Editor</h2>{#if selected}<span class="record-id">ID: {selected.id.slice(0,8)}</span>{/if}</div>
    {#if selected}<form method="POST" action="?/update" class="stack admin-form"><input type="hidden" name="modifierId" value={selected.id}/><div class="mini-grid"><label>Applies To<select name="target">{#each data.hooks.filter((hook)=>!hook.isArchived) as hook}<option value={hook.key} selected={hook.key===selected.target}>{hook.label}</option>{/each}</select><small>Where in the rules this Modifier applies.</small></label><label>Change<select name="operation">{#each data.operations as operation}<option value={operation.key} selected={operation.key===selected.operation}>{operation.label}</option>{/each}</select><small>The mechanical change being applied.</small></label></div><label>Base Value<input name="baseValue" value={selected.baseValue}/></label><label>Display Name<input name="label" value={selected.label}/></label><label>Description<textarea name="description">{selected.description}</textarea></label><div class="usage-block"><div><h3>Used By</h3><p class="muted">Changes to this shared Modifier affect these records.</p></div>{#each data.references as reference}<div class="usage-row"><strong>{reference.name}</strong><span>{reference.ownerType}</span><span>{reference.overrideValue||'Default value'}</span></div>{:else}<p class="muted">This Modifier is not referenced.</p>{/each}</div><label class="inline"><input type="checkbox" name="confirmShared"/> Confirm shared update ({selected.referenceCount} references)</label><div class="button-row"><button>Save Modifier</button><button formaction="?/copy" class="secondary">Create Copy</button><button formaction="?/archive" class="danger">{selected.isArchived?'Restore':'Archive'}</button></div></form>{:else}<p class="muted">Select a Modifier.</p>{/if}
  </section>
  <section class="panel stack rules-create" id="new-modifier">
    <div><h2>Create Modifier</h2><p class="muted">Create a reusable mechanical instruction.</p></div><form method="POST" action="?/create" class="stack admin-form"><label>Applies To<select name="target">{#each data.hooks.filter((hook)=>!hook.isArchived) as hook}<option value={hook.key}>{hook.label}</option>{/each}</select></label><label>Change<select name="operation">{#each data.operations as operation}<option value={operation.key}>{operation.label}</option>{/each}</select></label><label>Base Value<input name="baseValue" placeholder="2, 1d4, proficiency_bonus"/></label><label>Display Name<input name="label" placeholder="Generated automatically when omitted"/></label><label>Description<textarea name="description"></textarea></label><button>+ Create New Modifier</button></form><p class="admin-info-note">Modifiers are reusable and can be attached to Effects, Items, Spells, Feats, and Features.</p>
  </section>
</div>
