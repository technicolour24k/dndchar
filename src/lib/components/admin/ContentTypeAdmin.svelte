<script lang="ts">
  import type { ContentType } from '$lib/types/content';
  import type { AdminContentRecord } from '$lib/server/services/content-admin';

  let { data, form, title, description, createType, allowedTypes }:{
    data:any; form:any; title:string; description:string; createType:ContentType;
    allowedTypes:ContentType[];
  }=$props();
  const selected=$derived(data.content.find((entry:AdminContentRecord)=>entry.id===data.selectedContentId) as AdminContentRecord|undefined);
  let actionTarget=$state('hp');
  let actionStepType=$state('resource_change');
  let librarySearch=$state('');
  let attachmentTab=$state('modifiers');
  const filteredContent=$derived(data.content.filter((entry:AdminContentRecord)=>entry.name.toLowerCase().includes(librarySearch.trim().toLowerCase())));
  const attachmentTabs=$derived([
    ['modifiers','Modifiers'],['effects','Effects'],['actions','Actions'],
    ...(selected?.type==='item'?[['spells','Spell Grants'],['features','Features']]:[]),
    ...((selected?.type==='item'||selected?.type==='feat'||selected?.type==='class_feature')?[['resources','Resources']]:[])
  ]);

  function modifierLabel(modifier:any){
    const value=modifier.defaultValueExpression?` / ${modifier.defaultValueExpression}`:'';
    return `${modifier.targetLabel} / ${modifier.modifierType}${value}${modifier.runtimeSupported?'':' / not calculated'}`;
  }

</script>

