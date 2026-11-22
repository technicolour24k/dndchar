<script lang="ts">
  import { costSummary, defaultCostFor, effectiveCost, itemCostConflictsWithStep, withCategory } from '$lib/rules/cost';
  import { inferCategory, PROFILES } from '$lib/rules/actionEconomy';
  import type { CostEntry } from '$lib/types/cost';
  import type { TurnCategory, TurnLine, TurnTiming } from '$lib/types/actionEconomy';

  // The Cost block of the content editor. Posts one hidden `costJson` field: '' = use the default
  // (NULL cost_json), otherwise the explicit list. Mount it with {#key entry.id} so it resets
  // when another entry is selected.
  let { initial, contentType, spellLevel, castingTime, hasSpendItemStep, pools, counters }: {
    initial: CostEntry[] | null; contentType: string; spellLevel: number | null; castingTime: string;
    hasSpendItemStep: boolean; pools: Array<{ key: string; label: string }>; counters: Array<{ key: string; label: string }>;
  } = $props();

  // A turn row is the action-economy line: a timing, a category (what the campaign's profile maps to a pool)
  // and an optional specific pool (an escape hatch that only applies where the profile has that pool).
  type Row = { pool: string; amount: number; level: number; key: string; timing: TurnTiming; category: TurnCategory | ''; actionPool: string };
  const toRow = (entry: CostEntry): Row => {
    const turn = entry.pool === 'turn' ? (entry as TurnLine) : null;
    return {
      pool: entry.pool, amount: entry.amount,
      level: entry.pool === 'spell_slot' ? (entry as { level: number }).level : 1,
      key: entry.pool === 'charges' ? (entry as { key?: string }).key ?? '' : '',
      timing: turn?.timing ?? 'action', category: turn?.category ?? '', actionPool: turn?.actionPool ?? ''
    };
  };

  // Only the first value matters: the parent re-mounts this per entry ({#key}).
  // svelte-ignore state_referenced_locally
  let useDefault = $state(initial === null);
  // svelte-ignore state_referenced_locally
  let rows = $state<Row[]>((initial ?? []).map(toRow));
  const labels = $derived(Object.fromEntries(pools.map((pool) => [pool.key, pool.label])));
  const defaultText = $derived(costSummary(
    defaultCostFor({ contentType, spellLevel, castingTime, isItemUse: contentType === 'item', hasSpendItemStep }), labels));

  const entries = $derived<CostEntry[]>(rows.map((row) => {
    if (row.pool === 'spell_slot') return { pool: 'spell_slot', amount: row.amount, level: row.level };
    if (row.pool === 'charges') return row.key ? { pool: 'charges', amount: row.amount, key: row.key } : { pool: 'charges', amount: row.amount };
    if (row.pool === 'turn') {
      const line: TurnLine = { pool: 'turn', amount: row.amount, timing: row.timing };
      if (row.category) line.category = row.category;
      if (row.actionPool) line.actionPool = row.actionPool;
      return line;
    }
    return { pool: row.pool, amount: row.amount };
  }));
  // What each campaign profile would charge for this entry: the explicit list, or the default, with the
  // default action line inherited the way the engine does (effectiveCost) and the category filled in from the type.
  const profileList = Object.values(PROFILES);
  const defaultsForPreview = $derived(withCategory(
    defaultCostFor({ contentType, spellLevel, castingTime, isItemUse: contentType === 'item', hasSpendItemStep, includeUseAction: true }), inferCategory(contentType)));
  const effective = $derived(effectiveCost(useDefault ? null : entries, defaultsForPreview));
  const preview = $derived(profileList.map((profile) => ({ key: profile.key, label: profile.label, text: costSummary(withCategory(effective, inferCategory(contentType)), labels, profile.key) })));
  const hasTurnRow = $derived(!useDefault && rows.some((row) => row.pool === 'turn'));

  const conflict = $derived(contentType === 'item' && itemCostConflictsWithStep(useDefault ? null : entries, hasSpendItemStep));

  function addRow() { rows.push({ pool: contentType === 'spell' ? 'spell_slot' : pools[0]?.key ?? 'turn', amount: 1, level: Math.max(1, spellLevel ?? 1), key: '', timing: 'action', category: '', actionPool: '' }); }
  // Choosing the action row fills its category from the entry's type (spell / general), still editable.
  function poolChanged(row: Row) { if (row.pool === 'turn' && !row.category) row.category = inferCategory(contentType); }
