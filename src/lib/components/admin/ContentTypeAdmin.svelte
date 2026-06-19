<script lang="ts">
  import type { ContentType } from '$lib/types/content';
  import type { AdminContentRecord } from '$lib/server/services/content-admin';

  let { data, form, title, description, createType, allowedTypes }:{
    data:any; form:any; title:string; description:string; createType:ContentType;
    allowedTypes:ContentType[];
  }=$props();
  const selected=$derived(data.content.find((entry:AdminContentRecord)=>entry.id===data.selectedContentId) as AdminContentRecord|undefined);
  let actionTarget=$state('hp');

  function modifierLabel(modifier:any){
    const value=modifier.defaultValueExpression?` / ${modifier.defaultValueExpression}`:'';
    return `${modifier.targetLabel} / ${modifier.modifierType}${value}${modifier.runtimeSupported?'':' / not calculated'}`;
  }

  function actionLabel(action:any){
    const operation=action.operation==='add'?'Add / Heal / Recover':action.operation==='subtract'?'Subtract / Damage / Spend':'Set';
    const target=action.targetType==='spell_slot'?`spell slot (${action.targetKey.replace('_',' ')})`:action.targetType==='coin'?action.targetKey.toUpperCase():action.targetType.replace('_',' ');
    return `${operation} ${action.valueExpression} ${target}`;
  }
</script>