<section class="page-head admin-page-intro"><div><p class="eyebrow">Administration</p><h1>{title}</h1><p>{description}</p></div></section>
{#if form?.error}<p class="form-error">{form.error}</p>{/if}
{#if form?.saved}<p class="form-success">Catalogue entry updated.</p>{/if}

<div class="content-admin-layout">
  <aside class="panel stack content-selector-panel admin-library-panel">
    <div class="panel-head"><h2>{title.replace(' Library','')}</h2><span class="muted">{data.content.length}</span></div>
    <label class="admin-search-field"><span class="sr-only">Search library</span><input bind:value={librarySearch} placeholder={`Search ${title.toLowerCase()}...`}/></label>
    <details class="admin-create-disclosure"><summary>+ New {createType.replace('_',' ')}</summary><form method="POST" action="?/create" class="stack admin-form">
      <h3>Create {createType.replace('_',' ')}</h3>
      {#if allowedTypes.length > 1}
        <label>Type<select name="contentType">{#each allowedTypes as type}<option value={type}>{type.replace('_',' ')}</option>{/each}</select></label>
      {:else}<input type="hidden" name="contentType" value={createType}/>{/if}
      <label>Name<input name="name" required/></label>
      <label>Description<textarea name="description"></textarea></label>
      <button type="submit">Create Entry</button>
    </form></details>
    <div class="admin-library-list">
      {#each filteredContent as entry}
        <a href={`?content=${entry.id}`} class="admin-library-item" class:active={entry.id===data.selectedContentId}>
          <span class="admin-library-icon" aria-hidden="true">{entry.type==='spell'?'✦':entry.type==='item'?'◆':'★'}</span>
          <span><strong>{entry.name}</strong><small>{entry.type.replace('_',' ')} · {entry.sourceKind}{entry.isArchived?' · archived':''}</small></span>
          <span class="admin-library-arrow" aria-hidden="true">›</span>
        </a>
      {:else}<p class="muted">No matching entries.</p>{/each}
    </div>
  </aside>

  <section class="panel stack content-editor-panel">
    {#if selected}
      <div class="panel-head"><div><p class="eyebrow">{selected.type.replace('_',' ')} / {selected.sourceKind}</p><h2>{selected.name}</h2></div><span class="status-chip">{selected.isArchived?'Archived':'Available'}</span></div>
      <form method="POST" action="?/update" class="stack">
        <input type="hidden" name="contentId" value={selected.id}/>
        <label>Name<input name="name" value={selected.name} required/></label>
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

          <h3>Damage</h3>
          <div class="mini-grid">
            <label>Resolution<select name="resolutionType"><option value="attack" selected={selected.resolutionType==='attack'}>Attack Roll</option><option value="save" selected={selected.resolutionType==='save'}>Saving Throw</option><option value="auto" selected={selected.resolutionType==='auto'}>Automatic (no roll)</option></select></label>
            <label>Damage Type<input name="damageType" list="damage-type-options" value={selected.damageType}/></label>
            <label>Base Dice<input name="baseDice" value={selected.baseDice} placeholder="8d6"/></label>
          </div>
          <datalist id="damage-type-options">{#each ['acid','bludgeoning','cold','fire','force','lightning','necrotic','piercing','poison','psychic','radiant','slashing','thunder'] as type}<option value={type}></option>{/each}</datalist>
          <p class="muted">Save Ability/Effect only matter when Resolution is Saving Throw; Scaling fields only matter for the kind selected below - unused fields are ignored, no need to blank them out.</p>
          <div class="mini-grid">
            <label>Save Ability<select name="saveAbility">{#each ['str','dex','con','int','wis','cha'] as ability}<option value={ability} selected={selected.saveAbility===ability}>{ability.toUpperCase()}</option>{/each}</select></label>
            <label>On a Successful Save<select name="saveEffect"><option value="half" selected={selected.saveEffect==='half'}>Half damage</option><option value="negate" selected={selected.saveEffect==='negate'}>No damage</option></select></label>
          </div>
          <label>Scaling<select name="scalingKind"><option value="none" selected={!selected.scaling?.kind||selected.scaling.kind==='none'}>None</option><option value="cantrip" selected={selected.scaling?.kind==='cantrip'}>Cantrip (scales with character level)</option><option value="leveled" selected={selected.scaling?.kind==='leveled'}>Leveled (scales with upcast slot)</option></select></label>
          <div class="mini-grid">
            <label>Extra Dice per Tier (cantrip)<input name="scalingExtraDice" value={selected.scaling?.extraDice||''} placeholder="1d10"/></label>
            <label>Tiers - character level (cantrip)<input name="scalingTiers" value={(selected.scaling?.tiers||[5,11,17]).join(',')} placeholder="5,11,17"/></label>
          </div>
          <label>Extra Dice per Slot Level Above Minimum (leveled/upcast)<input name="scalingExtraDicePerSlotLevel" value={selected.scaling?.extraDicePerSlotLevel||''} placeholder="1d6"/></label>
        {/if}
        <p class="muted">Key: {selected.key}</p>
        <div class="button-row"><button type="submit">Save Entry</button><button type="submit" formaction="?/archive" class="danger">{selected.isArchived?'Restore':'Archive'}</button></div>
      </form>
      <div class="content-rule-summary">
        <button type="button" class:active={attachmentTab==='modifiers'} onclick={()=>attachmentTab='modifiers'}>Modifiers <strong>{data.attachedModifiers.length}</strong></button>
        <button type="button" class:active={attachmentTab==='effects'} onclick={()=>attachmentTab='effects'}>Effects <strong>{data.attachedEffects.length}</strong></button>
        <button type="button" class:active={attachmentTab==='actions'} onclick={()=>attachmentTab='actions'}>Actions <strong>{data.actions.length}</strong></button>
        {#if selected.type==='item'}<button type="button" class:active={attachmentTab==='spells'} onclick={()=>attachmentTab='spells'}>Spell Grants <strong>{data.spellAccess.length}</strong></button><button type="button" class:active={attachmentTab==='features'} onclick={()=>attachmentTab='features'}>Features <strong>{data.grants.length}</strong></button>{/if}
      </div>
    {:else}<p class="muted">Create or import an entry to begin.</p>{/if}
  </section>

  <section class="panel stack modifier-attachment-panel">
    <div class="attachment-tab-bar" role="tablist">{#each attachmentTabs as tab}<button type="button" class:active={attachmentTab===tab[0]} onclick={()=>attachmentTab=tab[0]}>{tab[1]}</button>{/each}</div>
    {#if selected && attachmentTab==='modifiers'}
      <div class="panel-head"><div><h2>Add Modifier</h2><p class="muted">Attach a reusable mechanical rule.</p></div><span>{data.attachedModifiers.length}</span></div>
      <form method="POST" action="?/attachModifier" class="stack admin-form">
        <input type="hidden" name="contentId" value={selected.id}/>
        <label>Modifier<select name="modifierId">{#each data.modifiers as modifier}<option value={modifier.id}>{modifierLabel(modifier)}</option>{/each}</select></label>
        <div class="mini-grid"><label>Availability<select name="activationType">{#if selected.type==='item'}<option value="carried">Carried</option><option value="equipped">Equipped</option><option value="attuned">Attuned</option>{:else if selected.type==='spell'}<option value="known">Known</option><option value="prepared">Prepared</option><option value="manual">Active</option>{:else}<option value="manual">Active</option>{/if}</select></label><label>Entry-specific Value<input name="valueOverrideExpression" placeholder="Optional, e.g. 2 or 1d4"/></label></div>
        <div class="mini-grid"><label>Condition<input name="conditionExpression" placeholder="Optional predicate"/></label><label>Priority<input name="priority" type="number" value="0"/></label></div>
        <button type="submit">Attach Modifier</button>
      </form>
    <div class="admin-list attachment-list">
      {#each data.attachedModifiers as modifier}
        <article class="admin-row modifier-summary-row"><div><strong>{modifier.targetLabel} / {modifier.modifierType}{modifier.valueExpression?` / ${modifier.valueExpression}`:''}</strong><p class="muted">{modifier.activationType}{modifier.conditionExpression?` / if ${modifier.conditionExpression}`:''}</p></div><form method="POST" action="?/detachModifier"><input type="hidden" name="contentId" value={selected?.id||''}/><input type="hidden" name="linkId" value={modifier.id}/><button type="submit" class="compact-button danger">Remove</button></form></article>
      {:else}<p class="muted">No modifiers attached to this entry.</p>{/each}
    </div>{/if}
    {#if selected && attachmentTab==='effects'}
      <h2>Effects</h2><p class="muted">Named states with duration, expiry, or other lifecycle behavior.</p>
      <form method="POST" action="?/attachEffect" class="stack admin-form"><input type="hidden" name="contentId" value={selected.id}/><label>Effect<select name="effectId">{#each data.effects as effect}<option value={effect.id}>{effect.name} ({effect.sourceType})</option>{/each}</select></label><label>Activation<select name="activationType">{#if selected.type==='item'}<option value="carried">Carried</option><option value="equipped">Equipped</option><option value="attuned">Attuned</option><option value="on_use">On Use</option>{:else}<option value="manual">Active</option><option value="on_use">On Cast / Use</option>{/if}</select></label><button>Attach Effect</button></form>
      <div class="admin-list compact attachment-list">{#each data.attachedEffects as effect}<article class="admin-row"><div><strong>{effect.name}</strong><p class="muted">{effect.activationType} · {effect.durationType}</p></div><form method="POST" action="?/detachEffect"><input type="hidden" name="contentId" value={selected.id}/><input type="hidden" name="linkId" value={effect.id}/><button class="compact-button danger">Remove</button></form></article>{:else}<p class="muted">No Effects attached.</p>{/each}</div>
    {/if}
    {#if selected && attachmentTab==='actions'}
      <h2>Actions</h2>
      <p class="muted">Reusable immediate resolutions such as healing, damage, spending resources, or applying Effects.</p>
      <form method="POST" action="?/attachAction" class="stack admin-form"><input type="hidden" name="contentId" value={selected.id}/><label>Existing Action<select name="actionId">{#each data.actionCandidates as action}<option value={action.id}>{action.name}</option>{/each}</select></label><label>Trigger<select name="triggerType"><option value="on_use">On Use</option><option value="manual">Manual</option>{#if selected.type==='spell'}<option value="on_cast">On Cast</option>{/if}</select></label><button>Attach Existing Action</button></form>
      <form method="POST" action="?/addResourceAction" class="stack admin-form">
        <input type="hidden" name="contentId" value={selected.id}/>
        <label>Action<select name="actionId"><option value="">Create or reuse this entry's default Action</option>{#each data.actions as action}<option value={action.id}>{action.name}</option>{/each}</select></label>
        <label>Step Type<select name="stepType" bind:value={actionStepType}><option value="resource_change">Change Resource</option><option value="damage">Roll Damage</option><option value="healing">Roll Healing</option><option value="apply_effect">Apply Effect</option><option value="remove_effect">Remove Effect</option><option value="spend_resource">Spend Content Resource</option><option value="spend_item">Spend Item Quantity</option><option value="roll_output">Roll Output</option></select></label>
        {#if actionStepType==='resource_change'}<div class="mini-grid">
          <label>Effect<select name="actionOperation"><option value="add">Add / Heal / Recover</option><option value="subtract">Subtract / Damage / Spend</option><option value="set">Set Exact Value</option></select></label>
          <label>Target<select name="targetType" bind:value={actionTarget}><option value="hp">Hit Points</option><option value="temp_hp">Temporary HP</option><option value="spell_slot">Spell Slot</option><option value="coin">Coins</option></select></label>
        </div>
        {#if actionTarget==='spell_slot'}
          <label>Slot<select name="targetKey"><option value="highest_expended">Highest Expended Slot</option><option value="lowest_expended">Lowest Expended Slot</option><option value="pact">Pact Magic Slot</option>{#each [1,2,3,4,5,6,7,8,9] as level}<option value={level}>Level {level}</option>{/each}</select></label>
        {:else if actionTarget==='coin'}
          <label>Coin<select name="targetKey"><option value="cp">Copper (CP)</option><option value="sp">Silver (SP)</option><option value="ep">Electrum (EP)</option><option value="gp">Gold (GP)</option><option value="pp">Platinum (PP)</option></select></label>
        {:else}<input type="hidden" name="targetKey" value=""/>{/if}{:else if actionStepType==='apply_effect'||actionStepType==='remove_effect'}<input type="hidden" name="actionOperation" value={actionStepType==='apply_effect'?'apply':'remove'}/><label>Effect<select name="effectId">{#each data.effects as effect}<option value={effect.id}>{effect.name}</option>{/each}</select></label>{:else}<input type="hidden" name="actionOperation" value={actionStepType==='damage'?'subtract':actionStepType==='healing'?'add':'roll'}/><label>Target Key<input name="targetKey" placeholder={actionStepType==='spend_resource'?'Resource key':'Optional'}/></label>{/if}
        {#if actionStepType!=='apply_effect'&&actionStepType!=='remove_effect'}<label>Amount<input name="valueExpression" placeholder="2d4+2" required/></label>{/if}
        {#if actionStepType==='damage'||actionStepType==='healing'||actionStepType==='roll_output'}<label>Target Mode<select name="targetMode"><option value="external_roll">Display roll for external target</option><option value="self">Apply to this character</option></select></label>{/if}
        <label>When<select name="activationType"><option value="on_use">On Use</option><option value="manual">Manual</option></select></label>
        <label>Label<input name="actionLabel" placeholder="Optional, e.g. Healing draught"/></label>
        <button>Add Action Step</button>
      </form>
      <div class="admin-list compact attachment-list">{#each data.actions as action}<article class="admin-row action-summary"><div><strong>{action.name}</strong><p class="muted">{action.triggerType.replace('_',' ')} · {action.steps.length} steps</p>{#each action.steps as step}<p>{step.label||step.type.replace('_',' ')}{step.valueExpression?`: ${step.valueExpression}`:''}</p>{/each}</div><div class="stack">{#each action.steps as step}<form method="POST" action="?/removeResourceAction"><input type="hidden" name="contentId" value={selected.id}/><input type="hidden" name="actionId" value={step.id}/><button class="compact-button danger">Remove Step</button></form>{/each}<form method="POST" action="?/detachAction"><input type="hidden" name="contentId" value={selected.id}/><input type="hidden" name="linkId" value={action.linkId}/><button class="compact-button danger">Detach Action</button></form></div></article>{:else}<p class="muted">No Actions attached.</p>{/each}</div>
    {/if}
    {#if selected && attachmentTab==='resources' && (selected.type==='item'||selected.type==='feat'||selected.type==='class_feature')}
      <h2>Charges, Uses &amp; Recharge</h2>
      <form method="POST" action="?/addResource" class="stack admin-form"><input type="hidden" name="contentId" value={selected.id}/><div class="mini-grid"><label>Counter Key<input name="resourceKey" required/></label><label>Label<input name="resourceLabel" required/></label></div><label>Maximum<select name="maxValueExpression"><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="proficiency_bonus">Proficiency Bonus</option><option value="ability_modifier">Ability Modifier</option><option value="level">Character Level</option></select></label><label>Recharge<select name="rechargePeriod"><option value="short_rest">Short Rest</option><option value="long_rest">Long Rest</option><option value="dawn">Dawn</option><option value="round">Round</option><option value="encounter">Encounter</option><option value="manual">Manual</option></select></label><button>Add Counter</button></form>
      <div class="admin-list compact">{#each data.resources as resource}<article class="admin-row"><div><strong>{resource.label}</strong><p class="muted">{resource.maxValueExpression} / {resource.rechargePeriod.replace('_',' ')}</p></div></article>{/each}</div>
    {/if}
    {#if selected?.type==='item' && attachmentTab==='features'}
      <h2>Granted Feats & Features</h2>
      <form method="POST" action="?/grantContent" class="stack admin-form"><input type="hidden" name="sourceContentId" value={selected.id}/><label>Granted Content<select name="grantedContentId">{#each data.grantCandidates as candidate}<option value={candidate.id}>{candidate.name} ({candidate.type.replace('_',' ')})</option>{/each}</select></label><label>Activation<select name="activationType"><option value="equipped">Equipped</option><option value="attuned">Attuned</option><option value="carried">Carried</option><option value="on_use">On Use</option><option value="manual">Manual</option></select></label><button>Attach Grant</button></form>
      <div class="admin-list compact">{#each data.grants as grant}<article class="admin-row"><div><strong>{grant.name}</strong><p class="muted">{grant.type.replace('_',' ')} / {grant.activationType}</p></div></article>{/each}</div>
    {/if}
    {#if selected?.type==='item' && attachmentTab==='spells'}
      <h2>Granted Spells</h2><form method="POST" action="?/addSpellAccess" class="stack admin-form"><input type="hidden" name="contentId" value={selected.id}/><label>Spell<select name="spellContentId">{#each data.spellCandidates as spell}<option value={spell.id}>{spell.name}</option>{/each}</select></label><div class="mini-grid"><label>Access<select name="accessType"><option value="charges">Item Charges</option><option value="limited_free">Limited Free Use</option><option value="at_will">At Will</option><option value="character_slots">Character Spell Slots</option></select></label><label>Availability<select name="availabilityType"><option value="equipped">Equipped</option><option value="attuned">Attuned</option><option value="carried">Carried</option></select></label></div><label>Charge Resource<select name="resourceDefinitionId"><option value="">None</option>{#each data.resources as resource}<option value={resource.id}>{resource.label}</option>{/each}</select></label><div class="mini-grid"><label>Cost<input name="resourceCostExpression" value="1"/></label><label>Cast Level<select name="castLevelMode"><option value="spell_level">Spell Level</option><option value="fixed">Fixed</option><option value="charges_spent">Charges Spent</option><option value="selected_slot">Selected Slot</option></select></label></div><label>Fixed Cast Level<input name="fixedCastLevel" type="number" min="0" max="9"/></label><div class="mini-grid"><label>Save DC<select name="saveDcMode"><option value="character">Character</option><option value="fixed">Fixed</option></select></label><label>Fixed DC<input name="fixedSaveDc" type="number"/></label><label>Attack Bonus<select name="spellAttackMode"><option value="character">Character</option><option value="fixed">Fixed</option></select></label><label>Fixed Bonus<input name="fixedSpellAttackBonus" type="number"/></label></div><button>Grant Spell</button></form>
      <div class="admin-list compact">{#each data.spellAccess as access}<article class="admin-row"><div><strong>{access.spellName}</strong><p class="muted">{access.accessType.replace('_',' ')} · {access.availabilityType}</p></div><form method="POST" action="?/removeSpellAccess"><input type="hidden" name="contentId" value={selected.id}/><input type="hidden" name="accessId" value={access.id}/><button class="compact-button danger">Remove</button></form></article>{:else}<p class="muted">No Spells granted.</p>{/each}</div>
    {/if}
  </section>
</div>
