<script lang="ts">
  let { data, form } = $props();

  const selectedEffect = $derived(data.effects.find((effect) => effect.id === data.selectedEffect) ?? data.effects[0]);

  function targetLabel(target: string) {
    return data.targetLabelEntries[target] ?? target;
  }

  function typeLabel(type: string) {
    return data.typeLabelEntries[type] ?? type;
  }

  function modifierSummary(modifier: { target: string; modifierType: string; defaultValueExpression: string }) {
    return `${targetLabel(modifier.target)} / ${typeLabel(modifier.modifierType)}${modifier.defaultValueExpression ? ` / ${modifier.defaultValueExpression}` : ''}`;
  }
</script>

<section class="page-head">
  <div>
    <p class="eyebrow">Administration</p>
    <h1>Modifiers & Effects</h1>
  </div>
  <form method="POST" action="?/seedCore">
    <button type="submit">Seed Core Effects</button>
  </form>
</section>

{#if form?.error}
  <p class="form-error">{form.error}</p>
{/if}

{#if form?.seeded}
  <p class="form-success">Core effects seeded.</p>
{/if}

<div class="admin-grid">
  <section class="panel stack">
    <div class="panel-head">
      <h2>Effects</h2>
      <span class="muted">{data.effects.length} records</span>
    </div>

    <form method="GET" class="stack">
      <label>
        Select effect
        <select name="effect" onchange={(event) => event.currentTarget.form?.requestSubmit()}>
          {#each data.effects as effect}
            <option value={effect.id} selected={effect.id === data.selectedEffect}>
              {effect.name} ({effect.modifierCount})
            </option>
          {/each}
        </select>
      </label>
    </form>

    {#if selectedEffect}
      <form method="POST" action="?/updateEffect" class="stack admin-form">
        <input type="hidden" name="effectId" value={selectedEffect.id} />
        <label>Name <input name="name" value={selectedEffect.name} /></label>
        <label>Description <textarea name="description">{selectedEffect.description}</textarea></label>
        <label class="inline">
          <input name="isSelectable" type="checkbox" checked={selectedEffect.isSelectable} />
          Selectable in Player Modifications
        </label>
        <p class="muted">{selectedEffect.key} / {selectedEffect.sourceType}{selectedEffect.isHomebrew ? ' / homebrew' : ''}</p>
        <button type="submit">Update Effect</button>
      </form>
    {/if}

    <form method="POST" action="?/createEffect" class="stack admin-form">
      <h3>Create Custom Effect</h3>
      <label>Name <input name="name" placeholder="Blessing of the Forge" /></label>
      <label>
        Source type
        <select name="sourceType">
          <option value="homebrew">Homebrew</option>
          <option value="custom_article">Custom Article</option>
          <option value="spell">Spell</option>
          <option value="feat">Feat</option>
          <option value="item">Item</option>
          <option value="class_feature">Class Feature</option>
          <option value="environment">Environment</option>
        </select>
      </label>
      <label>
        Duration type
        <select name="durationType">
          <option value="variable">Variable</option>
          <option value="timed">Timed</option>
          <option value="concentration">Concentration</option>
          <option value="while_applicable">While Applicable</option>
          <option value="permanent">Permanent</option>
        </select>
      </label>
      <label>Description <textarea name="description"></textarea></label>
      <button type="submit">Create Effect</button>
    </form>
  </section>

  <section class="panel stack">
    <div class="panel-head">
      <h2>Attached Modifiers</h2>
      <span class="muted">{data.links.length} links</span>
    </div>

    {#if selectedEffect}
      <form method="POST" action="?/attachModifier" class="admin-form attach-form">
        <input type="hidden" name="effectId" value={selectedEffect.id} />
        <label>
          Modifier
          <select name="modifierId">
            {#each data.modifiers as modifier}
              <option value={modifier.id}>{modifierSummary(modifier)}</option>
            {/each}
          </select>
        </label>
        <label>Override Value <input name="valueOverrideExpression" placeholder="Optional, e.g. 1d6 or 3" /></label>
        <label>Condition <input name="conditionExpression" placeholder="Optional predicate" /></label>
        <label>Priority <input name="priority" type="number" value="0" /></label>
        <button type="submit">Attach</button>
      </form>
    {/if}

    <div class="admin-list">
      {#each data.links as link}
        <article class="admin-row">
          <div>
            <strong>{targetLabel(link.target)} / {typeLabel(link.modifierType)}</strong>
            <p class="muted">
              {link.target} / {link.modifierType}
              {#if link.resolvedValueExpression} / {link.resolvedValueExpression}{/if}
              {#if link.conditionExpression} / if {link.conditionExpression}{/if}
            </p>
          </div>
          <form method="POST" action="?/detachModifier">
            <input type="hidden" name="effectId" value={link.effectId} />
            <input type="hidden" name="linkId" value={link.id} />
            <button class="compact-button danger" type="submit">Remove</button>
          </form>
        </article>
      {:else}
        <p class="muted">No modifiers attached to this effect yet.</p>
      {/each}
    </div>
  </section>

  <section class="panel stack">
    <div class="panel-head">
      <h2>Modifier Catalogue</h2>
      <span class="muted">{data.modifiers.length} modifiers</span>
    </div>

    <form method="POST" action="?/createModifier" class="stack admin-form">
      <label>
        Target
        <select name="target">
          {#each data.modifierTargets as [key, label]}
            <option value={key}>{label} ({key})</option>
          {/each}
        </select>
      </label>
      <label>
        Type
        <select name="modifierType">
          {#each data.modifierTypes as [key, label]}
            <option value={key}>{label} ({key})</option>
          {/each}
        </select>
      </label>
      <label>Default Value <input name="defaultValueExpression" placeholder="Optional, e.g. 1d4, 2, rage_damage_bonus" /></label>
      <label>Friendly Label <input name="label" placeholder="Optional display label" /></label>
      <label>Description <textarea name="description"></textarea></label>
      <button type="submit">Add Modifier</button>
    </form>

    <div class="admin-list compact">
      {#each data.modifiers.slice(0, 80) as modifier}
        <article class="admin-row">
          <div>
            <strong>{modifierSummary(modifier)}</strong>
            <p class="muted">{modifier.target} / {modifier.modifierType}</p>
          </div>
        </article>
      {/each}
    </div>
  </section>
</div>
