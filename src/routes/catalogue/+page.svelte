<script lang="ts">let { data, form } = $props();</script>
<section class="page-head"><div><p class="eyebrow">Rules</p><h1>Content Catalogue</h1></div></section>
{#if form?.error}<p class="form-error">{form.error}</p>{/if}
{#if form?.created}<p class="form-success">Homebrew created and available.</p>{/if}

<section class="panel stack catalogue-toolbar">
  <form method="GET" class="catalogue-filter">
    <label>Search<input name="search" /></label>
    <label>Type<select name="type"><option value="">All</option><option value="item">Items</option><option value="spell">Spells</option><option value="feat">Feats</option><option value="class_feature">Class Features</option></select></label>
    <button type="submit">Search</button>
  </form>
</section>

<div class="content-grid catalogue-layout">
  <section class="panel stack">
    <div class="panel-head"><h2>Available Content</h2><span class="muted">{data.content.length} entries</span></div>
    <div class="catalogue-list">
      {#each data.content as entry}
        <article class="catalogue-card">
          <div><span class="eyebrow">{entry.type.replace('_', ' ')} / {entry.sourceKind}</span><h3>{entry.name}</h3><p>{entry.description}</p></div>
          <span class="status-chip">{entry.sourceKind === 'srd' ? 'SRD' : 'Homebrew'}</span>
          {#if entry.ownerUserId===data.user?.id}<details><summary>Edit your entry</summary><form method="POST" action="?/updateOwned" class="stack admin-form"><input type="hidden" name="contentId" value={entry.id}/><label>Name<input name="name" value={entry.name}/></label><label>Description<textarea name="description">{entry.description}</textarea></label><div class="button-row"><button>Save</button><button formaction="?/archiveOwned" class="danger">Archive</button></div></form></details>{/if}
        </article>
      {:else}<p class="muted">No catalogue entries match.</p>{/each}
    </div>
  </section>

  <aside class="panel stack">
    <h2>Create Homebrew</h2>
    <form method="POST" action="?/create" class="stack">
      <label>Type<select name="contentType"><option value="item">Item</option><option value="spell">Spell</option><option value="feat">Feat</option><option value="class_feature">Class Feature</option></select></label>
      <label>Name<input name="name" required /></label>
      <label>Description<textarea name="description"></textarea></label>
      <div class="mini-grid"><label>Spell Level<input name="spellLevel" type="number" min="0" max="9" /></label><label>School<input name="school" /></label></div>
      <label>Classes<input name="classes" placeholder="Wizard, Sorcerer" /></label>
      <div class="mini-grid"><label>Item Category<input name="category" value="gear" /></label><label>Damage Dice<input name="damageRolls" placeholder="1d8" /></label></div>
      <label class="inline"><input name="requiresAttunement" type="checkbox" /> Requires attunement</label>
      <button type="submit">Create Entry</button>
    </form>
    <h2>Configure Homebrew</h2>
    <form method="POST" action="?/attachEffect" class="stack admin-form">
      <label>Your Content<select name="contentId">{#each data.content.filter((entry) => entry.ownerUserId===data.user?.id) as entry}<option value={entry.id}>{entry.name}</option>{/each}</select></label>
      <label>Effect Bundle<select name="effectId">{#each data.effects as effect}<option value={effect.id}>{effect.name}</option>{/each}</select></label>
      <label>Activation<select name="activationType"><option value="manual">Manual</option><option value="carried">Carried</option><option value="equipped">Equipped</option><option value="attuned">Attuned</option><option value="on_use">On Use</option></select></label>
      <button type="submit">Attach Effect</button>
    </form>
    <form method="POST" action="?/addResource" class="stack admin-form">
      <label>Your Content<select name="contentId">{#each data.content.filter((entry) => entry.ownerUserId===data.user?.id) as entry}<option value={entry.id}>{entry.name}</option>{/each}</select></label>
      <div class="mini-grid"><label>Counter Key<input name="resourceKey" required /></label><label>Label<input name="resourceLabel" required /></label></div>
      <label>Maximum<input name="maxValueExpression" value="1" /></label>
      <label>Recharge<select name="rechargePeriod"><option value="short_rest">Short Rest</option><option value="long_rest">Long Rest</option><option value="dawn">Dawn</option><option value="round">Round</option><option value="encounter">Encounter</option><option value="manual">Manual</option></select></label>
      <button type="submit">Add Uses Counter</button>
    </form>
  </aside>
</div>
