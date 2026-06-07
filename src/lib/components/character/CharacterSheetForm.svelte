<script lang="ts">
  import { enhance } from '$app/forms';
  import { abilityMap, abilityModifier, proficiencyBonus, totalLevel } from '$lib/rules/dnd5e';
  import type { AbilityKey, CharacterDetail } from '$lib/types/character';

  let {
    character,
    result,
    onVersionHistory
  }: {
    character: CharacterDetail;
    result?: Record<string, unknown>;
    onVersionHistory?: () => void;
  } = $props();

  const classes = $derived(character.classes[0] ?? { className: 'Fighter', level: 1 });
  const resources = $derived(Object.fromEntries(character.resources.map((resource) => [resource.key, resource])));
  const hp = $derived(resources.hp ?? { currentValue: 10, maxValue: 10 });
  const tempHp = $derived(resources.temp_hp ?? { currentValue: 0, maxValue: 0 });
  const inspiration = $derived(resources.inspiration?.currentValue ?? 0);
  const abilityScores = $derived(abilityMap(character.abilities));
  const level = $derived(totalLevel(character.classes));
  const prof = $derived(proficiencyBonus(level));
  const metadata = $derived(character.metadata ?? {});
  const race = $derived(String(character.metadata?.race ?? ''));
  const inventory = $derived(character.inventory[0] ?? {
    name: '',
    category: 'gear',
    quantity: 1,
    equipped: false,
    acBonus: 0,
    abilityBonuses: {},
    notes: ''
  });
  const attack = $derived(character.attacks[0] ?? {
    name: '',
    attackAbility: 'str' as AbilityKey,
    proficient: true,
    damageDice: '',
    notes: ''
  });
  const notes = $derived(Object.fromEntries(character.notes.map((note) => [note.key, note.content])));

  let activeTab = $state<'battle' | 'traits' | 'inventory' | 'character'>('battle');
  let autosaveTimer: ReturnType<typeof setTimeout>;
  let autosaveStatus = $state('Ready');
  let lastAutosaveAt = 0;
  let deathSaveSuccesses = $state(0);
  let deathSaveFailures = $state(0);
  let savingThrowsOpen = $state(false);
  let skillChecksOpen = $state(false);
  const autosaveIntervalMs = 30_000;
  const abilityOrder: AbilityKey[] = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
  const skillChecks: Array<{ name: string; ability: AbilityKey }> = [
    { name: 'Acrobatics', ability: 'dex' },
    { name: 'Animal Handling', ability: 'wis' },
    { name: 'Arcana', ability: 'int' },
    { name: 'Athletics', ability: 'str' },
    { name: 'Deception', ability: 'cha' },
    { name: 'History', ability: 'int' },
    { name: 'Insight', ability: 'wis' },
    { name: 'Intimidation', ability: 'cha' },
    { name: 'Investigation', ability: 'int' },
    { name: 'Medicine', ability: 'wis' },
    { name: 'Nature', ability: 'int' },
    { name: 'Perception', ability: 'wis' },
    { name: 'Performance', ability: 'cha' },
    { name: 'Persuasion', ability: 'cha' },
    { name: 'Religion', ability: 'int' },
    { name: 'Sleight of Hand', ability: 'dex' },
    { name: 'Stealth', ability: 'dex' },
    { name: 'Survival', ability: 'wis' }
  ];

  function meta(field: string, fallback = '') {
    return String(metadata[field] ?? fallback);
  }

  function clampDeathSave(value: unknown) {
    return Math.min(3, Math.max(0, Number(value) || 0));
  }

  function setDeathSaves(kind: 'success' | 'failure', value: number) {
    if (kind === 'success') {
      deathSaveSuccesses = deathSaveSuccesses === value ? value - 1 : value;
      return;
    }

    deathSaveFailures = deathSaveFailures === value ? value - 1 : value;
  }

  $effect(() => {
    deathSaveSuccesses = clampDeathSave(metadata.deathSaveSuccesses);
    deathSaveFailures = clampDeathSave(metadata.deathSaveFailures);
  });

  function signed(value: number) {
    return value >= 0 ? `+${value}` : String(value);
  }

  async function runAutosave(form: HTMLFormElement) {
    autosaveStatus = 'Autosaving';
    const response = await fetch('?/autosave', {
      method: 'POST',
      body: new FormData(form)
    });
    lastAutosaveAt = Date.now();
    autosaveStatus = response.ok ? 'Autosaved' : 'Autosave failed';
  }

  function scheduleAutosaveOnBlur(form: HTMLFormElement) {
    const elapsed = Date.now() - lastAutosaveAt;
    clearTimeout(autosaveTimer);
    autosaveStatus = 'Unsaved';

    if (elapsed >= autosaveIntervalMs) {
      void runAutosave(form);
      return;
    }

    const wait = autosaveIntervalMs - elapsed;
    autosaveStatus = `Autosave queued (${Math.ceil(wait / 1000)}s)`;
    autosaveTimer = setTimeout(() => {
      void runAutosave(form);
    }, wait);
  }