</script>

<div class="cost-editor stack">
  <div class="cost-editor-head">
    <strong>Cost</strong>
    <label class="inline"><input type="checkbox" bind:checked={useDefault} /> Use default cost</label>
    <span class="muted">{useDefault ? `Default: ${defaultText}` : rows.length ? costSummary(entries, labels) : 'Free (no cost)'}</span>
  </div>
  <input type="hidden" name="costJson" value={useDefault ? '' : JSON.stringify(entries)} />
  {#if !useDefault}
    {#each rows as row, index (index)}
      <div class="cost-row" class:turn={row.pool === 'turn'}>
        <select bind:value={row.pool} onchange={() => poolChanged(row)} aria-label="Cost pool">
          <option value="spell_slot">Spell slot</option>
          <option value="charges">This entry's counter</option>
          {#if contentType === 'item'}<option value="item">Item quantity</option>{/if}
          {#each pools as pool}<option value={pool.key}>{pool.label}</option>{/each}
          {#if row.pool === 'turn' || !hasTurnRow}<option value="turn">Action economy (timing and category)</option>{/if}
        </select>
        <input type="number" min="1" max="99" bind:value={row.amount} aria-label="Amount" />
        {#if row.pool === 'spell_slot'}
          <select bind:value={row.level} aria-label="Minimum slot level">{#each [1, 2, 3, 4, 5, 6, 7, 8, 9] as level}<option value={level}>Level {level}+</option>{/each}</select>
        {:else if row.pool === 'turn'}
          <select bind:value={row.timing} aria-label="Action timing">
            <option value="action">Action</option><option value="bonus_action">Bonus action</option><option value="reaction">Reaction</option>
            <option value="movement">Movement</option><option value="free">Free</option>
          </select>
          <select bind:value={row.category} aria-label="Action category">
            <option value="">Category: from the entry</option><option value="attack">Attack</option><option value="spell">Spell</option><option value="general">General</option>
          </select>
          <select bind:value={row.actionPool} aria-label="Specific pool" title="Only used in campaigns whose profile has this pool">
            <option value="">Specific pool: none</option>
            {#each profileList as profile}<optgroup label={profile.label}>{#each profile.pools as pool}<option value={pool.key}>{pool.label}</option>{/each}</optgroup>{/each}
          </select>
        {:else if row.pool === 'charges'}
          <select bind:value={row.key} aria-label="Counter"><option value="">{counters.length === 1 ? 'The only counter' : 'Choose counter...'}</option>{#each counters as counter}<option value={counter.key}>{counter.label}</option>{/each}</select>
        {/if}
        <button type="button" class="compact-button danger" onclick={() => rows.splice(index, 1)} aria-label="Remove cost line">x</button>
      </div>
    {/each}
    <div><button type="button" class="compact-button" onclick={addRow}>+ Add cost line</button></div>
  {/if}
  <div class="cost-preview muted">
    {#each preview as line}<div><strong>{line.label}:</strong> {line.text}</div>{/each}
    {#if !hasTurnRow && defaultsForPreview.some((line) => line.pool === 'turn')}<div>Action cost: inherited from the default for this entry (a spell by its casting time, an item use takes 1 action). Add an Action economy row with timing Free to make it take no action.</div>{:else if hasTurnRow}<div>Specific pool is only used in campaigns whose profile has that pool; elsewhere the timing and category decide.</div>{/if}
  </div>
  {#if conflict}<p class="form-error">This item has an item quantity cost AND an on-use Spend Item step. The step already pays, so the item cost line is ignored. Remove one of them.</p>{/if}
</div>

<style>
  .cost-editor { border: 1px solid var(--border, #444); border-radius: 6px; padding: 0.5rem 0.6rem; gap: 0.4rem; }
  .cost-editor-head { display: flex; flex-wrap: wrap; gap: 0.3rem 0.8rem; align-items: center; }
  .cost-row { display: grid; grid-template-columns: minmax(8rem, 1.4fr) 4.5rem minmax(7rem, 1fr) auto; gap: 0.4rem; align-items: center; }
  .cost-row.turn { grid-template-columns: minmax(8rem, 1.4fr) 4.5rem repeat(3, minmax(6rem, 1fr)) auto; }
  .cost-preview { font-size: 0.85rem; }
  @media (max-width: 600px) { .cost-row { grid-template-columns: 1fr 4.5rem; } }
</style>
