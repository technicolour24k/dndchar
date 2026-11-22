<script lang="ts">
  import { enhance } from '$app/forms';
  let { data, form } = $props();
  const periods: Array<[string, string]> = [['long_rest', 'Long rest'], ['short_rest', 'Short rest'], ['dawn', 'Dawn'], ['encounter', 'New battle'], ['manual', 'Manual only']];
</script>

{#if form?.error}<p class="form-error">{form.error}</p>{/if}
{#if form?.saved}<p class="form-success">{form.saved}</p>{/if}
<div class="admin-grid two-column-admin admin-workspace-frame">
  <section class="panel stack">
    <div class="panel-head"><div><h2>Resource Pools</h2><p class="muted">Character-wide pools (Soulfire, Vowfire...). The maximum is the base plus every "&lt;Pool&gt; (max)" modifier a feat or item grants. Keys can't change.</p></div><span>{data.pools.length}</span></div>
    <div class="admin-list">
      {#each data.pools as pool (pool.key)}
        <details class="admin-row">
          <summary><strong>{pool.label}</strong> <span class="muted">{pool.key} · base {pool.baseMaxExpression} · {periods.find(([v]) => v === pool.rechargePeriod)?.[1]}{pool.isArchived ? ' · archived' : ''}</span></summary>
          <form method="POST" action="?/update" use:enhance class="stack admin-form">
            <input type="hidden" name="key" value={pool.key} />
            <div class="mini-grid">
              <label>Name<input name="label" value={pool.label} required /></label>
              <label>Base max<input name="baseMaxExpression" value={pool.baseMaxExpression} title="A number, level, proficiency_bonus or ability_modifier" /></label>
              <label>Refills on<select name="rechargePeriod">{#each periods as [value, text]}<option {value} selected={pool.rechargePeriod === value}>{text}</option>{/each}</select></label>
              <label>Sort<input name="sortOrder" type="number" value={pool.sortOrder} /></label>
            </div>
            <label>Description<textarea name="description" rows="2">{pool.description}</textarea></label>
            <label class="checkbox-row"><input type="checkbox" name="showWhenEmpty" checked={pool.showWhenEmpty} /> Show on the sheet even when the maximum is 0</label>
            <div class="actions"><button>Save</button></div>
          </form>
          <form method="POST" action="?/archive" use:enhance><input type="hidden" name="key" value={pool.key} /><button class="compact-button danger">{pool.isArchived ? 'Restore' : 'Archive'}</button></form>
        </details>
      {/each}
    </div>
  </section>
  <section class="panel stack">
    <h2>New Pool</h2>
    <form method="POST" action="?/create" use:enhance class="stack admin-form">
      <div class="mini-grid">
        <label>Name<input name="label" required /></label>
        <label>Key<input name="key" required pattern="[a-z][a-z0-9_]{'{1,39}'}" placeholder="e.g. ki_surge" title="Lowercase letters, digits, underscores. Can't change later." /></label>
        <label>Base max<input name="baseMaxExpression" value="0" /></label>
        <label>Refills on<select name="rechargePeriod">{#each periods as [value, text]}<option {value}>{text}</option>{/each}</select></label>
      </div>
      <label>Description<textarea name="description" rows="2"></textarea></label>
      <label class="checkbox-row"><input type="checkbox" name="showWhenEmpty" /> Show on the sheet even when the maximum is 0</label>
      <p class="muted">Also creates a "&lt;Name&gt; (max)" modifier, ready to attach to a feat or item.</p>
      <button>Create pool</button>
    </form>
  </section>
</div>