<section class="page-head"><div><p class="eyebrow">Administration</p><h1>{title}</h1><p>{description}</p></div></section>
{#if form?.error}<p class="form-error">{form.error}</p>{/if}
{#if form?.saved}<p class="form-success">Catalogue entry updated.</p>{/if}

<div class="content-admin-layout">
  <aside class="panel stack content-selector-panel">
    <div class="panel-head"><h2>{title.replace(' Settings','')}</h2><span class="muted">{data.content.length}</span></div>
    <label>Select entry
      <select onchange={(event)=>location.href=`?content=${event.currentTarget.value}`}>
        {#each data.content as entry}<option value={entry.id} selected={entry.id===data.selectedContentId}>{entry.name} ({entry.sourceKind})</option>{/each}
      </select>
    </label>
    <form method="POST" action="?/create" class="stack admin-form">
      <h3>Create {createType.replace('_',' ')}</h3>
      {#if allowedTypes.length > 1}
        <label>Type<select name="contentType">{#each allowedTypes as type}<option value={type}>{type.replace('_',' ')}</option>{/each}</select></label>
      {:else}<input type="hidden" name="contentType" value={createType}/>{/if}
      <label>Name<input name="name" required/></label>
      <label>Description<textarea name="description"></textarea></label>
      <button type="submit">Create Entry</button>
    </form>
  </aside>

  <section class="panel stack content-editor-panel">
    {#if selected}
      <div class="panel-head"><div><p class="eyebrow">{selected.type.replace('_',' ')} / {selected.sourceKind}</p><h2>{selected.name}</h2></div><span class="status-chip">{selected.publicationStatus}</span></div>
      <form method="POST" action="?/update" class="stack">
        <input type="hidden" name="contentId" value={selected.id}/>
        <div class="mini-grid"><label>Name<input name="name" value={selected.name} required/></label><label>Publication<select name="publicationStatus"><option value="private" selected={selected.publicationStatus==='private'}>Private</option><option value="pending" selected={selected.publicationStatus==='pending'}>Pending</option><option value="published" selected={selected.publicationStatus==='published'}>Published</option></select></label></div>
        <label>Description<textarea name="description">{selected.description}</textarea></label>
        {#if selected.type==='item'}
          <div class="mini-grid"><label>Category<select name="category"><option value="weapon" selected={selected.category==='weapon'}>Weapon</option><option value="armor" selected={selected.category==='armor'}>Armor</option><option value="shield" selected={selected.category==='shield'}>Shield</option><option value="focus" selected={selected.category==='focus'}>Spell Focus</option><option value="consumable" selected={selected.category==='consumable'}>Consumable</option><option value="tool" selected={selected.category==='tool'}>Tool</option><option value="gear" selected={selected.category==='gear'}>Adventuring Gear</option><option value="treasure" selected={selected.category==='treasure'}>Treasure</option></select></label><label>Equipment Type<select name="equipmentType">{#each ['item','simple melee','simple ranged','martial melee','martial ranged','light armor','medium armor','heavy armor','shield','adventuring gear','tool','spell focus'] as type}<option value={type} selected={selected.equipmentType===type}>{type}</option>{/each}</select></label></div>
          <div class="mini-grid"><label>AC Bonus<input name="acBonus" type="number" value={selected.acBonus}/></label><label>To Hit<input name="toHitBonus" type="number" value={selected.toHitBonus}/></label><label>Damage Bonus<input name="damageBonus" type="number" value={selected.damageBonus}/></label><label>Ability<select name="attackAbility">{#each ['str','dex','con','int','wis','cha'] as ability}<option value={ability} selected={selected.attackAbility===ability}>{ability.toUpperCase()}</option>{/each}</select></label></div>
          <label>Damage Rolls<input name="damageRolls" value={selected.damageRolls} placeholder="1d8 + 1d4"/></label>
          <label class="inline"><input name="requiresAttunement" type="checkbox" checked={selected.requiresAttunement}/> Requires Attunement</label>
        {:else if selected.type==='spell'}
          <div class="mini-grid"><label>Level<select name="spellLevel">{#each Array.from({length:10},(_,index)=>index) as level}<option value={level} selected={selected.spellLevel===level}>{level===0?'Cantrip':level}</option>{/each}</select></label><label>School<select name="school">{#each ['Abjuration','Conjuration','Divination','Enchantment','Evocation','Illusion','Necromancy','Transmutation'] as school}<option value={school} selected={selected.school===school}>{school}</option>{/each}</select></label></div>
          <div class="mini-grid"><label>Casting Time<input name="castingTime" list="casting-time-options" value={selected.castingTime}/></label><label>Range<input name="range" list="range-options" value={selected.range}/></label><label>Components<input name="components" value={selected.components}/></label><label>Duration<input name="duration" list="duration-options" value={selected.duration}/></label></div>
          <datalist id="casting-time-options"><option value="1 action"></option><option value="1 bonus action"></option><option value="1 reaction"></option><option value="1 minute"></option><option value="10 minutes"></option><option value="1 hour"></option></datalist>
          <datalist id="range-options"><option value="Self"></option><option value="Touch"></option><option value="30 feet"></option><option value="60 feet"></option><option value="90 feet"></option><option value="120 feet"></option><option value="Sight"></option><option value="Unlimited"></option></datalist>
          <datalist id="duration-options"><option value="Instantaneous"></option><option value="1 round"></option><option value="1 minute"></option><option value="10 minutes"></option><option value="1 hour"></option><option value="8 hours"></option><option value="24 hours"></option><option value="Until dispelled"></option></datalist>
          <label>Classes<select name="classes" multiple size="6">{#each ['Bard','Cleric','Druid','Paladin','Ranger','Sorcerer','Warlock','Wizard'] as className}<option value={className} selected={selected.classes.includes(className)}>{className}</option>{/each}</select></label>
          <div class="actions"><label class="inline"><input name="ritual" type="checkbox" checked={selected.ritual}/> Ritual</label><label class="inline"><input name="concentration" type="checkbox" checked={selected.concentration}/> Concentration</label></div>
        {/if}
        <p class="muted">Key: {selected.key}</p>
        <button type="submit">Save Entry</button>
      </form>
    {:else}<p class="muted">Create or import an entry to begin.</p>{/if}
  </section>

  <section class="panel stack modifier-attachment-panel">
    <div class="panel-head"><h2>Attached Modifiers</h2><span class="muted">{data.attachedModifiers.length}</span></div>
    {#if selected}
      <form method="POST" action="?/attachModifier" class="stack admin-form">
        <input type="hidden" name="contentId" value={selected.id}/>
        <label>Modifier<select name="modifierId">{#each data.modifiers as modifier}<option value={modifier.id}>{modifierLabel(modifier)}</option>{/each}</select></label>
        <div class="mini-grid"><label>Activation<select name="activationType"><option value="manual">Manual</option><option value="carried">Carried</option><option value="equipped">Equipped</option><option value="attuned">Attuned</option><option value="on_use">On Use</option></select></label><label>Override Value<input name="valueOverrideExpression" placeholder="Optional, e.g. 2 or 1d4"/></label></div>
        <div class="mini-grid"><label>Condition<input name="conditionExpression" placeholder="Optional predicate"/></label><label>Priority<input name="priority" type="number" value="0"/></label></div>
        <button type="submit">Attach Modifier</button>
      </form>
    {/if}
    <div class="admin-list">
      {#each data.attachedModifiers as modifier}
        <article class="admin-row modifier-summary-row"><div><strong>{modifier.targetLabel} / {modifier.modifierType}{modifier.valueExpression?` / ${modifier.valueExpression}`:''}</strong><p class="muted">{modifier.activationType} / {modifier.effectName}{modifier.conditionExpression?` / if ${modifier.conditionExpression}`:''}</p></div><form method="POST" action="?/detachModifier"><input type="hidden" name="contentId" value={selected?.id||''}/><input type="hidden" name="linkId" value={modifier.id}/><button type="submit" class="compact-button danger">Remove</button></form></article>
      {:else}<p class="muted">No modifiers attached to this entry.</p>{/each}
    </div>
    {#if selected}
      <h2>Resource Actions</h2>
      <p class="muted">Immediate healing, damage, spell-slot recovery, spending, or coin changes.</p>
      <form method="POST" action="?/addResourceAction" class="stack admin-form">
        <input type="hidden" name="contentId" value={selected.id}/>
        <div class="mini-grid">
          <label>Effect<select name="actionOperation"><option value="add">Add / Heal / Recover</option><option value="subtract">Subtract / Damage / Spend</option><option value="set">Set Exact Value</option></select></label>
          <label>Target<select name="targetType" bind:value={actionTarget}><option value="hp">Hit Points</option><option value="temp_hp">Temporary HP</option><option value="spell_slot">Spell Slot</option><option value="coin">Coins</option></select></label>
        </div>
        {#if actionTarget==='spell_slot'}
          <label>Slot<select name="targetKey"><option value="highest_expended">Highest Expended Slot</option><option value="lowest_expended">Lowest Expended Slot</option><option value="pact">Pact Magic Slot</option>{#each [1,2,3,4,5,6,7,8,9] as level}<option value={level}>Level {level}</option>{/each}</select></label>
        {:else if actionTarget==='coin'}
          <label>Coin<select name="targetKey"><option value="cp">Copper (CP)</option><option value="sp">Silver (SP)</option><option value="ep">Electrum (EP)</option><option value="gp">Gold (GP)</option><option value="pp">Platinum (PP)</option></select></label>
        {:else}<input type="hidden" name="targetKey" value=""/>{/if}
        <div class="mini-grid"><label>Amount<input name="valueExpression" placeholder="2d4+2" required/></label><label>When<select name="activationType"><option value="on_use">On Use</option><option value="manual">Manual</option></select></label></div>
        <label>Label<input name="actionLabel" placeholder="Optional, e.g. Healing draught"/></label>
        <button>Add Resource Action</button>
      </form>
      <div class="admin-list compact">{#each data.resourceActions as action}<article class="admin-row"><div><strong>{action.label||actionLabel(action)}</strong><p class="muted">{actionLabel(action)} / {action.activationType.replace('_',' ')}</p></div><form method="POST" action="?/removeResourceAction"><input type="hidden" name="contentId" value={selected.id}/><input type="hidden" name="actionId" value={action.id}/><button class="compact-button danger">Remove</button></form></article>{:else}<p class="muted">No resource actions attached.</p>{/each}</div>
    {/if}
    {#if selected && (selected.type==='feat'||selected.type==='class_feature')}
      <h2>Uses & Recharge</h2>
      <form method="POST" action="?/addResource" class="stack admin-form"><input type="hidden" name="contentId" value={selected.id}/><div class="mini-grid"><label>Counter Key<input name="resourceKey" required/></label><label>Label<input name="resourceLabel" required/></label></div><label>Maximum<select name="maxValueExpression"><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="proficiency_bonus">Proficiency Bonus</option><option value="ability_modifier">Ability Modifier</option><option value="level">Character Level</option></select></label><label>Recharge<select name="rechargePeriod"><option value="short_rest">Short Rest</option><option value="long_rest">Long Rest</option><option value="dawn">Dawn</option><option value="round">Round</option><option value="encounter">Encounter</option><option value="manual">Manual</option></select></label><button>Add Counter</button></form>
      <div class="admin-list compact">{#each data.resources as resource}<article class="admin-row"><div><strong>{resource.label}</strong><p class="muted">{resource.maxValueExpression} / {resource.rechargePeriod.replace('_',' ')}</p></div></article>{/each}</div>
    {/if}
    {#if selected?.type==='item'}
      <h2>Granted Feats & Features</h2>
      <form method="POST" action="?/grantContent" class="stack admin-form"><input type="hidden" name="sourceContentId" value={selected.id}/><label>Granted Content<select name="grantedContentId">{#each data.grantCandidates as candidate}<option value={candidate.id}>{candidate.name} ({candidate.type.replace('_',' ')})</option>{/each}</select></label><label>Activation<select name="activationType"><option value="equipped">Equipped</option><option value="attuned">Attuned</option><option value="carried">Carried</option><option value="on_use">On Use</option><option value="manual">Manual</option></select></label><button>Attach Grant</button></form>
      <div class="admin-list compact">{#each data.grants as grant}<article class="admin-row"><div><strong>{grant.name}</strong><p class="muted">{grant.type.replace('_',' ')} / {grant.activationType}</p></div></article>{/each}</div>
    {/if}
  </section>
</div>
