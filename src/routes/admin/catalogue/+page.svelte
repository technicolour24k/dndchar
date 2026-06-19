<script lang="ts">let{data,form}=$props();const selectedEffect=$derived(data.effects.find((effect)=>effect.id===data.selectedEffectId));</script>
<section class="page-head"><div><p class="eyebrow">Administration</p><h1>Catalogue Settings</h1><p>Control publication, modifier targets, and reusable modifier definitions.</p></div></section>
{#if form?.error}<p class="form-error">{form.error}</p>{/if}{#if form?.saved}<p class="form-success">Catalogue settings updated.</p>{/if}

<div class="admin-grid catalogue-settings-grid">
  <section class="panel stack">
    <div class="panel-head"><h2>Publication</h2><span class="muted">{data.content.length}</span></div>
    <div class="admin-list">
      {#each data.content as entry}
        <article class="admin-row"><div><strong>{entry.name}</strong><p class="muted">{entry.type.replace('_',' ')} / {entry.ownerName}</p></div><form method="POST" action="?/publish" class="inline"><input type="hidden" name="contentId" value={entry.id}/><select name="status"><option value="private" selected={entry.status==='private'}>Private</option><option value="pending" selected={entry.status==='pending'}>Pending</option><option value="published" selected={entry.status==='published'}>Published</option></select><button class="compact-button">Save</button></form></article>
      {:else}<p class="muted">No catalogue entries.</p>{/each}
    </div>
  </section>

  <section class="panel stack">
    <div class="panel-head"><h2>Modifier Targets</h2><span class="muted">{data.targets.length}</span></div>
    <form method="POST" action="?/createTarget" class="stack admin-form">
      <label>SQL Key<input name="targetKey" list="target-key-options" placeholder="ability_check.stealth" required/></label>
      <datalist id="target-key-options">{#each data.targets as target}<option value={target.key}>{target.label}</option>{/each}</datalist>
      <label>Friendly Name<input name="targetLabel" placeholder="Stealth Checks" required/></label>
      <div class="mini-grid"><label>Category<select name="targetCategory"><option value="checks">Checks</option><option value="saves">Saving Throws</option><option value="combat">Combat</option><option value="damage">Damage</option><option value="spellcasting">Spellcasting</option><option value="movement">Movement</option><option value="resources">Resources</option><option value="custom">Custom</option></select></label><label>Value Type<select name="valueKind"><option value="number">Number</option><option value="dice">Dice</option><option value="formula">Formula</option><option value="none">None</option><option value="text">Text</option></select></label></div>
      <label>Description<textarea name="targetDescription"></textarea></label><button>Add Target</button>
    </form>
    <div class="admin-list compact">{#each data.targets as target}<article class="admin-row"><div><strong>{target.label}</strong><p class="muted">{target.key} / {target.valueKind}</p></div><span class:good={target.runtimeSupported} class="save-state">{target.runtimeSupported?'Calculated':'Stored only'}</span></article>{/each}</div>
  </section>

  <section class="panel stack">
    <div class="panel-head"><h2>Modifier Definitions</h2><span class="muted">{data.modifiers.length}</span></div>
    <form method="POST" action="?/createModifier" class="stack admin-form">
      <label>Target<select name="target">{#each data.targets as target}<option value={target.key}>{target.label} ({target.key})</option>{/each}</select></label>
      <label>Operation<select name="modifierType">{#each data.modifierTypes as [key,label]}<option value={key}>{label}</option>{/each}</select></label>
      <label>Default Value<input name="defaultValueExpression" placeholder="Optional: 2, 1d4, proficiency_bonus"/></label>
      <label>Friendly Label<input name="label"/></label><label>Description<textarea name="description"></textarea></label><button>Add Modifier</button>
    </form>
    <div class="admin-list compact">{#each data.modifiers as modifier}<article class="admin-row"><div><strong>{modifier.targetLabel} / {modifier.modifierType}{modifier.defaultValueExpression?` / ${modifier.defaultValueExpression}`:''}</strong><p class="muted">{modifier.target}</p></div></article>{/each}</div>
  </section>
</div>

<section class="panel stack system-effects-panel">
  <div class="panel-head"><div><h2>System Effects</h2><p class="muted">Conditions, combat states, environmental effects, and other non-content bundles.</p></div><span class="muted">{data.effects.length}</span></div>
  <div class="system-effect-layout">
    <div class="stack">
      <label>Select effect<select onchange={(event)=>location.href=`?effect=${event.currentTarget.value}`}>{#each data.effects as effect}<option value={effect.id} selected={effect.id===data.selectedEffectId}>{effect.name} ({effect.sourceType})</option>{/each}</select></label>
      {#if selectedEffect}<form method="POST" action="?/updateEffect" class="stack admin-form"><input type="hidden" name="effectId" value={selectedEffect.id}/><label>Name<input name="name" value={selectedEffect.name}/></label><label>Description<textarea name="description">{selectedEffect.description}</textarea></label><label class="inline"><input name="isSelectable" type="checkbox" checked={selectedEffect.isSelectable}/> Selectable for players</label><p class="muted">{selectedEffect.key}</p><button>Save Effect</button></form>{/if}
    </div>
    <div class="stack">
      {#if selectedEffect}<form method="POST" action="?/attachEffectModifier" class="stack admin-form"><input type="hidden" name="effectId" value={selectedEffect.id}/><label>Modifier<select name="modifierId">{#each data.modifiers as modifier}<option value={modifier.id}>{modifier.targetLabel} / {modifier.modifierType}{modifier.defaultValueExpression?` / ${modifier.defaultValueExpression}`:''}</option>{/each}</select></label><div class="mini-grid"><label>Override<input name="valueOverrideExpression"/></label><label>Priority<input name="priority" type="number" value="0"/></label></div><label>Condition<input name="conditionExpression"/></label><button>Attach Modifier</button></form>{/if}
      <div class="admin-list compact">{#each data.effectLinks as link}<article class="admin-row"><div><strong>{link.targetLabel} / {link.modifierType}{link.valueExpression?` / ${link.valueExpression}`:''}</strong><p class="muted">{link.target}</p></div><form method="POST" action="?/detachEffectModifier"><input type="hidden" name="effectId" value={link.effectId}/><input type="hidden" name="linkId" value={link.id}/><button class="compact-button danger">Remove</button></form></article>{:else}<p class="muted">No modifiers attached.</p>{/each}</div>
    </div>
  </div>
</section>
