<script lang="ts">
  import { backdropPress } from '$lib/ui/backdropPress';
  import {
    adjustPrimaryDamageDice,
    advantageSourceLabel,
    previewAdvantage,
    situationalAdvantageSources,
    type RollChoices
  } from '$lib/rules/attackRoll';
  import type { ModifierContext } from '$lib/rules/dnd5e';
  import type { ActiveCharacterEffect } from '$lib/types/character';

  // The one shared pre-roll options panel for every d20 roll on the sheet (saves, skills, ability
  // checks, initiative, attacks, death saves), plus a damage-dice-only variant for spell damage.
  // It reuses the same pure resolution code as the VTT endpoints (previewAdvantage etc.), so the
  // sums can't drift. It only collects CHOICES (unticked sources, the situational counters, the
  // INTERIM damage-dice delta); the caller does the actual roll with them.
  //
  // Opens with Roll focused, so Enter (or one tap) rolls with the defaults.
  let {
    title,
    advantage,
    damageDice,
    onroll,
    oncancel
  }: {
    title: string;
    // null = no d20 on this roll (spell damage): the advantage section is hidden.
    // batch = "Roll all": counters only, applied to every line (the sources differ per line).
    advantage: { effects: ActiveCharacterEffect[]; candidates: string[]; context: ModifierContext; batch?: boolean } | null;
    // INTERIM: manual damage-dice control. null = hide it.
    damageDice: { baseExpression: string } | null;
    onroll: (choices: RollChoices) => void;
    oncancel: () => void;
  } = $props();

  let disabledIds = $state<string[]>([]);
  let situationalAdvantage = $state(0);
  let situationalDisadvantage = $state(0);
  // INTERIM: manual damage-dice delta, -5..+5.
  let manualDamageDice = $state(0);
  let rollButton = $state<HTMLButtonElement | null>(null);

  // Focus Roll on open (not `autofocus`, which Svelte warns about).
  $effect(() => {
    rollButton?.focus();
  });

  const batch = $derived(Boolean(advantage?.batch));
  const preview = $derived(
    advantage
      ? previewAdvantage(
          batch ? [] : advantage.effects,
          batch ? [] : advantage.candidates,
          advantage.context,
          situationalAdvantageSources(situationalAdvantage, situationalDisadvantage),
          disabledIds
        )
      : null
  );
  // Sources the user can tick (everything except the manual counters).
  const sources = $derived((preview?.sources ?? []).filter((source) => source.origin !== 'situational'));
  const damagePreview = $derived(damageDice ? adjustPrimaryDamageDice(damageDice.baseExpression, manualDamageDice) : null);

  const readout = $derived.by(() => {
    if (!preview) return '';
    const { advantageCount, disadvantageCount, net, poolSize } = preview.pool;
    if (advantageCount === 0 && disadvantageCount === 0) return 'Flat roll';
    const counts = `(${advantageCount} adv, ${disadvantageCount} dis)`;
    if (net === 0) return `Net 0 ${counts}: flat roll`;
    return `Net ${net > 0 ? '+' : ''}${net} ${counts}: roll ${poolSize}d20, keep ${net > 0 ? 'highest' : 'lowest'}`;
  });

  function toggleSource(id: string, ticked: boolean) {
    disabledIds = ticked ? disabledIds.filter((entry) => entry !== id) : [...disabledIds, id];
  }

  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

  function roll() {
    onroll({ disabledSourceIds: disabledIds, situationalAdvantage, situationalDisadvantage, manualDamageDice });
  }

  // This component renders inside the sheet's own <form>, so it can't be a nested form. Enter on a
  // tick box rolls (Enter on a button just presses that button, as normal).
  function handleKeydown(event: KeyboardEvent) {
    const target = event.target as HTMLElement;
    if (event.key === 'Enter' && target.tagName === 'INPUT') {
      event.preventDefault();
      roll();
    }
  }
</script>

<div class="modal-backdrop" role="presentation" onpointerdown={backdropPress(oncancel)}>
  <div
    class="panel compact-modal roll-options"
    role="dialog"
    aria-modal="true"
    aria-labelledby="roll-options-title"
    tabindex="-1"
    onpointerdown={(event) => event.stopPropagation()}
    onkeydown={handleKeydown}
  >
    <div class="panel-head">
      <h2 id="roll-options-title">{title}</h2>
      <button type="button" class="text-button" onclick={oncancel}>Cancel</button>
    </div>

    {#if advantage}
      <section class="roll-options-section">
        <h3>Advantage</h3>
        {#if !batch}
          {#each sources as source (source.id)}
            <label class="roll-options-source">
              <input type="checkbox" checked={source.applied} onchange={(event) => toggleSource(source.id, event.currentTarget.checked)} />
              <span>{advantageSourceLabel(source)}</span>
            </label>
          {/each}
        {/if}
        <div class="roll-options-row">
          <span>Advantage</span>
          <button type="button" aria-label="Fewer advantage" onclick={() => (situationalAdvantage = clamp(situationalAdvantage - 1, 0, 5))}>-</button>
          <strong aria-live="polite">{situationalAdvantage}</strong>
          <button type="button" aria-label="More advantage" onclick={() => (situationalAdvantage = clamp(situationalAdvantage + 1, 0, 5))}>+</button>
        </div>
        <div class="roll-options-row">
          <span>Disadvantage</span>
          <button type="button" aria-label="Fewer disadvantage" onclick={() => (situationalDisadvantage = clamp(situationalDisadvantage - 1, 0, 5))}>-</button>
          <strong aria-live="polite">{situationalDisadvantage}</strong>
          <button type="button" aria-label="More disadvantage" onclick={() => (situationalDisadvantage = clamp(situationalDisadvantage + 1, 0, 5))}>+</button>
        </div>
        <p class="muted">Each point counts as one source. Advantage and disadvantage cancel one for one.{batch ? ' Applies to every roll in this batch.' : ''}</p>
        <p class="roll-options-readout">{readout}</p>
      </section>
    {/if}

    {#if damageDice}
      <section class="roll-options-section">
        <h3>Damage dice <span class="roll-options-manual">manual</span></h3>
        <div class="roll-options-row">
          <span>Dice</span>
          <button type="button" aria-label="Fewer damage dice" onclick={() => (manualDamageDice = clamp(manualDamageDice - 1, -5, 5))}>-</button>
          <strong aria-live="polite">{manualDamageDice > 0 ? `+${manualDamageDice}` : manualDamageDice}</strong>
          <button type="button" aria-label="More damage dice" onclick={() => (manualDamageDice = clamp(manualDamageDice + 1, -5, 5))}>+</button>
        </div>
        {#if damagePreview && manualDamageDice !== 0}
          <p class="muted">{damagePreview.auditLine ?? damagePreview.expression}</p>
        {/if}
      </section>
    {/if}

    <div class="roll-options-actions">
      <button type="button" class="secondary" onclick={oncancel}>Cancel</button>
      <button type="button" class="roll-options-roll" bind:this={rollButton} onclick={roll}>Roll</button>
    </div>
  </div>
</div>