</script>

<form
  method="POST"
  action="?/save"
  class="sheet-form"
  use:enhance={() => {
    return async ({ update, result }) => {
      await update({ reset: false });
      autosaveStatus = result.type === 'success' ? 'Saved' : 'Save failed';
    };
  }}
  onfocusout={(event) => scheduleAutosaveOnBlur(event.currentTarget)}
>
  <section class="panel sheet-header compact">
    <div>
      <p class="eyebrow">D&D 5E 2014</p>
      <h1>{character.name}</h1>
      <p class="muted">
        {race || character.ancestry || 'Unknown origin'} - {classes.className} {classes.level}
      </p>
    </div>
    <nav class="sheet-tabs in-header" aria-label="Character sheet sections">
      <button type="button" class:active={activeTab === 'battle'} onclick={() => (activeTab = 'battle')}>Battle</button>
      <button type="button" class:active={activeTab === 'traits'} onclick={() => (activeTab = 'traits')}>Traits</button>
      <button type="button" class:active={activeTab === 'inventory'} onclick={() => (activeTab = 'inventory')}>Inventory</button>
      <button type="button" class:active={activeTab === 'character'} onclick={() => (activeTab = 'character')}>Character</button>
    </nav>
    <div class="actions">
      <span class="save-state">{autosaveStatus}</span>
      {#if result?.saved}
        <span class="save-state good">Saved</span>
      {/if}
      <button type="submit">Save</button>
      {#if onVersionHistory}
        <button type="button" class="text-button" onclick={onVersionHistory}>Version History</button>
      {/if}
    </div>
  </section>

  {#if activeTab === 'battle'}
    <section class="battle-layout">
      <div class="battle-top-row">
        <section class="panel stack compact-panel">
          <h2>Health & Resources</h2>
          <div class="mini-grid compact-control-grid">
            <label>Current HP <input name="hpCurrent" type="number" value={hp.currentValue} /></label>
            <label>Max HP <input name="hpMax" type="number" value={hp.maxValue} /></label>
            <label>Temp HP <input name="tempHp" type="number" value={tempHp.currentValue} /></label>
            <label>Inspiration <input name="inspiration" type="number" min="0" value={inspiration} /></label>
          </div>
        </section>

        <section class="panel stack compact-panel">
          <h2>Combat Summary</h2>
          <div class="combat-summary-grid">
            <label>Proficiency <input type="text" value={`+${prof}`} readonly /></label>
            <label>Armor Class <input name="armorClass" type="number" value={meta('armorClass')} /></label>
            <label>Hit Dice <input name="hitDice" value={meta('hitDice')} placeholder="1d10, 4d8" /></label>
            <label>Passive Perception <input name="passivePerception" type="number" value={meta('passivePerception')} /></label>
            <label>Initiative <input name="initiative" value={meta('initiative')} placeholder="+2" /></label>
            <label>Speed <input name="speed" value={meta('speed')} placeholder="30 ft." /></label>
            <div class="death-save-grid" aria-label="Death saves">
              <input name="deathSaveSuccesses" type="hidden" value={deathSaveSuccesses} />
              <input name="deathSaveFailures" type="hidden" value={deathSaveFailures} />
              <div class="death-save-row success">
                <span>Successes</span>
                <div class="death-save-icons">
                  {#each [1, 2, 3] as value}
                    <button
                      type="button"
                      class="death-save-icon success"
                      class:active={deathSaveSuccesses >= value}
                      aria-pressed={deathSaveSuccesses >= value}
                      aria-label={`Death save success ${value}`}
                      onclick={() => setDeathSaves('success', value)}
                    ></button>
                  {/each}
                </div>
              </div>
              <div class="death-save-row failure">
                <span>Failures</span>
                <div class="death-save-icons">
                  {#each [1, 2, 3] as value}
                    <button
                      type="button"
                      class="death-save-icon failure"
                      class:active={deathSaveFailures >= value}
                      aria-pressed={deathSaveFailures >= value}
                      aria-label={`Death save failure ${value}`}
                      onclick={() => setDeathSaves('failure', value)}
                    ></button>
                  {/each}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section class="panel stack compact-panel">
          <h2>Abilities</h2>
          <div class="ability-panel-body">
            <div class="ability-grid compact-ability-grid">
              {#each abilityOrder as key}
                <label class="ability-card">
                  <span class="ability-line">
                    <strong>{key.toUpperCase()}:</strong>
                    <input name={`ability_${key}`} type="number" min="1" value={abilityScores[key]} />
                  </span>
                  <span class="modifier-line">Mod: {abilityModifier(abilityScores[key])}</span>
                </label>
              {/each}
            </div>
            <div class="ability-popup-links">
              <button type="button" class="text-button" onclick={() => (savingThrowsOpen = true)}>Saving Throws</button>
              <button type="button" class="text-button" onclick={() => (skillChecksOpen = true)}>Skill Checks</button>
            </div>
          </div>
        </section>
      </div>

      <div class="battle-main-row">
        <section class="panel stack">
          <h2>Battle Actions</h2>
          <p class="muted">Weapons, shield bashes, spell attacks, maneuvers, and anything flagged as available in battle.</p>
          <label>Action Name <input name="attackName" value={attack.name} placeholder="Longsword, Shield Bash, Fire Bolt" /></label>
          <label>Ability
            <select name="attackAbility">
              {#each ['str', 'dex', 'con', 'int', 'wis', 'cha'] as ability}
                <option value={ability} selected={attack.attackAbility === ability}>{ability.toUpperCase()}</option>
              {/each}
            </select>
          </label>
          <label>Damage / Effect Dice <input name="attackDamageDice" value={attack.damageDice} placeholder="1d8, 2d6, 1d10+3" /></label>
          <label class="inline"><input name="attackProficient" type="checkbox" checked={attack.proficient} /> Add proficiency</label>
          <label>Action Notes <textarea name="attackNotes">{attack.notes}</textarea></label>
        </section>

        <section class="panel stack">
          <h2>Magic & Battle Notes</h2>
          <div class="mini-grid">
            <label>Spellcasting Ability <input name="spellcastingAbility" value={meta('spellcastingAbility')} placeholder="INT, WIS, CHA" /></label>
            <label>Spell Save DC <input name="spellSaveDc" type="number" value={meta('spellSaveDc')} /></label>
            <label>Spell Attack Bonus <input name="spellAttackBonus" value={meta('spellAttackBonus')} placeholder="+5" /></label>
          </div>
          <label>Spellcasting <textarea name="spellcastingNote">{notes.spellcasting ?? ''}</textarea></label>
          <label>Spell Slots <textarea name="spellSlotsNote">{notes.spell_slots ?? ''}</textarea></label>
          <label>Prepared / Known Spells <textarea name="preparedSpellsNote">{notes.prepared_spells ?? ''}</textarea></label>
          <label>Saving Throws <textarea name="savingThrowsNote">{notes.saving_throws ?? ''}</textarea></label>
          <label>Skills <textarea name="skillsNote">{notes.skills ?? ''}</textarea></label>
          <label>Conditions & Effects <textarea name="conditionsNote">{notes.conditions ?? ''}</textarea></label>
          <label>Battle Notes <textarea name="battleNotes">{notes.battle_notes ?? ''}</textarea></label>
          <label>Attacks Summary <textarea name="attacksNote">{notes.attacks ?? ''}</textarea></label>
        </section>
      </div>
    </section>
  {/if}

  {#if activeTab === 'traits'}
    <section class="panel stack">
      <div class="panel-head">
        <h2>Traits & Features</h2>
        <span>Useful, passive, limited-use, and situational abilities</span>
      </div>
      <div class="note-grid">
        <label>Class Features <textarea name="classFeaturesNote">{notes.class_features ?? ''}</textarea></label>
        <label>Feats <textarea name="featsNote">{notes.feats ?? ''}</textarea></label>
        <label>Traits <textarea name="traitsNote">{notes.traits ?? ''}</textarea></label>
        <label>Usable Traits <textarea name="usableTraitsNote">{notes.usable_traits ?? ''}</textarea></label>
        <label>Proficiencies & Languages <textarea name="proficienciesLanguagesNote">{notes.proficiencies_languages ?? ''}</textarea></label>
        <label>Limited Uses <textarea name="limitedUsesNote">{notes.limited_uses ?? ''}</textarea></label>
      </div>
    </section>
  {/if}

  {#if activeTab === 'inventory'}
    <section class="sheet-columns">
      <section class="panel stack">
        <h2>Equipment</h2>
        <label>Item <input name="inventoryName" value={inventory.name} placeholder="Longsword, Potion of Healing, Gold Ring" /></label>
        <label>Category <input name="inventoryCategory" value={inventory.category} placeholder="weapon, armor, potion, treasure, junk" /></label>
        <label>Quantity <input name="inventoryQuantity" type="number" min="0" value={inventory.quantity} /></label>
        <label>AC Bonus <input name="inventoryAcBonus" type="number" value={inventory.acBonus} /></label>
        <label class="inline"><input name="inventoryEquipped" type="checkbox" checked={inventory.equipped} /> Equipped</label>
        <label>Notes <textarea name="inventoryNotes">{inventory.notes}</textarea></label>
      </section>

      <section class="panel stack">
        <h2>Inventory Intent</h2>
        <p class="muted">Track gear, usable items, potions, treasure, and general junk separately here as the model expands.</p>
        <div class="mini-grid">
          <label>CP <input name="currencyCp" type="number" min="0" value={meta('currencyCp')} /></label>
          <label>SP <input name="currencySp" type="number" min="0" value={meta('currencySp')} /></label>
          <label>EP <input name="currencyEp" type="number" min="0" value={meta('currencyEp')} /></label>
          <label>GP <input name="currencyGp" type="number" min="0" value={meta('currencyGp')} /></label>
          <label>PP <input name="currencyPp" type="number" min="0" value={meta('currencyPp')} /></label>
        </div>
        <label>Treasure & Valuables <textarea name="treasureNote">{notes.treasure ?? ''}</textarea></label>
        <label>General Inventory / Junk <textarea name="generalInventoryNote">{notes.general_inventory ?? ''}</textarea></label>
      </section>
    </section>
  {/if}

  {#if activeTab === 'character'}
    <section class="sheet-columns character-layout">
      <section class="panel stack">
        <h2>Identity</h2>
        <label>Character Name <input name="name" value={character.name} required /></label>
        <label>Class <input name="className" value={classes.className} /></label>
        <label>Level <input name="level" type="number" min="1" max="20" value={classes.level} /></label>
        <label>Ancestry <input name="ancestry" value={character.ancestry} /></label>
        <label>Race <input name="race" value={race} /></label>
        <label>Background <input name="background" value={character.background} /></label>
        <label>Alignment <input name="alignment" value={meta('alignment')} /></label>
        <label>Player Name <input name="playerName" value={meta('playerName')} /></label>
        <label>Experience Points <input name="experiencePoints" type="number" min="0" value={meta('experiencePoints')} /></label>
      </section>

      <section class="panel stack">
        <h2>Roleplay</h2>
        <label>Personality Traits <textarea name="personalityNote">{notes.personality ?? ''}</textarea></label>
        <label>Ideals <textarea name="idealsNote">{notes.ideals ?? ''}</textarea></label>
        <label>Bonds <textarea name="bondsNote">{notes.bonds ?? ''}</textarea></label>
        <label>Flaws <textarea name="flawsNote">{notes.flaws ?? ''}</textarea></label>
      </section>

      <section class="panel stack">
        <h2>Physical Description</h2>
        <div class="mini-grid">
          <label>Age <input name="age" value={meta('age')} /></label>
          <label>Height <input name="height" value={meta('height')} /></label>
          <label>Weight <input name="weight" value={meta('weight')} /></label>
          <label>Eyes <input name="eyes" value={meta('eyes')} /></label>
          <label>Skin <input name="skin" value={meta('skin')} /></label>
          <label>Hair <input name="hair" value={meta('hair')} /></label>
        </div>
        <label>Appearance <textarea name="appearanceNote">{notes.appearance ?? ''}</textarea></label>
      </section>

      <section class="panel stack">
        <h2>Backstory</h2>
        <label>Backstory <textarea name="backstoryNote">{notes.backstory ?? ''}</textarea></label>
        <label>Allies & Organizations <textarea name="alliesOrganizationsNote">{notes.allies_organizations ?? ''}</textarea></label>
        <label>Additional Notes <textarea name="additionalNotesNote">{notes.additional_notes ?? ''}</textarea></label>
      </section>
    </section>
  {/if}

  <div class="hidden-save-fields" aria-hidden="true">
    {#if activeTab !== 'battle'}
      <input name="hpCurrent" type="hidden" value={hp.currentValue} />
      <input name="hpMax" type="hidden" value={hp.maxValue} />
      <input name="tempHp" type="hidden" value={tempHp.currentValue} />
      <input name="inspiration" type="hidden" value={inspiration} />
      <input name="armorClass" type="hidden" value={meta('armorClass')} />
      <input name="initiative" type="hidden" value={meta('initiative')} />
      <input name="speed" type="hidden" value={meta('speed')} />
      <input name="hitDice" type="hidden" value={meta('hitDice')} />
      <input name="deathSaveSuccesses" type="hidden" value={deathSaveSuccesses} />
      <input name="deathSaveFailures" type="hidden" value={deathSaveFailures} />
      <input name="passivePerception" type="hidden" value={meta('passivePerception')} />
      {#each Object.entries(abilityScores) as [key, score]}
        <input name={`ability_${key}`} type="hidden" value={score} />
      {/each}
      <input name="attackName" type="hidden" value={attack.name} />
      <input name="attackAbility" type="hidden" value={attack.attackAbility} />
      {#if attack.proficient}<input name="attackProficient" type="hidden" value="on" />{/if}
      <input name="attackDamageDice" type="hidden" value={attack.damageDice} />
      <input name="attackNotes" type="hidden" value={attack.notes} />
      <input name="spellcastingAbility" type="hidden" value={meta('spellcastingAbility')} />
      <input name="spellSaveDc" type="hidden" value={meta('spellSaveDc')} />
      <input name="spellAttackBonus" type="hidden" value={meta('spellAttackBonus')} />
      <input name="spellcastingNote" type="hidden" value={notes.spellcasting ?? ''} />
      <input name="spellSlotsNote" type="hidden" value={notes.spell_slots ?? ''} />
      <input name="preparedSpellsNote" type="hidden" value={notes.prepared_spells ?? ''} />
      <input name="savingThrowsNote" type="hidden" value={notes.saving_throws ?? ''} />
      <input name="skillsNote" type="hidden" value={notes.skills ?? ''} />
      <input name="conditionsNote" type="hidden" value={notes.conditions ?? ''} />
      <input name="battleNotes" type="hidden" value={notes.battle_notes ?? ''} />
      <input name="attacksNote" type="hidden" value={notes.attacks ?? ''} />
    {/if}

    {#if activeTab !== 'traits'}
      <input name="classFeaturesNote" type="hidden" value={notes.class_features ?? ''} />
      <input name="featsNote" type="hidden" value={notes.feats ?? ''} />
      <input name="traitsNote" type="hidden" value={notes.traits ?? ''} />
      <input name="usableTraitsNote" type="hidden" value={notes.usable_traits ?? ''} />
      <input name="proficienciesLanguagesNote" type="hidden" value={notes.proficiencies_languages ?? ''} />
      <input name="limitedUsesNote" type="hidden" value={notes.limited_uses ?? ''} />
    {/if}

    {#if activeTab !== 'inventory'}
      <input name="inventoryName" type="hidden" value={inventory.name} />
      <input name="inventoryCategory" type="hidden" value={inventory.category} />
      <input name="inventoryQuantity" type="hidden" value={inventory.quantity} />
      <input name="inventoryAcBonus" type="hidden" value={inventory.acBonus} />
      {#if inventory.equipped}<input name="inventoryEquipped" type="hidden" value="on" />{/if}
      <input name="inventoryNotes" type="hidden" value={inventory.notes} />
      <input name="currencyCp" type="hidden" value={meta('currencyCp')} />
      <input name="currencySp" type="hidden" value={meta('currencySp')} />
      <input name="currencyEp" type="hidden" value={meta('currencyEp')} />
      <input name="currencyGp" type="hidden" value={meta('currencyGp')} />
      <input name="currencyPp" type="hidden" value={meta('currencyPp')} />
      <input name="treasureNote" type="hidden" value={notes.treasure ?? ''} />
      <input name="generalInventoryNote" type="hidden" value={notes.general_inventory ?? ''} />
    {/if}

    {#if activeTab !== 'character'}
      <input name="name" type="hidden" value={character.name} />
      <input name="className" type="hidden" value={classes.className} />
      <input name="level" type="hidden" value={classes.level} />
      <input name="ancestry" type="hidden" value={character.ancestry} />
      <input name="race" type="hidden" value={race} />
      <input name="background" type="hidden" value={character.background} />
      <input name="alignment" type="hidden" value={meta('alignment')} />
      <input name="playerName" type="hidden" value={meta('playerName')} />
      <input name="experiencePoints" type="hidden" value={meta('experiencePoints')} />
      <input name="personalityNote" type="hidden" value={notes.personality ?? ''} />
      <input name="idealsNote" type="hidden" value={notes.ideals ?? ''} />
      <input name="bondsNote" type="hidden" value={notes.bonds ?? ''} />
      <input name="flawsNote" type="hidden" value={notes.flaws ?? ''} />
      <input name="age" type="hidden" value={meta('age')} />
      <input name="height" type="hidden" value={meta('height')} />
      <input name="weight" type="hidden" value={meta('weight')} />
      <input name="eyes" type="hidden" value={meta('eyes')} />
      <input name="skin" type="hidden" value={meta('skin')} />
      <input name="hair" type="hidden" value={meta('hair')} />
      <input name="appearanceNote" type="hidden" value={notes.appearance ?? ''} />
      <input name="backstoryNote" type="hidden" value={notes.backstory ?? ''} />
      <input name="alliesOrganizationsNote" type="hidden" value={notes.allies_organizations ?? ''} />
      <input name="additionalNotesNote" type="hidden" value={notes.additional_notes ?? ''} />
    {/if}
  </div>

  {#if savingThrowsOpen}
    <div class="modal-backdrop" role="presentation">
      <div class="panel compact-modal" role="dialog" aria-modal="true" aria-labelledby="saving-throws-title">
        <div class="panel-head">
          <h2 id="saving-throws-title">Saving Throws</h2>
          <button type="button" class="text-button" onclick={() => (savingThrowsOpen = false)}>Close</button>
        </div>
        <div class="check-list">
          {#each abilityOrder as key}
            <div class="check-row">
              <strong>{key.toUpperCase()}</strong>
              <span>{signed(abilityModifier(abilityScores[key]))}</span>
            </div>
          {/each}
        </div>
      </div>
    </div>
  {/if}

  {#if skillChecksOpen}
    <div class="modal-backdrop" role="presentation">
      <div class="panel compact-modal" role="dialog" aria-modal="true" aria-labelledby="skill-checks-title">
        <div class="panel-head">
          <h2 id="skill-checks-title">Skill Checks</h2>
          <button type="button" class="text-button" onclick={() => (skillChecksOpen = false)}>Close</button>
        </div>
        <div class="check-list skill-list">
          {#each skillChecks as skill}
            <div class="check-row">
              <strong>{skill.name}</strong>
              <span>{skill.ability.toUpperCase()} {signed(abilityModifier(abilityScores[skill.ability]))}</span>
            </div>
          {/each}
        </div>
      </div>
    </div>
  {/if}
</form>
