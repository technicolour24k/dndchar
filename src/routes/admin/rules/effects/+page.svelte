<script lang="ts">
  let {data,form}=$props();

  const editing=$derived(data.effects.find((e)=>e.id===data.selectedEffectId)??null);
  let search=$state('');
  let sourceFilter=$state('');

  const sourceTypes=$derived([...new Set(data.effects.map((e)=>e.sourceType))].sort());
  const filtered=$derived(data.effects.filter((e)=>{
    const needle=search.trim().toLowerCase();
    return(!needle||e.name.toLowerCase().includes(needle)||e.key.toLowerCase().includes(needle))
      &&(!sourceFilter||e.sourceType===sourceFilter);
  }));

  function editHref(id:string){return`?effect=${id}${data.showArchived?'&archived=1':''}`;}
  const cancelHref=$derived(data.showArchived?'?archived=1':'?');
</script>

{#if form?.error}<p class="form-error">{form.error}</p>{/if}
{#if form?.saved}<p class="form-success">Effect saved.</p>{/if}

<div class="rules-workspace admin-workspace-frame two-panel">
  <!-- ── Library ──────────────────────────────────────────────────── -->
  <section class="panel stack rules-library">
    <div class="panel-head">
      <h2>Effect Library</h2>
      <span class="muted">{filtered.length}</span>
    </div>

    <label class="admin-search-field">
      <span class="sr-only">Search effects</span>
      <input bind:value={search} placeholder="Search effects..."/>
    </label>

    <div class="library-filter-grid" style="grid-template-columns:1fr auto">
      <label>Source<select bind:value={sourceFilter}>
        <option value="">All Sources</option>
        {#each sourceTypes as t}<option value={t}>{t.replace('_',' ')}</option>{/each}
      </select></label>
      <div style="display:flex;flex-direction:column;justify-content:flex-end">
        <a class="button-link" style="font-size:11px;padding:5px 9px;white-space:nowrap"
          href={data.showArchived?cancelHref:'?archived=1'}
        >{data.showArchived?'Hide archived':'Show archived'}</a>
      </div>
    </div>

    <div class="admin-library-list modifier-library-list">
      {#each filtered as effect}
        <div class="modifier-list-item" class:archived={effect.isArchived}>
          <div class="modifier-list-main">
            <div class="modifier-list-info">
              <strong>{effect.name}</strong>
              <small>{effect.sourceType.replace('_',' ')} · {effect.modifierCount} modifier{effect.modifierCount===1?'':'s'}{effect.referenceCount?' · used by '+effect.referenceCount:''}</small>
              {#if effect.isArchived}<span class="modifier-used-by muted">Archived</span>{/if}
            </div>
            <div class="modifier-list-actions">
              <a class="compact-button secondary" href={editHref(effect.id)}>Edit</a>
              <form method="POST" action="?/archive" style="display:contents">
                <input type="hidden" name="effectId" value={effect.id}/>
                <button class="compact-button danger">{effect.isArchived?'Restore':'Archive'}</button>
              </form>
            </div>
          </div>
        </div>
      {:else}
        <p class="muted" style="padding:12px">No effects match.</p>
      {/each}
    </div>

    <a class="button-link admin-new-button" href={cancelHref}>+ New Effect</a>
  </section>

  <!-- ── Create / Edit ─────────────────────────────────────────────── -->
  <section class="panel stack rules-create" id="effect-panel">
    <div class="panel-head">
      <h2>{editing?'Edit Effect':'Create Effect'}</h2>
      {#if editing}<span class="record-id">{editing.referenceCount} references</span>{/if}
    </div>

    <form method="POST" action="?/save" class="stack admin-form">
      <input type="hidden" name="effectId" value={editing?.id||''}/>
      <label>Name<input name="name" value={editing?.name||''} required/></label>
      <label>Type<select name="sourceType">
        <option value="condition"    selected={editing?.sourceType==='condition'}>Condition</option>
        <option value="combat_state" selected={editing?.sourceType==='combat_state'}>Combat State</option>
        <option value="environment"  selected={editing?.sourceType==='environment'}>Environment</option>
        <option value="class_feature" selected={editing?.sourceType==='class_feature'}>Class Feature</option>
        <option value="spell"        selected={editing?.sourceType==='spell'}>Spell</option>
        <option value="homebrew"     selected={!editing||editing.sourceType==='homebrew'}>Homebrew</option>
      </select></label>
      <label>Description<textarea name="description">{editing?.description||''}</textarea></label>
      <div class="mini-grid">
        <label>Duration<select name="durationType">
          <option value="variable"         selected={!editing||editing.durationType==='variable'}>Variable</option>
          <option value="timed"            selected={editing?.durationType==='timed'}>Timed</option>
          <option value="concentration"    selected={editing?.durationType==='concentration'}>Concentration</option>
          <option value="while_applicable" selected={editing?.durationType==='while_applicable'}>While Applicable</option>
        </select></label>
        <label>Rounds<input type="number" min="0" name="durationRounds" value={editing?.durationRounds??''}/></label>
      </div>
      <div class="mini-grid">
        <label>Stacking<select name="stackBehavior">
          <option value="refresh" selected={!editing||editing.stackBehavior==='refresh'}>Refresh</option>
          <option value="stack"   selected={editing?.stackBehavior==='stack'}>Stack</option>
          <option value="reject"  selected={editing?.stackBehavior==='reject'}>Reject</option>
        </select></label>
        <label>Expiry<select name="expiryBoundary">
          <option value="round_end"  selected={!editing||editing.expiryBoundary==='round_end'}>End of Round</option>
          <option value="turn_start" selected={editing?.expiryBoundary==='turn_start'}>Start of Turn</option>
          <option value="turn_end"   selected={editing?.expiryBoundary==='turn_end'}>End of Turn</option>
          <option value="manual"     selected={editing?.expiryBoundary==='manual'}>Manual</option>
        </select></label>
      </div>
      <label class="inline"><input type="checkbox" name="requiresConcentration" checked={editing?.requiresConcentration}/> Concentration</label>
      <label class="inline"><input type="checkbox" name="isCondition" checked={editing?.isCondition}/> Condition (harmful D&amp;D state)</label>
      <label class="inline"><input type="checkbox" name="isSelectable" checked={editing?.isSelectable??true}/> Players may activate manually</label>
      <div class="button-row">
        <button>{editing?'Save Effect':'Create Effect'}</button>
        {#if editing}<a class="button-link secondary" href={cancelHref}>Cancel</a>{/if}
      </div>
    </form>

    <!-- Attached Modifiers - only when editing an existing effect -->
    {#if editing}
      <div class="effect-modifiers-section">
        <div class="panel-head" style="margin-top:4px"><h3>Attached Modifiers</h3></div>
        <form method="POST" action="?/attach" class="stack admin-form">
          <input type="hidden" name="effectId" value={editing.id}/>
          <div class="mini-grid">
            <label>Modifier<select name="modifierId">
              {#each data.modifiers.filter((m)=>!m.isArchived) as m}
                <option value={m.id}>{m.label||`${m.hookLabel} / ${m.operation}${m.baseValue?' / '+m.baseValue:''}`}</option>
              {/each}
            </select></label>
            <label>Value override<input name="valueOverride"/></label>
          </div>
          <div class="mini-grid">
            <label>Condition<input name="condition"/></label>
            <label>Priority<input type="number" name="priority" value="0"/></label>
          </div>
          <button>Attach Modifier</button>
        </form>

        <div class="admin-library-list" style="margin-top:8px">
          {#each data.effectLinks as link}
            <article class="modifier-list-item">
              <div class="modifier-list-main">
                <div class="modifier-list-info">
                  <strong>{link.hookLabel} / {link.operation}</strong>
                  <small>{link.valueExpression||'Default value'}{link.condition?' · '+link.condition:''}</small>
                </div>
                <form method="POST" action="?/detach" style="display:contents">
                  <input type="hidden" name="effectId" value={editing.id}/>
                  <input type="hidden" name="linkId" value={link.id}/>
                  <button class="compact-button danger">Remove</button>
                </form>
              </div>
            </article>
          {:else}
            <p class="muted" style="padding:10px 12px">No modifiers attached.</p>
          {/each}
        </div>
      </div>
    {/if}
  </section>
</div>
