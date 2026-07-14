<script lang="ts">
  import { deserialize, enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { untrack } from 'svelte';
  import { abilityMap, abilityModifier, armorClass, equippedAttackItems, equippedItems, hitDiceSummary, initiativeBonus, modifierTargetMatches, passiveScore, proficiencyBonus, resolveCritThreshold, resolveD20Outcomes, resolveDicePool, resolveExtraDiceRolls, resolvedAdditiveModifiers, resolvedNumericModifiers, rollD20Pool, speedFt, spellAttackBonus, spellSaveDc, totalLevel } from '$lib/rules/dnd5e';
  import type { AbilityKey, CharacterDetail, InventoryItem, ItemCategory } from '$lib/types/character';
  import type { ContentDefinition, ContentType } from '$lib/types/content';

  let {
    character,
    catalogue = [],
    itemCategories = [],
    result,
    isAdmin = false,
    onVersionHistory
  }: {
    character: CharacterDetail;
    catalogue?: ContentDefinition[];
    itemCategories?: ItemCategory[];
    result?: Record<string, unknown>;
    isAdmin?: boolean;
    onVersionHistory?: () => void;
  } = $props();

  let classRows = $state(untrack(() => character.classes.map((row) => ({ ...row }))));
  const classes = $derived(classRows[0] ?? { className: 'Fighter', level: 1 });
  const resources = $derived(Object.fromEntries(character.resources.map((resource) => [resource.key, resource])));
  const hp = $derived(resources.hp ?? { currentValue: 10, maxValue: 10 });
  const tempHp = $derived(resources.temp_hp ?? { currentValue: 0, maxValue: 0 });
  const inspiration = $derived(resources.inspiration?.currentValue ?? 0);
  const abilityScores = $derived(abilityMap(character.abilities));
  const level = $derived(totalLevel(classRows));
  const prof = $derived(proficiencyBonus(level));
  const classHitDice = $derived(classRows.map((row, i) => ({
    className: row.className || 'Class',
    level: row.level,
    dieSize: parseInt(hitDieForRow(row)) || 8,
    remaining: character.resources.find((r) => r.key === `hit_dice_${i}`)?.currentValue ?? row.level
  })));
  const hitDiceDisplay = $derived(
    classHitDice.map((c) => `${c.remaining}d${c.dieSize}`).join(' + ') || '-'
  );
  const hitDiceRemainingTotal = $derived(classHitDice.reduce((s, c) => s + c.remaining, 0));
  let hitDiceCount = $state(1);
  let hitDiceClassIndex = $state(0);
  const metadata = $derived(character.metadata ?? {});
  const race = $derived(String(character.metadata?.race ?? ''));
  const d20Icon = '/images/dice-twenty-faces-one-svgrepo-com.svg';
  const emptyInventoryItem = {
    name: '',
    category: 'gear',
    location: 'backpack' as const,
    quantity: 1,
    equipped: false,
    isEquipment: false,
    acBonus: 0,
    toHitBonus: 0,
    damageBonus: 0,
    attackAbility: 'str' as AbilityKey,
    proficient: true,
    damageRolls: '',
    effects: '',
    abilityBonuses: {},
    notes: ''
  };
  const categoryOptions = $derived(itemCategories.length ? itemCategories : [
    { key: 'weapon', label: 'Weapon' },
    { key: 'armor', label: 'Armor' },
    { key: 'shield', label: 'Shield' },
    { key: 'focus', label: 'Spell Focus' },
    { key: 'consumable', label: 'Consumable' },
    { key: 'tool', label: 'Tool' },
    { key: 'gear', label: 'Adventuring Gear' },
    { key: 'treasure', label: 'Treasure' },
    { key: 'junk', label: 'Junk' },
    { key: 'misc', label: 'Misc' }
  ]);
  const inventoryRows = $derived(character.inventory);
  const equippedInventoryRows = $derived(equippedItems(inventoryRows));
  const backpackInventoryRows = $derived(
    inventoryRows.filter((item) => item.location !== 'equipped' && item.location !== 'misc' && !item.equipped)
  );
  const miscInventoryRows = $derived(inventoryRows.filter((item) => item.location === 'misc'));
  const battleActionItems = $derived(equippedAttackItems(inventoryRows));
  const attack = $derived(character.attacks[0] ?? {
    name: '',
    attackAbility: 'str' as AbilityKey,
    proficient: true,
    damageDice: '',
    notes: ''
  });
  const notes = $derived(Object.fromEntries(character.notes.map((note) => [note.key, note.content])));
  const proficiencies = $derived(character.proficiencies ?? { savingThrows: [], skills: [], weapons: [] });

  let activeTab = $state<'battle' | 'traits' | 'inventory' | 'character'>('battle');
  let autosaveTimer: ReturnType<typeof setTimeout>;
  let autosaveStatus = $state('Ready');
  let lastAutosaveAt = 0;
  let deathSaveSuccesses = $state(0);
  let deathSaveFailures = $state(0);
  let savingThrowsOpen = $state(false);
  let skillChecksOpen = $state(false);
  let playerModificationsOpen = $state(false);
  let selectedEffectKeys = $state<string[]>([]);
  let selectedExhaustionLevel = $state(0);
  let selectedSavingThrowProficiencies = $state<AbilityKey[]>([]);
  let selectedSkillProficiencies = $state<string[]>([]);
  let selectedCatalogue = $state<Record<ContentType, string>>({ item: '', spell: '', feat: '', class_feature: '', condition: '', action: '' });
  let contentBusy = $state(false);
  let modifierSearch = $state('');
  let modifierFilter = $state<'active' | 'automated' | 'potential' | 'condition' | 'spell' | 'combat' | 'class_feature' | 'environment' | 'all'>('active');
  let newItemOpen = $state(false);
  let newItemLocation = $state<'equipped' | 'backpack' | 'misc'>('backpack');
  let simpleItemOpen = $state(false);
  let simpleItemLocation = $state<'equipped' | 'backpack' | 'misc'>('backpack');
  let simpleItemName = $state('');
  let simpleItemQuantity = $state(1);
  let simpleItemCategory = $state('gear');
  let simpleItemNotes = $state('');
  let rollResult = $state<{
    title: string;
    attack: string;
    damage: string[];
    effects: string;
  } | null>(null);
  let simpleRollResult = $state<{
    title: string;
    lines: Array<{ label: string; text: string; natural: number }>;
    passiveNote?: string;
  } | null>(null);
  let formulaHelp = $state<{
    title: string;
    lines: string[];
  } | null>(null);
  let inventoryMessage = $state<string | null>(null);
  const autosaveIntervalMs = 30_000;
  const modifierFilters = [
    { key: 'active', label: 'Active' },
    { key: 'automated', label: 'Automated' },
    { key: 'potential', label: 'Potential' },
    { key: 'condition', label: 'Conditions' },
    { key: 'spell', label: 'Spells' },
    { key: 'combat', label: 'Combat' },
    { key: 'class_feature', label: 'Class' },
    { key: 'environment', label: 'Environment' },
    { key: 'all', label: 'All' }
  ] as const;
  const abilityOrder: AbilityKey[] = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
  const skillChecks: Array<{ key: string; name: string; ability: AbilityKey }> = [
    { key: 'acrobatics', name: 'Acrobatics', ability: 'dex' },
    { key: 'animal_handling', name: 'Animal Handling', ability: 'wis' },
    { key: 'arcana', name: 'Arcana', ability: 'int' },
    { key: 'athletics', name: 'Athletics', ability: 'str' },
    { key: 'deception', name: 'Deception', ability: 'cha' },
    { key: 'history', name: 'History', ability: 'int' },
    { key: 'insight', name: 'Insight', ability: 'wis' },
    { key: 'intimidation', name: 'Intimidation', ability: 'cha' },
    { key: 'investigation', name: 'Investigation', ability: 'int' },
    { key: 'medicine', name: 'Medicine', ability: 'wis' },
    { key: 'nature', name: 'Nature', ability: 'int' },
    { key: 'perception', name: 'Perception', ability: 'wis' },
    { key: 'performance', name: 'Performance', ability: 'cha' },
    { key: 'persuasion', name: 'Persuasion', ability: 'cha' },
    { key: 'religion', name: 'Religion', ability: 'int' },
    { key: 'sleight_of_hand', name: 'Sleight of Hand', ability: 'dex' },
    { key: 'stealth', name: 'Stealth', ability: 'dex' },
    { key: 'survival', name: 'Survival', ability: 'wis' }
  ];

  function meta(field: string, fallback = '') {
    return String(metadata[field] ?? fallback);
  }

  const activeEffectDetails = $derived(
    character.availableEffects.filter((effect) => selectedEffectKeys.includes(effect.key))
  );
  const allActiveEffectDetails = $derived(character.activeEffects);
  const filteredModifierEffects = $derived(
    character.availableEffects.filter((effect) => {
      const query = modifierSearch.trim().toLowerCase();
      const matchesSearch = !query || [effect.name, effect.description, effect.sourceRef, effect.sourceType]
        .join(' ')
        .toLowerCase()
        .includes(query);
      const matchesFilter =
        (modifierFilter === 'all' && effect.isSelectable) ||
        (modifierFilter === 'active' && selectedEffectKeys.includes(effect.key)) ||
        (modifierFilter === 'automated' && effect.modifiers.length > 0) ||
        (modifierFilter === 'potential' && effect.modifiers.length === 0 && !effect.isSelectable) ||
        (modifierFilter === 'condition' && effect.isCondition && effect.isSelectable) ||
        (modifierFilter === 'spell' && effect.sourceType === 'spell' && effect.isSelectable) ||
        (modifierFilter === 'combat' && effect.sourceType === 'combat_state' && effect.isSelectable) ||
        (modifierFilter === 'class_feature' && effect.sourceType === 'class_feature' && effect.isSelectable) ||
        (modifierFilter === 'environment' && effect.sourceType === 'environment' && effect.isSelectable);

      return matchesSearch && matchesFilter;
    })
  );
  const visibleModifierEffects = $derived(filteredModifierEffects.slice(0, 50));
  const activeModifierFilterLabel = $derived(
    modifierFilters.find((filter) => filter.key === modifierFilter)?.label ?? 'Modifiers'
  );
  const equippedAcBonus = $derived(
    equippedInventoryRows.reduce((sum, item) => sum + (Number(item.acBonus) || 0), 0)
  );
  const acModifierBonuses = $derived(resolvedAdditiveModifiers(character.modifierSources, ['ac'], { classes: classRows }));
  const computedArmorClass = $derived(armorClass(abilityScores.dex, equippedAcBonus, character.modifierSources, { classes: classRows }));
  const initiativeModifierBonuses = $derived(resolvedAdditiveModifiers(character.modifierSources, ['initiative'], { classes: classRows }));
  const computedInitiative = $derived(initiativeBonus(abilityScores.dex, character.modifierSources, { classes: classRows }));
  const spellcastingAbility = $derived((classes.spellcastingAbility || meta('spellcastingAbility', 'int').toLowerCase()) as AbilityKey);
  const spellDcBonuses = $derived(resolvedAdditiveModifiers(character.modifierSources, ['spell_save_dc'], { classes: classRows }));
  const spellAttackBonuses = $derived(resolvedAdditiveModifiers(character.modifierSources, ['spell_attack_roll', 'attack_roll.spell'], { classes: classRows }));
  const computedSpellSaveDc = $derived(spellSaveDc(abilityScores[spellcastingAbility] ?? 10, level, spellDcBonuses.map((bonus) => bonus.value)));
  const computedSpellAttackBonus = $derived(spellAttackBonus(abilityScores[spellcastingAbility] ?? 10, level, spellAttackBonuses.map((bonus) => bonus.value)));
  const spellDcFormula = $derived([
    'Base: 8', `Proficiency: ${signed(prof)}`, `${spellcastingAbility.toUpperCase()} modifier: ${signed(abilityModifier(abilityScores[spellcastingAbility] ?? 10))}`,
    ...spellDcBonuses.map((bonus) => `${bonus.label}: ${signed(bonus.value)}`), `Total: ${computedSpellSaveDc}`
  ]);
  const characterSpells = $derived(character.content.filter((entry) => entry.type === 'spell'));
  const characterFeats = $derived(character.content.filter((entry) => entry.type === 'feat'));
  const characterFeatures = $derived(character.content.filter((entry) => entry.type === 'class_feature'));
  const computedSpeedValue = $derived(speedFt(character.modifierSources, { classes: classRows }));
  const computedSpeed = $derived(`${computedSpeedValue} ft.`);
  const computedHitDice = $derived(hitDiceSummary(classRows));
  const passivePerceptionBonuses = $derived(resolvedAdditiveModifiers(character.modifierSources, ['ability_check.perception', 'passive.perception'], { classes: classRows }));
  const computedPassivePerception = $derived(
    passiveScore(abilityScores.wis, isSkillProficient('perception'), prof, character.modifierSources, ['ability_check.perception', 'passive.perception'], { classes: classRows })
  );
  const passiveInsightBonuses = $derived(resolvedAdditiveModifiers(character.modifierSources, ['ability_check.insight', 'passive.insight'], { classes: classRows }));
  const computedPassiveInsight = $derived(
    passiveScore(abilityScores.wis, isSkillProficient('insight'), prof, character.modifierSources, ['ability_check.insight', 'passive.insight'], { classes: classRows })
  );
  const passiveInvestigationBonuses = $derived(resolvedAdditiveModifiers(character.modifierSources, ['ability_check.investigation', 'passive.investigation'], { classes: classRows }));
  const computedPassiveInvestigation = $derived(
    passiveScore(abilityScores.int, isSkillProficient('investigation'), prof, character.modifierSources, ['ability_check.investigation', 'passive.investigation'], { classes: classRows })
  );
  const savingThrowModifierBonuses = $derived(
    Object.fromEntries(abilityOrder.map((key) => [key, resolvedAdditiveModifiers(character.modifierSources, [`saving_throw.${key}`], { classes: classRows })])) as Record<AbilityKey, import('$lib/rules/dnd5e').ResolvedBonus[]>
  );
  const skillCheckModifierBonuses = $derived(
    Object.fromEntries(skillChecks.map((skill) => [skill.key, resolvedAdditiveModifiers(character.modifierSources, [`ability_check.${skill.ability}`, `ability_check.${skill.key}`], { classes: classRows })])) as Record<string, import('$lib/rules/dnd5e').ResolvedBonus[]>
  );
  const combatFormulaHelp = $derived.by(() => {
    const dexMod = abilityModifier(abilityScores.dex);
    const wisMod = abilityModifier(abilityScores.wis);
    const speedSetValues = resolvedNumericModifiers(character.modifierSources, ['speed.all', 'speed.walk'], ['set'], { classes: classRows });
    const speedBonuses = resolvedAdditiveModifiers(character.modifierSources, ['speed.all', 'speed.walk'], { classes: classRows });
    const speedMultipliers = resolvedNumericModifiers(character.modifierSources, ['speed.all', 'speed.walk'], ['multiplier'], { classes: classRows });
    const speedBase = speedSetValues.length ? speedSetValues.at(-1)?.value ?? 30 : 30;

    return {
      proficiency: [`Total level: ${level}`, `Formula: 2 + floor((level - 1) / 4)`, `Result: ${signed(prof)}`],
      armorClass: [
        'Base: 10',
        `DEX modifier: ${signed(dexMod)}`,
        `Equipped item AC bonuses: ${signed(equippedAcBonus)}`,
        ...acModifierBonuses.map((bonus) => `${bonus.label}: ${signed(bonus.value)}`),
        `Total: ${computedArmorClass}`
      ],
      hitDice: [
        ...classRows.map((row) => `${row.className || 'Class'} ${row.level}: ${row.level}d${row.className ? hitDiceSummary([row]).split('d')[1] || '8' : '8'}`),
        `Total: ${computedHitDice || 'None'}`
      ],
      passivePerception: [
        'Base: 10',
        `WIS modifier: ${signed(wisMod)}`,
        `Perception proficiency: ${isSkillProficient('perception') ? signed(prof) : '+0'}`,
        ...passivePerceptionBonuses.map((bonus) => `${bonus.label}: ${signed(bonus.value)}`),
        `Total: ${computedPassivePerception}`
      ],
      passiveInsight: [
        'Base: 10',
        `WIS modifier: ${signed(wisMod)}`,
        `Insight proficiency: ${isSkillProficient('insight') ? signed(prof) : '+0'}`,
        ...passiveInsightBonuses.map((bonus) => `${bonus.label}: ${signed(bonus.value)}`),
        `Total: ${computedPassiveInsight}`
      ],
      passiveInvestigation: [
        'Base: 10',
        `INT modifier: ${signed(abilityModifier(abilityScores.int))}`,
        `Investigation proficiency: ${isSkillProficient('investigation') ? signed(prof) : '+0'}`,
        ...passiveInvestigationBonuses.map((bonus) => `${bonus.label}: ${signed(bonus.value)}`),
        `Total: ${computedPassiveInvestigation}`
      ],
      initiative: [
        `DEX modifier: ${signed(dexMod)}`,
        ...initiativeModifierBonuses.map((bonus) => `${bonus.label}: ${signed(bonus.value)}`),
        `Total: ${signed(computedInitiative)}`
      ],
      speed: [
        speedSetValues.length ? `Base set by effect: ${speedBase} ft.` : 'Base walking speed: 30 ft.',
        ...speedBonuses.map((bonus) => `${bonus.label}: ${signed(bonus.value)} ft.`),
        ...speedMultipliers.map((bonus) => `${bonus.label}: x${bonus.value}`),
        `Total: ${computedSpeed}`
      ]
    };
  });

  function openFormulaHelp(title: string, lines: string[]) {
    formulaHelp = { title, lines };
  }

  function helpTitle(lines: string[]) {
    return lines.join('\n');
  }

  function formulaHelpButton(title: string, lines: string[]) {
    return {
      title: helpTitle(lines),
      ariaLabel: `${title} formula breakdown`
    };
  }

  function hitDieForRow(row: { className: string; level: number }) {
    const summary = hitDiceSummary([row]);
    return summary.includes('d') ? summary.split('d')[1] : '8';
  }

  const hitDiceFormulaLines = $derived(
    [
      ...classHitDice.map((c) => `${c.className} ${c.level}: ${c.remaining}/${c.level}d${c.dieSize}`),
      `Total: ${hitDiceRemainingTotal} / ${level}`
    ]
  );

  function isEffectSelected(key: string) {
    return selectedEffectKeys.includes(key);
  }

  function toggleEffect(key: string) {
    selectedEffectKeys = isEffectSelected(key)
      ? selectedEffectKeys.filter((selected) => selected !== key)
      : [...selectedEffectKeys, key];
  }

  function categoryOptionsFor(category: string) {
    if (!category || categoryOptions.some((option) => option.key === category)) return categoryOptions;
    return [...categoryOptions, { key: category, label: category }];
  }

  function openNewItem(location: 'equipped' | 'backpack' | 'misc') {
    if (!isAdmin) {
      simpleItemLocation = location;
      simpleItemCategory = location === 'misc' ? 'misc' : 'gear';
      simpleItemOpen = true;
    } else {
      newItemLocation = location;
      newItemOpen = true;
    }
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

  $effect(() => {
    selectedEffectKeys = character.activeEffects.filter((effect) => !effect.id.startsWith('content:') && !effect.id.startsWith('item:')).map((effect) => effect.effectKey);
    selectedExhaustionLevel = character.exhaustionLevel ?? 0;
    selectedSavingThrowProficiencies = [...proficiencies.savingThrows];
    selectedSkillProficiencies = [...proficiencies.skills];
  });

  function signed(value: number) {
    return value >= 0 ? `+${value}` : String(value);
  }

  function setSiblingHiddenBoolean(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const hidden = input.closest('label')?.querySelector<HTMLInputElement>('input[type="hidden"]');
    if (hidden) hidden.value = input.checked ? 'true' : 'false';
  }

  function isSavingThrowProficient(key: AbilityKey) {
    return selectedSavingThrowProficiencies.includes(key);
  }

  function isSkillProficient(key: string) {
    return selectedSkillProficiencies.includes(key);
  }

  function toggleSavingThrowProficiency(key: AbilityKey) {
    selectedSavingThrowProficiencies = isSavingThrowProficient(key)
      ? selectedSavingThrowProficiencies.filter((value) => value !== key)
      : [...selectedSavingThrowProficiencies, key];
  }

  function toggleSkillProficiency(key: string) {
    selectedSkillProficiencies = isSkillProficient(key)
      ? selectedSkillProficiencies.filter((value) => value !== key)
      : [...selectedSkillProficiencies, key];
  }

  function savingThrowTotal(key: AbilityKey) {
    const bonuses = savingThrowModifierBonuses[key] ?? [];
    return abilityModifier(abilityScores[key]) + (isSavingThrowProficient(key) ? prof : 0) + bonuses.reduce((sum, b) => sum + b.value, 0);
  }

  function savingThrowFormula(key: AbilityKey): string[] {
    const bonuses = savingThrowModifierBonuses[key] ?? [];
    return [
      `${key.toUpperCase()} modifier: ${signed(abilityModifier(abilityScores[key]))}`,
      ...(isSavingThrowProficient(key) ? [`Proficiency: ${signed(prof)}`] : []),
      ...bonuses.map((b) => `${b.label}: ${signed(b.value)}`),
      `Total: ${signed(savingThrowTotal(key))}`
    ];
  }

  function skillCheckTotal(skill: { key: string; ability: AbilityKey }) {
    const bonuses = skillCheckModifierBonuses[skill.key] ?? [];
    return abilityModifier(abilityScores[skill.ability]) + (isSkillProficient(skill.key) ? prof : 0) + bonuses.reduce((sum, b) => sum + b.value, 0);
  }

  function skillCheckFormula(skill: { key: string; ability: AbilityKey; name: string }): string[] {
    const bonuses = skillCheckModifierBonuses[skill.key] ?? [];
    return [
      `${skill.ability.toUpperCase()} modifier: ${signed(abilityModifier(abilityScores[skill.ability]))}`,
      ...(isSkillProficient(skill.key) ? [`Proficiency: ${signed(prof)}`] : []),
      ...bonuses.map((b) => `${b.label}: ${signed(b.value)}`),
      `Total: ${signed(skillCheckTotal(skill))}`
    ];
  }

  function rollText(modifier: number, candidates: string[] = [], modifierBreakdown: Array<{ label: string; value: number }> = []) {
    const relevant = character.modifierSources.flatMap((effect) => effect.modifiers.map((entry) => ({ effect: effect.name, entry })))
      .filter(({ entry }) => modifierTargetMatches(entry.target, candidates));

    // modifier-primacy.md §3.3 - count advantage/disadvantage sources per bucket (don't just
    // detect presence), net them, and roll a 1+|net|-size d20 pool in the net's direction.
    const advantageSources = relevant.filter(({ entry }) => entry.modifierType === 'advantage').map(({ effect }) => effect);
    const disadvantageSources = relevant.filter(({ entry }) => entry.modifierType === 'disadvantage').map(({ effect }) => effect);
    const pool = resolveDicePool(advantageSources.length, disadvantageSources.length);
    const { rolls, chosen: d20 } = rollD20Pool(pool.poolSize, pool.direction, rollDie);

    const flat = relevant.reduce((sum, { entry }) => {
      const value = Number(entry.valueExpression) || 0;
      return sum + (entry.modifierType === 'bonus' ? value : entry.modifierType === 'penalty' ? -value : 0);
    }, 0);
    const extraDice = resolveExtraDiceRolls(character.modifierSources, candidates, {}, rollDie);
    const extraTotal = extraDice.reduce((sum, die) => sum + die.value, 0);
    const total = d20 + modifier + flat + extraTotal;

    // Source-attributed audit trail per modifier-primacy.md §2.6: name which effects granted
    // advantage/disadvantage, show the net and pool size, and show every die actually rolled -
    // even when sources fully cancel, since "nothing changed" is itself worth showing why.
    const extras = extraDice.map((die) => `${die.label} ${die.expression} (${die.rolls.join(', ')})`).join(' + ');
    // §2.6 audit trail - when the caller supplies a labeled breakdown of the flat modifier (e.g.
    // Proficiency + ability mod), show its components instead of just the summed total.
    const breakdownText = modifierBreakdown.length ? ` (${modifierBreakdown.map((entry) => `${entry.label} ${entry.value}`).join(' + ')})` : '';
    const finalLine = `${d20} ${modifier + flat >= 0 ? '+' : '-'} ${Math.abs(modifier + flat)}${breakdownText}${extras ? ` + ${extras}` : ''} = ${total}`;

    let text: string;
    if (pool.advantageCount === 0 && pool.disadvantageCount === 0) {
      text = `d20 ${d20}\n${finalLine}`;
    } else {
      const directionLabel = pool.direction === 'highest' ? 'Advantage' : pool.direction === 'lowest' ? 'Disadvantage' : 'Normal';
      const sourceLines = [
        ...disadvantageSources.map((name) => `Disadvantage (${name})`),
        ...advantageSources.map((name) => `Advantage (${name})`)
      ];
      const rollLine = `Roll 1+${Math.abs(pool.net)} (${pool.advantageCount} Advantage - ${pool.disadvantageCount} Disadvantage) dice = ${pool.poolSize} dice at ${directionLabel}`;
      const rolledLine = `Rolled: ${rolls.join(', ')} - ${d20} wins`;
      text = [...sourceLines, '', rollLine, rolledLine, finalLine].join('\n');
    }

    return { text, natural: d20, total };
  }

  function rollAllSavingThrows() {
    simpleRollResult = {
      title: 'Saving Throws',
      lines: abilityOrder.map((key) => ({ label: `${key.toUpperCase()} Save`, ...rollText(savingThrowTotal(key), [`saving_throw.${key}`]) }))
    };
  }

  function rollAllSkillChecks() {
    simpleRollResult = {
      title: 'Skill Checks',
      lines: skillChecks.map((skill) => ({ label: skill.name, ...rollText(skillCheckTotal(skill), [`ability_check.${skill.ability}`, `ability_check.${skill.key}`]) }))
    };
  }

  function rollSingleSavingThrow(key: AbilityKey) {
    simpleRollResult = { title: `${key.toUpperCase()} Saving Throw`, lines: [{ label: `${key.toUpperCase()} Save`, ...rollText(savingThrowTotal(key), [`saving_throw.${key}`]) }] };
  }

  function rollSingleSkillCheck(skill: { key: string; ability: AbilityKey; name: string }) {
    const passiveScores: Record<string, number> = {
      perception: computedPassivePerception,
      insight: computedPassiveInsight,
      investigation: computedPassiveInvestigation
    };
    const passiveNote = skill.key in passiveScores
      ? `Your passive ${skill.name} is ${passiveScores[skill.key]}.`
      : undefined;
    simpleRollResult = {
      title: skill.name,
      lines: [{ label: skill.name, ...rollText(skillCheckTotal(skill), [`ability_check.${skill.ability}`, `ability_check.${skill.key}`]) }],
      passiveNote
    };
  }

  function rollAbilityCheck(key: AbilityKey) {
    simpleRollResult = { title: `${key.toUpperCase()} Ability Check`, lines: [{ label: `${key.toUpperCase()} Check`, ...rollText(abilityModifier(abilityScores[key]), [`ability_check.${key}`]) }] };
  }

  function rollInitiative() {
    simpleRollResult = { title: 'Initiative', lines: [{ label: 'Initiative', ...rollText(computedInitiative, ['initiative']) }] };
  }

  async function useHitDie() {
    const idx = Math.min(hitDiceClassIndex, classHitDice.length - 1);
    const hdc = classHitDice[idx];
    if (!hdc || hdc.remaining <= 0) return;
    const count = Math.min(Math.max(1, hitDiceCount), hdc.remaining);
    const rolls = Array.from({ length: count }, () => rollDie(hdc.dieSize));
    const totalRoll = rolls.reduce((sum, r) => sum + r, 0);
    const conMod = abilityModifier(abilityScores.con);
    const conTotal = conMod * count;
    const rolled = Math.max(1, totalRoll + conTotal);
    // Cap recovery by the actual HP headroom so the modal is honest
    const hpHeadroom = hp.maxValue - hp.currentValue;
    const hpGained = Math.min(rolled, Math.max(0, hpHeadroom));
    const classLabel = classHitDice.length > 1 ? ` (${hdc.className})` : '';
    const diceLabel = `${count}d${hdc.dieSize}${classLabel}`;
    const rollPart = count > 1 ? `[${rolls.join(', ')}] = ${totalRoll}` : `${rolls[0]}`;
    const conPart = conMod !== 0
      ? ` + ${count > 1 ? `${count}×` : ''}CON (${conMod >= 0 ? '+' : ''}${conMod}${count > 1 ? ` = ${conTotal >= 0 ? '+' : ''}${conTotal}` : ''}) = ${rolled}`
      : ` = ${rolled}`;
    const passiveNote = hpHeadroom <= 0
      ? `Already at full HP - hit ${count === 1 ? 'die' : 'dice'} spent.`
      : `Recovered ${hpGained} HP (${hp.currentValue} → ${hp.currentValue + hpGained}).`;
    simpleRollResult = {
      title: 'Use Hit Dice',
      lines: [{ label: diceLabel, text: `${rollPart}${conPart}`, natural: count === 1 ? rolls[0] : rolled }],
      passiveNote
    };
    const body = new FormData();
    body.set('classIndex', String(idx));
    body.set('spent', String(count));
    body.set('classLevel', String(hdc.level));
    body.set('hpGained', String(hpGained));
    const response = await fetch('?/spendHitDice', { method: 'POST', body });
    if (!response.ok) {
      simpleRollResult = { ...simpleRollResult!, passiveNote: `Roll recorded, but save failed (${response.status}) - refresh the page.` };
      return;
    }
    await invalidateAll();
  }

  async function runContentAction(action: string, values: Record<string, string | number | boolean> = {}) {
    contentBusy = true;
    const body = new FormData();
    for (const [key, value] of Object.entries(values)) body.set(key, String(value));
    const response = await fetch(`?/${action}`, { method: 'POST', body });
    contentBusy = false;
    if (response.ok) await invalidateAll();
    else inventoryMessage = `Could not update character content (${response.status}).`;
  }

  function addSelectedContent(type: ContentType) {
    const contentId = selectedCatalogue[type];
    if (contentId) void runContentAction('addContent', { contentId });
  }

  async function addSimpleItem() {
    const name = simpleItemName.trim();
    if (!name) return;
    await runContentAction('addInventoryItem', {
      name,
      quantity: simpleItemQuantity,
      category: simpleItemCategory,
      location: simpleItemLocation,
      notes: simpleItemNotes
    });
    simpleItemOpen = false;
    simpleItemName = '';
    simpleItemQuantity = 1;
    simpleItemCategory = 'gear';
    simpleItemLocation = 'backpack';
    simpleItemNotes = '';
  }

  function addClassRow() {
    classRows = [...classRows, { className: '', level: 1, subclassName: '', spellcastingAbility: null }];
  }

  function removeClassRow(index: number) {
    if (classRows.length > 1) classRows = classRows.filter((_, rowIndex) => rowIndex !== index);
  }

  function damageSummary(item: InventoryItem) {
    const rolls = item.damageRolls
      .split('+')
      .map((roll) => roll.trim())
      .filter(Boolean);
    const ability = abilityModifier(abilityScores[item.attackAbility]);
    const modifierBonuses = battleDamageBonuses(item).reduce((sum, bonus) => sum + bonus.value, 0);
    const flatBonus = Number(item.damageBonus || 0) + ability + modifierBonuses;
    let summary = rolls.join(' + ');
    if (flatBonus) {
      summary = summary ? `${summary} ${flatBonus > 0 ? '+' : '-'} ${Math.abs(flatBonus)}` : String(flatBonus);
    }
    return summary || 'No damage';
  }

  function rollDie(sides: number) {
    return Math.floor(Math.random() * sides) + 1;
  }

  function rollDamageExpression(
    expression: string,
    bonus: number,
    abilityBonus = 0,
    abilityLabel = '',
    modifierBonuses: Array<{ label: string; value: number }> = [],
    extraDice: ReturnType<typeof resolveExtraDiceRolls> = []
  ) {
    const parts = expression
      .split('+')
      .map((part) => part.trim())
      .filter(Boolean);
    const lines: string[] = [];
    let total = 0;

    for (const part of parts) {
      const dice = part.match(/^(\d*)d(\d+)$/i);
      if (dice) {
        const count = Math.max(1, Number(dice[1]) || 1);
        const sides = Math.max(1, Number(dice[2]) || 1);
        const rolls = Array.from({ length: count }, () => rollDie(sides));
        const subtotal = rolls.reduce((sum, roll) => sum + roll, 0);
        total += subtotal;
        lines.push(`${part}: ${rolls.join(', ')} = ${total}`);
        continue;
      }

      const flat = Number(part);
      if (Number.isFinite(flat)) {
        total += flat;
        lines.push(`${flat >= 0 ? '+' : '-'}${Math.abs(flat)} = ${total}`);
      }
    }

    // modifier-primacy.md §2.1/§6.3 - a Container's own attached 'extra_die' Modifiers (e.g. its
    // base weapon damage die, sourced from the Modifier system rather than the legacy flat
    // expression above) get their own attributed line, same as any other modifier-granted die.
    for (const die of extraDice) {
      total += die.value;
      lines.push(`${die.label}: ${die.expression} (${die.rolls.join(', ')}) = ${total}`);
    }

    if (bonus) {
      total += bonus;
      lines.push(`Weapon: ${signed(bonus)} = ${total}`);
    }

    if (abilityBonus) {
      total += abilityBonus;
      lines.push(`${abilityLabel} Modifier: ${signed(abilityBonus)} = ${total}`);
    }

    for (const modifierBonus of modifierBonuses) {
      total += modifierBonus.value;
      lines.push(`${modifierBonus.label}: ${signed(modifierBonus.value)} = ${total}`);
    }

    lines.push(`Total: ${total}`);

    return {
      total,
      lines: lines.length ? lines : ['No damage dice', 'Total: 0']
    };
  }

  function damageCandidatesFor(item: InventoryItem) {
    const canBeMeleeWeaponAttack = ['weapon', 'shield'].includes(item.category) && item.attackAbility === 'str';
    return [
      'damage_roll.all',
      'damage_roll.weapon',
      item.attackAbility ? `damage_roll.weapon.${item.attackAbility}` : '',
      canBeMeleeWeaponAttack ? 'damage_roll.melee_weapon' : '',
      canBeMeleeWeaponAttack ? `damage_roll.melee_weapon.${item.attackAbility}` : ''
    ].filter(Boolean);
  }

  function battleDamageBonuses(item: InventoryItem, outcomes: string[] = []) {
    const candidates = damageCandidatesFor(item);
    const context = {
      classes: classRows,
      attackType: 'melee_weapon',
      ability: item.attackAbility,
      outcomes
    } as const;
    return [
      ...resolvedNumericModifiers(character.modifierSources, candidates, ['bonus'], context),
      ...resolvedNumericModifiers(character.modifierSources, candidates, ['penalty'], context).map((penalty) => ({ ...penalty, value: -penalty.value }))
    ];
  }

  function rollBattleAction(item: InventoryItem) {
    const ability = abilityModifier(abilityScores[item.attackAbility]);
    const attackBreakdown = [
      ...(item.proficient ? [{ label: 'Proficiency', value: prof }] : []),
      { label: `${item.attackAbility.toUpperCase()} Mod`, value: ability },
      ...(Number(item.toHitBonus) ? [{ label: 'Weapon', value: Number(item.toHitBonus) }] : [])
    ];
    const attackBonus = attackBreakdown.reduce((sum, entry) => sum + entry.value, 0);
    const attackCandidates = ['attack_roll.weapon', `attack_roll.weapon.${item.attackAbility}`,
      item.category === 'weapon' ? 'attack_roll.melee_weapon' : '',
      item.category === 'weapon' ? `attack_roll.melee_weapon.${item.attackAbility}` : ''].filter(Boolean);

    // Phase 1 (modifier-primacy.md §6.4) - resolve the triggering (to-hit) roll first.
    const attackRoll = rollText(attackBonus, attackCandidates, attackBreakdown);

    // Phase 1 -> 2 handoff: turn the to-hit result into the named outcomes it satisfied, before
    // deciding which damage Modifiers (e.g. a crit-only bonus) are active for this roll.
    const critThreshold = resolveCritThreshold(character.modifierSources, { ability: item.attackAbility, attackType: 'melee_weapon' });
    const outcomes = resolveD20Outcomes(attackRoll.natural, critThreshold);

    // Phase 2 - resolve the dependent (damage) roll using the now-known outcome set.
    const damageCandidates = damageCandidatesFor(item);
    const damageContext = { classes: classRows, attackType: 'melee_weapon', ability: item.attackAbility, outcomes } as const;
    const extraDice = resolveExtraDiceRolls(character.modifierSources, damageCandidates, damageContext, rollDie);
    const damage = rollDamageExpression(item.damageRolls, Number(item.damageBonus || 0), ability, item.attackAbility.toUpperCase(), battleDamageBonuses(item, outcomes), extraDice);

    rollResult = {
      title: item.name || 'Battle Action',
      attack: `${attackRoll.text} (beats AC ${attackRoll.total} or below)${outcomes.length ? ` - ${outcomes.join(', ')}` : ''}`,
      damage: damage.lines,
      effects: item.effects || item.notes || '-'
    };
  }

  function findInventoryRow(event: MouseEvent) {
    return (event.currentTarget as HTMLElement).closest<HTMLElement>('.inventory-row, .new-item-grid');
  }

  function setInventoryQuantity(event: MouseEvent, quantity: number) {
    const input = findInventoryRow(event)?.querySelector<HTMLInputElement>('input[name="inventoryQuantity"]');
    if (!input) return;
    input.value = String(Math.max(0, quantity));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function adjustInventoryQuantity(event: MouseEvent, delta: number) {
    const input = findInventoryRow(event)?.querySelector<HTMLInputElement>('input[name="inventoryQuantity"]');
    if (!input) return;
    const next = Math.max(0, (Number(input.value) || 0) + delta);
    input.value = String(next);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function useInventoryItem(event: MouseEvent) {
    const row = findInventoryRow(event);
    const name = row?.querySelector<HTMLInputElement>('input[name="inventoryName"]')?.value || 'Item';
    const damageRolls = row?.querySelector<HTMLInputElement>('input[name="inventoryDamageRolls"]')?.value || '';
    const damageBonus = Number(row?.querySelector<HTMLInputElement>('input[name="inventoryDamageBonus"]')?.value) || 0;
    const attackAbility = (row?.querySelector<HTMLInputElement | HTMLSelectElement>('input[name="inventoryAttackAbility"], select[name="inventoryAttackAbility"]')?.value || 'str') as AbilityKey;
    const ability = abilityModifier(abilityScores[attackAbility]);
    const effects = row?.querySelector<HTMLInputElement>('input[name="inventoryEffects"]')?.value || '';
    const inventoryId = row?.querySelector<HTMLInputElement>('input[name="inventoryId"]')?.value || '';
    const sourceContentId = row?.querySelector<HTMLInputElement>('input[name="inventorySourceContentId"]')?.value || '';
    const roll = damageRolls ? rollDamageExpression(damageRolls, damageBonus, ability, attackAbility.toUpperCase()) : null;
    if (inventoryId && sourceContentId) {
      void useCatalogueInventoryItem(inventoryId, name);
      return;
    }
    adjustInventoryQuantity(event, -1);
    inventoryMessage = roll
      ? `${name} used. Quantity reduced by 1. Roll: ${roll.lines.join('; ')}${effects ? ` (${effects})` : ''}.`
      : `${name} used. Quantity reduced by 1.`;
  }

  async function useCatalogueInventoryItem(inventoryId:string,name:string){
    const body=new FormData();body.set('inventoryId',inventoryId);
    await runResourceAction('useItem',body,`${name} used. Quantity reduced by 1.`);
  }

  async function triggerContentResourceAction(instanceId:string,name:string){
    const body=new FormData();body.set('instanceId',instanceId);
    await runResourceAction('triggerContent',body,`${name} used.`);
  }

  async function castSpell(spell:any){
    const body=new FormData();
    if(spell.spellAccessId){body.set('spellAccessId',spell.spellAccessId);body.set('inventoryItemId',spell.inventoryItemId||'');}
    else body.set('instanceId',spell.id);
    await runResourceAction('castSpell',body,`${spell.name} cast.`);
  }

  async function runResourceAction(action:string,body:FormData,heading:string){
    const response=await fetch(`?/${action}`,{method:'POST',body});
    const actionResult=deserialize(await response.text());
    if(actionResult.type!=='success'){
      inventoryMessage='Could not apply the resource action.';
      return;
    }
    const results=((actionResult.data as {itemResult?:Array<{label:string;target:string;expression:string;rolled:number;before:number|null;after:number|null;detail?:string}>})?.itemResult)||[];
    const lines=[heading,...results.map(result=>
      result.before===null?`${result.label}: ${result.detail||`${result.expression} rolled ${result.rolled}`} (${result.target})`:
      `${result.label}: ${result.expression} rolled ${result.rolled}; ${result.target} ${result.before} -> ${result.after}`)];
    sessionStorage.setItem('inventory-use-result',lines.join('\n'));
    location.reload();
  }

  $effect(()=>{
    const message=sessionStorage.getItem('inventory-use-result');
    if(message){sessionStorage.removeItem('inventory-use-result');inventoryMessage=message;}
  });

  function removeInventoryItem(event: MouseEvent) {
    setInventoryQuantity(event, 0);
    (event.currentTarget as HTMLElement).closest('form')?.requestSubmit();
  }

  function toggleEquipped(event: MouseEvent, equipped: boolean) {
    const row = findInventoryRow(event);
    const form = (event.currentTarget as HTMLElement).closest('form');
    const location = row?.querySelector<HTMLInputElement>('input[name="inventoryLocation"]');
    const equippedInput = row?.querySelector<HTMLInputElement>('input[name="inventoryEquipped"]');
    const equipmentInput = row?.querySelector<HTMLInputElement>('input[name="inventoryIsEquipment"]');

    if (location) location.value = equipped ? 'equipped' : 'backpack';
    if (equippedInput) equippedInput.value = equipped ? 'true' : 'false';
    if (equipmentInput) equipmentInput.value = 'true';
    form?.requestSubmit();
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

  // Modals never stack in this UI, so closing whichever one is open is unambiguous.
  function closeOpenModal() {
    if (rollResult) { rollResult = null; return; }
    if (simpleRollResult) { simpleRollResult = null; return; }
    if (inventoryMessage) { inventoryMessage = null; return; }
    if (simpleItemOpen) { simpleItemOpen = false; return; }
    if (newItemOpen) { newItemOpen = false; return; }
    if (formulaHelp) { formulaHelp = null; return; }
    if (playerModificationsOpen) { playerModificationsOpen = false; return; }
    if (skillChecksOpen) { skillChecksOpen = false; return; }
    if (savingThrowsOpen) { savingThrowsOpen = false; return; }
  }

  function handleGlobalKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') closeOpenModal();
  }
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

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
    <div class="actions sheet-header-actions">
      <span class="save-state">Round {character.combatClock.roundNumber} / Turn {character.combatClock.turnNumber}</span>
      <button type="button" class="compact-button" disabled={contentBusy} onclick={() => runContentAction('advanceTurn')}>Next Turn</button>
      <button type="button" class="compact-button" disabled={contentBusy} onclick={() => runContentAction('advanceRound')}>Next Round</button>
      <div class="save-cluster">
        <div class="save-command-row">
          <button type="submit">Save</button>
          {#if onVersionHistory}
            <button type="button" class="text-button" onclick={onVersionHistory}>Version History</button>
          {/if}
        </div>
        <div class="save-status-row">
          <span class="save-state">{autosaveStatus}</span>
          {#if result?.saved}
            <span class="save-state good">Saved</span>
          {/if}
        </div>
      </div>
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
          <label class="hit-dice-label">
            <span class="field-label-with-help">
              Hit Dice
              <button type="button" class="formula-help-button" title={helpTitle(hitDiceFormulaLines)} aria-label="Hit Dice formula breakdown" onclick={() => openFormulaHelp('Hit Dice', hitDiceFormulaLines)}>?</button>
            </span>
            <span class="summary-input-roll">
              <input value={hitDiceDisplay} readonly title="{hitDiceRemainingTotal} / {level} remaining" />
              {#if classHitDice.length > 1}
                <select bind:value={hitDiceClassIndex} aria-label="Hit die type" class="hit-dice-class-select">
                  {#each classHitDice as hdc, i}
                    <option value={i} disabled={hdc.remaining <= 0}>{hdc.remaining}d{hdc.dieSize}</option>
                  {/each}
                </select>
              {/if}
              <input type="number" class="hit-dice-count-input" min="1" max={classHitDice[hitDiceClassIndex]?.remaining ?? 1} bind:value={hitDiceCount} aria-label="Number of hit dice to use" />
              <button type="button" class="compact-use-button" disabled={(classHitDice[hitDiceClassIndex]?.remaining ?? 0) <= 0} onclick={useHitDie}>Use</button>
            </span>
          </label>
        </section>

        <section class="panel stack compact-panel">
          <h2>Combat Summary</h2>
          <div class="combat-summary-grid">
            <label>
              <span class="field-label-with-help">
                Proficiency
                <button type="button" class="formula-help-button" title={helpTitle(combatFormulaHelp.proficiency)} aria-label="Proficiency formula breakdown" onclick={() => openFormulaHelp('Proficiency', combatFormulaHelp.proficiency)}>?</button>
              </span>
              <input type="text" value={`+${prof}`} readonly />
            </label>
            <label>
              <span class="field-label-with-help">
                Armor Class
                <button type="button" class="formula-help-button" title={helpTitle(combatFormulaHelp.armorClass)} aria-label="Armor Class formula breakdown" onclick={() => openFormulaHelp('Armor Class', combatFormulaHelp.armorClass)}>?</button>
              </span>
              <input name="armorClass" type="number" value={computedArmorClass} readonly />
            </label>
            <label class="combat-stat-pp">
              <span class="field-label-with-help">
                Passive Perception
                <button type="button" class="formula-help-button" title={helpTitle(combatFormulaHelp.passivePerception)} aria-label="Passive Perception formula breakdown" onclick={() => openFormulaHelp('Passive Perception', combatFormulaHelp.passivePerception)}>?</button>
              </span>
              <input name="passivePerception" type="number" value={computedPassivePerception} readonly />
            </label>
            <label class="initiative-control">
              <span class="field-label-with-help">
                Initiative
                <button type="button" class="formula-help-button" title={helpTitle(combatFormulaHelp.initiative)} aria-label="Initiative formula breakdown" onclick={() => openFormulaHelp('Initiative', combatFormulaHelp.initiative)}>?</button>
              </span>
              <span class="summary-input-roll">
                <input name="initiative" value={signed(computedInitiative)} readonly />
                <button type="button" class="dice-icon-button small" aria-label="Roll initiative" title="Roll initiative" onclick={rollInitiative}>
                  <img src={d20Icon} alt="" />
                </button>
              </span>
            </label>
            <label class="speed-control">
              <span class="field-label-with-help">
                Speed
                <button type="button" class="formula-help-button" title={helpTitle(combatFormulaHelp.speed)} aria-label="Speed formula breakdown" onclick={() => openFormulaHelp('Speed', combatFormulaHelp.speed)}>?</button>
              </span>
              <input name="speed" value={computedSpeed} readonly />
            </label>
            <label class="combat-stat-pi">
              <span class="field-label-with-help">
                Passive Insight
                <button type="button" class="formula-help-button" title={helpTitle(combatFormulaHelp.passiveInsight)} aria-label="Passive Insight formula breakdown" onclick={() => openFormulaHelp('Passive Insight', combatFormulaHelp.passiveInsight)}>?</button>
              </span>
              <input type="number" value={computedPassiveInsight} readonly />
            </label>
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
            <label class="combat-stat-piv">
              <span class="field-label-with-help">
                Passive Investigation
                <button type="button" class="formula-help-button" title={helpTitle(combatFormulaHelp.passiveInvestigation)} aria-label="Passive Investigation formula breakdown" onclick={() => openFormulaHelp('Passive Investigation', combatFormulaHelp.passiveInvestigation)}>?</button>
              </span>
              <input type="number" value={computedPassiveInvestigation} readonly />
            </label>
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
                  <span class="modifier-line">
                    Mod: {abilityModifier(abilityScores[key])}
                    <button type="button" class="dice-icon-button small" aria-label={`Roll ${key.toUpperCase()} ability check`} title={`Roll ${key.toUpperCase()} ability check`} onclick={() => rollAbilityCheck(key)}>
                      <img src={d20Icon} alt="" />
                    </button>
                  </span>
                </label>
              {/each}
            </div>
            <div class="ability-popup-links">
              <button type="button" class="text-button" onclick={() => (savingThrowsOpen = true)}>Saving Throws</button>
              <button type="button" class="text-button" onclick={() => (skillChecksOpen = true)}>Skill Checks</button>
            </div>
          </div>
        </section>

        <section class="panel stack compact-panel modifications-panel">
          <div class="panel-head compact-head">
            <h2>Player Modifications</h2>
            <button type="button" class="compact-button" onclick={() => (playerModificationsOpen = true)}>Manage</button>
          </div>
          <div class="mod-summary">
            <label>Exhaustion
              <input
                type="number"
                min="0"
                max="6"
                value={selectedExhaustionLevel}
                oninput={(event) => (selectedExhaustionLevel = Math.min(6, Math.max(0, Number(event.currentTarget.value) || 0)))}
              />
            </label>
            <div class="active-mods">
              {#each allActiveEffectDetails.slice(0, 5) as effect}
                <button
                  type="button"
                  class:condition-chip={effect.isCondition}
                  class="tooltip-chip"
                  data-tooltip={effect.description || effect.name}
                  aria-label={`${effect.name}: ${effect.description || 'No description available'}`}
                >
                  {effect.name}
                </button>
              {:else}
                <span class="muted">No active effects</span>
              {/each}
              {#if allActiveEffectDetails.length > 5}
                <span>+{allActiveEffectDetails.length - 5}</span>
              {/if}
            </div>
          </div>
        </section>
      </div>

      <div class="battle-main-row">
        <section class="panel stack">
          <h2>Battle Actions</h2>
          <p class="muted">Read-only actions from equipped inventory rows flagged as equipment or given combat values.</p>
          <div class="action-table">
            <div class="action-row header">
              <span>Item</span>
              <span>Ability</span>
              <span>To Hit</span>
              <span>Damage</span>
              <span>Effects</span>
              <span></span>
            </div>
            {#each battleActionItems as item}
              <div class="action-row">
                <span class="item-name">
                  {#if item.isEquipment}
                    <span class="item-kind-icon active" aria-hidden="true"></span>
                  {/if}
                  {item.name}
                </span>
                <span>{item.attackAbility.toUpperCase()}</span>
                <span>{signed(item.toHitBonus)}</span>
                <span>{damageSummary(item)}</span>
                <span>{item.notes || '-'}</span>
                <button type="button" class="compact-button dice-button" onclick={() => rollBattleAction(item)}>
                  <img src={d20Icon} alt="" />
                  Roll
                </button>
              </div>
            {:else}
              <p class="muted">No equipped combat items yet. Add one on the Inventory tab.</p>
            {/each}
          </div>
        </section>

        <section class="panel stack">
          <h2>Magic & Battle Notes</h2>
          <div class="mini-grid">
            <label>Spellcasting Ability <select name="spellcastingAbility" value={spellcastingAbility}>{#each abilityOrder as key}<option value={key}>{key.toUpperCase()}</option>{/each}</select></label>
            <label><span class="field-label-with-help">Spell Save DC<button type="button" class="formula-help-button" onclick={() => openFormulaHelp('Spell Save DC', spellDcFormula)}>?</button></span><input name="spellSaveDc" type="number" value={computedSpellSaveDc} readonly /></label>
            <label><span class="field-label-with-help">Spell Attack Bonus<button type="button" class="formula-help-button" onclick={() => openFormulaHelp('Spell Attack Bonus', [`Proficiency: ${signed(prof)}`, `${spellcastingAbility.toUpperCase()} modifier: ${signed(abilityModifier(abilityScores[spellcastingAbility] ?? 10))}`, ...spellAttackBonuses.map((bonus) => `${bonus.label}: ${signed(bonus.value)}`), `Total: ${signed(computedSpellAttackBonus)}`])}>?</button></span><input name="spellAttackBonus" value={signed(computedSpellAttackBonus)} readonly /></label>
          </div>
          <div class="structured-section">
            <div class="panel-head compact-head"><h3>Spell Slots</h3><div class="actions"><button type="button" class="compact-button" disabled={contentBusy} onclick={() => runContentAction('rest', { restType: 'short_rest' })}>Short Rest</button><button type="button" class="compact-button" disabled={contentBusy} onclick={() => runContentAction('rest', { restType: 'long_rest' })}>Long Rest</button></div></div>
            <div class="slot-grid">
              {#each character.spellSlots as slot}
                <div class="slot-counter"><strong>{slot.type === 'pact' ? 'Pact' : `Level ${slot.level}`}</strong><span>{slot.current} / {slot.max}</span><div><button type="button" onclick={() => runContentAction('spellSlot', { slotType: slot.type, slotLevel: slot.level, delta: -1 })}>-</button><button type="button" onclick={() => runContentAction('spellSlot', { slotType: slot.type, slotLevel: slot.level, delta: 1 })}>+</button></div></div>
              {:else}<span class="muted">No spell slots for the current classes.</span>{/each}
            </div>
          </div>
          <div class="structured-section">
            <div class="catalogue-add-row"><select bind:value={selectedCatalogue.spell}><option value="">Add a spell...</option>{#each catalogue.filter((entry) => entry.type === 'spell') as entry}<option value={entry.id}>{entry.name} (level {entry.spell?.level ?? 0})</option>{/each}</select><button type="button" disabled={!selectedCatalogue.spell || contentBusy} onclick={() => addSelectedContent('spell')}>Add</button>{#if isAdmin}<a class="compact-button" href="/catalogue?type=spell">Create Homebrew</a>{/if}</div>
            <div class="content-instance-list">
              {#each characterSpells as spell}
                <article class="content-instance-row"><div><strong>{spell.name}</strong><span class="muted">Level {spell.spellLevel ?? 0}{spell.grantedBy?` · granted by ${spell.grantedBy}`:''}</span></div><div class="actions"><button type="button" disabled={!spell.isPrepared} onclick={() => castSpell(spell)}>Cast</button>{#if spell.hasResourceActions}<button type="button" onclick={() => triggerContentResourceAction(spell.id,spell.name)}>Use Actions</button>{/if}{#if !spell.grantedBy}<button type="button" class:active={spell.isPrepared} onclick={() => runContentAction('contentState', { instanceId: spell.id, isKnown: true, isPrepared: !spell.isPrepared, isActive: spell.isActive, notes: spell.notes })}>{spell.isPrepared ? 'Prepared' : 'Prepare'}</button><button type="button" class:active={spell.isActive} onclick={() => runContentAction('contentState', { instanceId: spell.id, isKnown: true, isPrepared: spell.isPrepared, isActive: !spell.isActive, notes: spell.notes })}>{spell.isActive ? 'Effect Active' : 'Activate Effect'}</button><button type="button" class="danger" onclick={() => runContentAction('removeContent', { instanceId: spell.id })}>Remove</button>{/if}</div></article>
              {/each}
            </div>
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
    <section class="traits-layout">
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
    <section class="panel stack">
      <div class="panel-head"><h2>Structured Features</h2>{#if isAdmin}<a href="/catalogue">Create Homebrew</a>{/if}</div>
      {#each [['class_feature', 'Class Feature'], ['feat', 'Feat']] as option}
        <div class="catalogue-add-row">
          <select value={selectedCatalogue[option[0] as ContentType]} onchange={(event) => (selectedCatalogue[option[0] as ContentType] = event.currentTarget.value)}>
            <option value="">Add {option[1]}...</option>
            {#each catalogue.filter((entry) => entry.type === option[0]) as entry}<option value={entry.id}>{entry.name}</option>{/each}
          </select>
          <button type="button" disabled={!selectedCatalogue[option[0] as ContentType] || contentBusy} onclick={() => addSelectedContent(option[0] as ContentType)}>Add</button>
        </div>
      {/each}
      <div class="content-instance-list">
        {#each [...characterFeatures, ...characterFeats] as entry}
          <article class="content-instance-card">
            <div class="panel-head compact-head"><div><span class="eyebrow">{entry.type.replace('_', ' ')}{entry.grantedBy ? ` / granted by ${entry.grantedBy}` : ''}</span><h3>{entry.name}</h3></div>{#if !entry.grantedBy}<button type="button" class="danger compact-button" onclick={() => runContentAction('removeContent', { instanceId: entry.id })}>Remove</button>{/if}</div>
            <p>{entry.description}</p>
            {#if entry.hasResourceActions}<button type="button" class="compact-button" onclick={() => triggerContentResourceAction(entry.id,entry.name)}>Use Actions</button>{/if}
            {#each entry.resources as resource}
              <div class="resource-counter"><span>{resource.label}</span><strong>{resource.currentValue} / {resource.maxValue}</strong><div><button type="button" onclick={() => runContentAction('contentResource', { resourceId: resource.id, delta: -1 })}>-</button><button type="button" onclick={() => runContentAction('contentResource', { resourceId: resource.id, delta: 1 })}>+</button></div><small>{resource.rechargePeriod.replace('_', ' ')}</small></div>
            {/each}
          </article>
        {:else}<p class="muted">No structured feats or class features added yet.</p>{/each}
      </div>
    </section>
    </section>
  {/if}

  {#if activeTab === 'inventory'}
    <section class="panel catalogue-add-panel">
      <div><h2>Item Catalogue</h2><p class="muted">Add an SRD or private homebrew item, or continue using free-form entries.</p></div>
      <div class="catalogue-add-row"><select bind:value={selectedCatalogue.item}><option value="">Choose an item...</option>{#each catalogue.filter((entry) => entry.type === 'item') as entry}<option value={entry.id}>{entry.name}</option>{/each}</select><button type="button" disabled={!selectedCatalogue.item || contentBusy} onclick={() => addSelectedContent('item')}>Add Item</button>{#if isAdmin}<a class="compact-button" href="/catalogue?type=item">Create Homebrew</a>{:else}<button type="button" class="compact-button" onclick={() => (simpleItemOpen = true)}>Quick Add</button>{/if}</div>
    </section>
    <section class="inventory-layout">
      <section class="panel stack inventory-section">
        <div class="panel-head compact-head">
          <h2>Equipment</h2>
          <button type="button" class="compact-button" onclick={() => openNewItem('equipped')}>Add Item</button>
        </div>
        <p class="muted">Items here can become read-only Battle Actions when marked as equipment or given attack values.</p>
        <div class="inventory-table equipped-table">
          {#each equippedInventoryRows as item, index (item.id ?? `equipment-${item.name}-${index}`)}
            <div class="inventory-row equipped-row">
              <input name="inventoryId" type="hidden" value={item.id || ''} />
              <input name="inventorySourceContentId" type="hidden" value={item.sourceContentId || ''} />
              <div class="inventory-row-main">
                <label>Item <input name="inventoryName" value={item.name} placeholder="Longsword" /></label>
                <label>Category
                  <select name="inventoryCategory">
                    {#each categoryOptionsFor(item.category) as category}
                      <option value={category.key} selected={item.category === category.key}>{category.label}</option>
                    {/each}
                  </select>
                </label>
                <div class="qty-equipment-control">
                  <label class="qty-label">Quantity
                    <span class="qty-control">
                      <button type="button" class="qty-button" onclick={(event) => adjustInventoryQuantity(event, -1)}>-</button>
                      <input name="inventoryQuantity" type="number" min="0" value={item.quantity} />
                      <button type="button" class="qty-button" onclick={(event) => adjustInventoryQuantity(event, 1)}>+</button>
                    </span>
                  </label>
                  <button type="button" class="equipment-toggle active" aria-label="Move to backpack" title="Move to backpack" onclick={(event) => toggleEquipped(event, false)}>
                    <span class="item-kind-icon active" aria-hidden="true"></span>
                  </button>
                </div>
              </div>
              <div class="inventory-row-combat">
                <label class="tiny-field">AC <input name="inventoryAcBonus" type="number" value={item.acBonus} /></label>
                <label class="tiny-field">To Hit <input name="inventoryToHitBonus" type="number" value={item.toHitBonus} /></label>
                <label class="tiny-field">Damage Bonus <input name="inventoryDamageBonus" type="number" value={item.damageBonus} /></label>
                <label>Ability
                  <select name="inventoryAttackAbility">
                    {#each abilityOrder as ability}
                      <option value={ability} selected={item.attackAbility === ability}>{ability.toUpperCase()}</option>
                    {/each}
                  </select>
                </label>
                <label class="inline compact-check">
                  <input name="inventoryProficient" type="hidden" value={item.proficient ? 'true' : 'false'} />
                  <input type="checkbox" checked={item.proficient} onchange={setSiblingHiddenBoolean} />
                  Proficient
                </label>
                <label class="inline compact-check">
                  <input name="inventoryAttuned" type="hidden" value={item.attuned ? 'true' : 'false'} />
                  <input type="checkbox" checked={item.attuned} onchange={setSiblingHiddenBoolean} /> Attuned
                </label>
                <label>Damage Rolls <input name="inventoryDamageRolls" value={item.damageRolls} placeholder="1d8 + 1d4 + 1d6" /></label>
                <label>Effects <input name="inventoryEffects" value={item.effects} placeholder="fire, poison, prone" /></label>
                <label>Notes <input name="inventoryNotes" value={item.notes} /></label>
              </div>
              <input name="inventoryLocation" type="hidden" value="equipped" />
              <input name="inventoryIsEquipment" type="hidden" value="true" />
              <input name="inventoryEquipped" type="hidden" value="true" />
              {#if item.resources?.length}<div class="inventory-item-resources">{#each item.resources as resource}<div class="resource-counter"><span>{resource.label}</span><strong>{resource.currentValue} / {resource.maxValue}</strong><div><button type="button" onclick={() => runContentAction('inventoryResource',{resourceId:resource.id,delta:-1})}>-</button><button type="button" onclick={() => runContentAction('inventoryResource',{resourceId:resource.id,delta:1})}>+</button></div></div>{/each}</div>{/if}
            </div>
          {:else}
            <p class="muted">No equipment yet.</p>
          {/each}
        </div>
      </section>

      <section class="panel stack inventory-section">
        <div class="panel-head compact-head">
          <h2>Backpack</h2>
          <button type="button" class="compact-button" onclick={() => openNewItem('backpack')}>Add Item</button>
        </div>
        <div class="inventory-table backpack-table">
          {#each backpackInventoryRows as item, index (item.id ?? `backpack-${item.name}-${index}`)}
            <div class="inventory-row simple">
              <input name="inventoryId" type="hidden" value={item.id || ''} />
              <input name="inventorySourceContentId" type="hidden" value={item.sourceContentId || ''} />
              <input name="inventoryAttuned" type="hidden" value={item.attuned ? 'true' : 'false'} />
              <label>Item <input name="inventoryName" value={item.name} placeholder="Potion, rope, gold ring" /></label>
              <label>Category
                <select name="inventoryCategory">
                  {#each categoryOptionsFor(item.category) as category}
                    <option value={category.key} selected={item.category === category.key}>{category.label}</option>
                  {/each}
                </select>
              </label>
              <label class="qty-label">Qty
                <span class="qty-equipment-control">
                  <span class="qty-control">
                    <button type="button" class="qty-button" onclick={(event) => adjustInventoryQuantity(event, -1)}>-</button>
                    <input name="inventoryQuantity" type="number" min="0" value={item.quantity} />
                    <button type="button" class="qty-button" onclick={(event) => adjustInventoryQuantity(event, 1)}>+</button>
                  </span>
                  <button type="button" class="equipment-toggle" aria-label="Equip item" title="Equip item" onclick={(event) => toggleEquipped(event, true)}>
                    <span class="item-kind-icon" aria-hidden="true"></span>
                  </button>
                </span>
              </label>
              <label>Notes <input name="inventoryNotes" value={item.notes} /></label>
              <div class="row-actions">
                <button type="button" class="compact-button" onclick={useInventoryItem}>Use</button>
                <button type="button" class="compact-button danger" onclick={removeInventoryItem}>Remove</button>
              </div>
              <input name="inventoryLocation" type="hidden" value="backpack" />
              <input name="inventoryAcBonus" type="hidden" value={item.acBonus} />
              <input name="inventoryToHitBonus" type="hidden" value={item.toHitBonus} />
              <input name="inventoryDamageBonus" type="hidden" value={item.damageBonus} />
              <input name="inventoryAttackAbility" type="hidden" value={item.attackAbility} />
              <input name="inventoryProficient" type="hidden" value={item.proficient ? 'true' : 'false'} />
              <input name="inventoryDamageRolls" type="hidden" value={item.damageRolls} />
              <input name="inventoryEffects" type="hidden" value={item.effects} />
              <input name="inventoryIsEquipment" type="hidden" value={item.isEquipment ? 'true' : 'false'} />
              <input name="inventoryEquipped" type="hidden" value="false" />
              {#if item.resources?.length}<div class="inventory-item-resources">{#each item.resources as resource}<div class="resource-counter"><span>{resource.label}</span><strong>{resource.currentValue} / {resource.maxValue}</strong><div><button type="button" onclick={() => runContentAction('inventoryResource',{resourceId:resource.id,delta:-1})}>-</button><button type="button" onclick={() => runContentAction('inventoryResource',{resourceId:resource.id,delta:1})}>+</button></div></div>{/each}</div>{/if}
            </div>
          {:else}
            <p class="muted">No backpack items yet.</p>
          {/each}
        </div>
      </section>

      <section class="panel stack inventory-section misc-section">
        <div class="panel-head compact-head">
          <h2>Misc</h2>
          <button type="button" class="compact-button" onclick={() => openNewItem('misc')}>Add Item</button>
        </div>
        <div class="coin-grid">
          <label>CP <input name="currencyCp" type="number" min="0" value={meta('currencyCp')} /></label>
          <label>SP <input name="currencySp" type="number" min="0" value={meta('currencySp')} /></label>
          <label>EP <input name="currencyEp" type="number" min="0" value={meta('currencyEp')} /></label>
          <label>GP <input name="currencyGp" type="number" min="0" value={meta('currencyGp')} /></label>
          <label>PP <input name="currencyPp" type="number" min="0" value={meta('currencyPp')} /></label>
        </div>
        <label>Treasure & Valuables <textarea name="treasureNote">{notes.treasure ?? ''}</textarea></label>
        <label>General Inventory / Junk <textarea name="generalInventoryNote">{notes.general_inventory ?? ''}</textarea></label>
        {#each miscInventoryRows as item, index (item.id ?? `misc-${item.name}-${index}`)}
          <div class="inventory-row misc-row">
            <input name="inventoryId" type="hidden" value={item.id || ''} />
            <input name="inventorySourceContentId" type="hidden" value={item.sourceContentId || ''} />
            <input name="inventoryAttuned" type="hidden" value="false" />
            <label>Misc Item <input name="inventoryName" value={item.name} placeholder="Letter, gem, trinket" /></label>
            <label>Qty <input name="inventoryQuantity" type="number" min="0" value={item.quantity} /></label>
            <label>Notes <input name="inventoryNotes" value={item.notes} /></label>
            <input name="inventoryCategory" type="hidden" value={item.category || 'misc'} />
            <input name="inventoryLocation" type="hidden" value="misc" />
            <input name="inventoryAcBonus" type="hidden" value={item.acBonus} />
            <input name="inventoryToHitBonus" type="hidden" value={item.toHitBonus} />
            <input name="inventoryDamageBonus" type="hidden" value={item.damageBonus} />
            <input name="inventoryAttackAbility" type="hidden" value={item.attackAbility} />
            <input name="inventoryProficient" type="hidden" value={item.proficient ? 'true' : 'false'} />
            <input name="inventoryDamageRolls" type="hidden" value={item.damageRolls} />
            <input name="inventoryEffects" type="hidden" value={item.effects} />
            <input name="inventoryIsEquipment" type="hidden" value="false" />
            <input name="inventoryEquipped" type="hidden" value="false" />
          </div>
        {:else}
          <p class="muted">No misc items yet.</p>
        {/each}
      </section>
    </section>
  {/if}

  {#if activeTab === 'character'}
    <section class="sheet-columns character-layout">
      <section class="panel stack">
        <h2>Identity</h2>
        <label>Character Name <input name="name" value={character.name} required /></label>
        <div class="class-list">
          {#each classRows as classRow, index}
            <div class="class-row">
              <label>Class <input name="className" bind:value={classRow.className} /></label>
              <label>Subclass <input name="subclassName" bind:value={classRow.subclassName} placeholder="Eldritch Knight" /></label>
              <label>Level <input name="classLevel" type="number" min="1" max="20" bind:value={classRow.level} /></label>
              <label>Spellcasting Ability<select name="classSpellcastingAbility" bind:value={classRow.spellcastingAbility}><option value={null}>None</option>{#each abilityOrder as key}<option value={key}>{key.toUpperCase()}</option>{/each}</select></label>
              <button type="button" class="compact-button danger" disabled={classRows.length === 1} onclick={() => removeClassRow(index)}>Remove</button>
            </div>
          {/each}
          <button type="button" class="compact-button" onclick={addClassRow}>Add Class</button>
        </div>
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
    <input name="exhaustionLevel" type="hidden" value={selectedExhaustionLevel} />
    {#each selectedEffectKeys as effectKey}
      <input name="activeEffectKey" type="hidden" value={effectKey} />
    {/each}
    {#if !savingThrowsOpen}
      {#each selectedSavingThrowProficiencies as key}
        <input name="savingThrowProficiency" type="hidden" value={key} />
      {/each}
    {/if}
    {#if !skillChecksOpen}
      {#each selectedSkillProficiencies as key}
        <input name="skillProficiency" type="hidden" value={key} />
      {/each}
    {/if}
    {#each proficiencies.weapons as key}
      <input name="weaponProficiency" type="hidden" value={key} />
    {/each}
    {#each classHitDice as hdc, i}
      <input name="hitDiceCurrent_{i}" type="hidden" value={hdc.remaining} />
      <input name="hitDiceMax_{i}" type="hidden" value={hdc.level} />
    {/each}

    {#if activeTab !== 'battle'}
      <input name="hpCurrent" type="hidden" value={hp.currentValue} />
      <input name="hpMax" type="hidden" value={hp.maxValue} />
      <input name="tempHp" type="hidden" value={tempHp.currentValue} />
      <input name="inspiration" type="hidden" value={inspiration} />
      <input name="armorClass" type="hidden" value={computedArmorClass} />
      <input name="initiative" type="hidden" value={signed(computedInitiative)} />
      <input name="speed" type="hidden" value={computedSpeed} />
      <input name="hitDice" type="hidden" value={computedHitDice} />
      <input name="deathSaveSuccesses" type="hidden" value={deathSaveSuccesses} />
      <input name="deathSaveFailures" type="hidden" value={deathSaveFailures} />
      <input name="passivePerception" type="hidden" value={computedPassivePerception} />
      {#each Object.entries(abilityScores) as [key, score]}
        <input name={`ability_${key}`} type="hidden" value={score} />
      {/each}
      <input name="attackName" type="hidden" value={attack.name} />
      <input name="attackAbility" type="hidden" value={attack.attackAbility} />
      {#if attack.proficient}<input name="attackProficient" type="hidden" value="on" />{/if}
      <input name="attackDamageDice" type="hidden" value={attack.damageDice} />
      <input name="attackNotes" type="hidden" value={attack.notes} />
      <input name="spellcastingAbility" type="hidden" value={spellcastingAbility} />
      <input name="spellSaveDc" type="hidden" value={computedSpellSaveDc} />
      <input name="spellAttackBonus" type="hidden" value={signed(computedSpellAttackBonus)} />
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
      {#each inventoryRows as item, index (item.id ?? `hidden-inventory-${item.name}-${index}`)}
        <input name="inventoryId" type="hidden" value={item.id || ''} />
        <input name="inventorySourceContentId" type="hidden" value={item.sourceContentId || ''} />
        <input name="inventoryAttuned" type="hidden" value={item.attuned ? 'true' : 'false'} />
        <input name="inventoryName" type="hidden" value={item.name} />
        <input name="inventoryCategory" type="hidden" value={item.category} />
        <input name="inventoryLocation" type="hidden" value={item.location} />
        <input name="inventoryQuantity" type="hidden" value={item.quantity} />
        <input name="inventoryEquipped" type="hidden" value={item.equipped ? 'true' : 'false'} />
        <input name="inventoryIsEquipment" type="hidden" value={item.isEquipment ? 'true' : 'false'} />
        <input name="inventoryAcBonus" type="hidden" value={item.acBonus} />
        <input name="inventoryToHitBonus" type="hidden" value={item.toHitBonus} />
        <input name="inventoryDamageBonus" type="hidden" value={item.damageBonus} />
        <input name="inventoryAttackAbility" type="hidden" value={item.attackAbility} />
        <input name="inventoryProficient" type="hidden" value={item.proficient ? 'true' : 'false'} />
        <input name="inventoryDamageRolls" type="hidden" value={item.damageRolls} />
        <input name="inventoryEffects" type="hidden" value={item.effects} />
        <input name="inventoryNotes" type="hidden" value={item.notes} />
      {/each}
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
      {#each classRows as classRow}
        <input name="className" type="hidden" value={classRow.className} />
        <input name="subclassName" type="hidden" value={classRow.subclassName || ''} />
        <input name="classSpellcastingAbility" type="hidden" value={classRow.spellcastingAbility || ''} />
        <input name="classLevel" type="hidden" value={classRow.level} />
      {/each}
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
    <div class="modal-backdrop" role="presentation" onpointerdown={() => (savingThrowsOpen = false)}>
      <div class="panel compact-modal" role="dialog" aria-modal="true" aria-labelledby="saving-throws-title" tabindex="-1" onpointerdown={(event) => event.stopPropagation()}>
        <div class="panel-head">
          <h2 id="saving-throws-title">Saving Throws</h2>
          <div class="actions">
            <button type="button" class="compact-button dice-button" onclick={rollAllSavingThrows}>
              <img src={d20Icon} alt="" />
              Roll All Saves
            </button>
            <button type="button" class="text-button" onclick={() => (savingThrowsOpen = false)}>Close</button>
          </div>
        </div>
        <div class="check-list">
          {#each abilityOrder as key}
            <div class="check-row proficiency-row" class:proficient={isSavingThrowProficient(key)}>
              <label class="proficiency-toggle">
                <input name="savingThrowProficiency" type="checkbox" value={key} checked={isSavingThrowProficient(key)} onchange={() => toggleSavingThrowProficiency(key)} />
                <span>
                  <strong>{key.toUpperCase()}</strong>
                  <small>{signed(abilityModifier(abilityScores[key]))}{isSavingThrowProficient(key) ? ` + ${prof} proficiency` : ''}{(savingThrowModifierBonuses[key] ?? []).length ? ' + modifiers' : ''}</small>
                </span>
                <b>{signed(savingThrowTotal(key))}</b>
              </label>
              <button type="button" class="formula-help-button" title={helpTitle(savingThrowFormula(key))} aria-label={`${key.toUpperCase()} saving throw breakdown`} onclick={() => openFormulaHelp(`${key.toUpperCase()} Saving Throw`, savingThrowFormula(key))}>?</button>
              <button type="button" class="compact-button dice-icon-button" aria-label={`Roll ${key.toUpperCase()} saving throw`} title={`Roll ${key.toUpperCase()} saving throw`} onclick={() => rollSingleSavingThrow(key)}>
                <img src={d20Icon} alt="" />
              </button>
            </div>
          {/each}
        </div>
        <div class="modal-actions">
          <button type="submit">Save Proficiencies</button>
        </div>
      </div>
    </div>
  {/if}

  {#if skillChecksOpen}
    <div class="modal-backdrop" role="presentation" onpointerdown={() => (skillChecksOpen = false)}>
      <div class="panel compact-modal wide-check-modal" role="dialog" aria-modal="true" aria-labelledby="skill-checks-title" tabindex="-1" onpointerdown={(event) => event.stopPropagation()}>
        <div class="panel-head">
          <h2 id="skill-checks-title">Skill Checks</h2>
          <div class="actions">
            <button type="button" class="compact-button dice-button" onclick={rollAllSkillChecks}>
              <img src={d20Icon} alt="" />
              Roll All Skills
            </button>
            <button type="button" class="text-button" onclick={() => (skillChecksOpen = false)}>Close</button>
          </div>
        </div>
        <div class="check-list skill-list">
          {#each skillChecks as skill}
            <div class="check-row proficiency-row" class:proficient={isSkillProficient(skill.key)}>
              <label class="proficiency-toggle">
                <input name="skillProficiency" type="checkbox" value={skill.key} checked={isSkillProficient(skill.key)} onchange={() => toggleSkillProficiency(skill.key)} />
                <span>
                  <strong>{skill.name}</strong>
                  <small>{skill.ability.toUpperCase()} {signed(abilityModifier(abilityScores[skill.ability]))}{isSkillProficient(skill.key) ? ` + ${prof} proficiency` : ''}{(skillCheckModifierBonuses[skill.key] ?? []).length ? ' + modifiers' : ''}</small>
                </span>
                <b>{signed(skillCheckTotal(skill))}</b>
              </label>
              <button type="button" class="formula-help-button" title={helpTitle(skillCheckFormula(skill))} aria-label={`${skill.name} breakdown`} onclick={() => openFormulaHelp(skill.name, skillCheckFormula(skill))}>?</button>
              <button type="button" class="compact-button dice-icon-button" aria-label={`Roll ${skill.name}`} title={`Roll ${skill.name}`} onclick={() => rollSingleSkillCheck(skill)}>
                <img src={d20Icon} alt="" />
              </button>
            </div>
          {/each}
        </div>
        <div class="modal-actions">
          <button type="submit">Save Proficiencies</button>
        </div>
      </div>
    </div>
  {/if}

  {#if playerModificationsOpen}
    <div class="modal-backdrop" role="presentation" onpointerdown={() => (playerModificationsOpen = false)}>
      <div class="panel modifier-modal" role="dialog" aria-modal="true" aria-labelledby="player-modifications-title" tabindex="-1" onpointerdown={(event) => event.stopPropagation()}>
        <div class="panel-head">
          <div>
            <h2 id="player-modifications-title">Player Modifications</h2>
            <p class="muted">Conditions, spells, combat states, and environment effects applied to this character.</p>
          </div>
          <button type="button" class="text-button" onclick={() => (playerModificationsOpen = false)}>Close</button>
        </div>

        <label class="exhaustion-control">Exhaustion Level
          <input
            type="number"
            min="0"
            max="6"
            value={selectedExhaustionLevel}
            oninput={(event) => (selectedExhaustionLevel = Math.min(6, Math.max(0, Number(event.currentTarget.value) || 0)))}
          />
        </label>

        <div class="modifier-picker">
          <div class="modifier-toolbar">
            <label class="modifier-search">Search
              <input
                value={modifierSearch}
                placeholder="Search conditions, spells, features, states..."
                oninput={(event) => (modifierSearch = event.currentTarget.value)}
              />
            </label>

            <div class="modifier-tabs" role="tablist" aria-label="Modifier filters">
              {#each modifierFilters as filter}
                <button
                  type="button"
                  class:active={modifierFilter === filter.key}
                  onclick={() => (modifierFilter = filter.key)}
                >
                  {filter.label}
                </button>
              {/each}
            </div>
          </div>

          <section class="selected-modifier-summary">
            <h3>Selected</h3>
            <div class="selected-mods">
              {#each activeEffectDetails as effect}
                <button
                  type="button"
                  class:condition-chip={effect.isCondition}
                  title={effect.description}
                  onclick={() => toggleEffect(effect.key)}
                >
                  {effect.name}
                </button>
              {:else}
                <span class="muted">No active effects selected.</span>
              {/each}
            </div>
          </section>

          <section class="modifier-results">
            <div class="modifier-results-head">
              <h3>{activeModifierFilterLabel}</h3>
              <span class="muted">Showing {visibleModifierEffects.length} of {filteredModifierEffects.length}</span>
            </div>

            <div class="modifier-list compact">
              {#each visibleModifierEffects as effect}
                <label class="modifier-toggle">
                  <input type="checkbox" checked={isEffectSelected(effect.key)} onchange={() => toggleEffect(effect.key)} />
                  <span>
                    <strong>{effect.name}</strong>
                    <small>{effect.description}</small>
                    <b>
                      {effect.isCondition ? 'Condition' : effect.sourceType.replace('_', ' ')}
                      {effect.requiresConcentration ? ' - Concentration' : ''}
                      {effect.modifiers.length ? ' - Automated' : effect.isSelectable ? ' - Trackable' : ' - Catalogue'}
                    </b>
                    {#if effect.modifiers.length}
                      <em>{effect.modifiers.map((modifier) => `${modifier.target}: ${modifier.modifierType}${modifier.valueExpression ? ` ${modifier.valueExpression}` : ''}`).join(', ')}</em>
                    {/if}
                  </span>
                </label>
              {:else}
                <p class="muted">No modifiers match this filter.</p>
              {/each}
            </div>

            {#if filteredModifierEffects.length > visibleModifierEffects.length}
              <p class="muted">Showing the first 50 results. Search or filter to narrow the list.</p>
            {/if}
          </section>
        </div>

        <div class="modal-actions">
          <button type="submit">Save Modifications</button>
        </div>
      </div>
    </div>
  {/if}

  {#if formulaHelp}
    <div class="modal-backdrop" role="presentation" onpointerdown={() => (formulaHelp = null)}>
      <div class="panel compact-modal" role="dialog" aria-modal="true" aria-labelledby="formula-help-title" tabindex="-1" onpointerdown={(event) => event.stopPropagation()}>
        <div class="panel-head">
          <h2 id="formula-help-title">{formulaHelp.title}</h2>
          <button type="button" class="text-button" onclick={() => (formulaHelp = null)}>Close</button>
        </div>
        <div class="formula-breakdown">
          {#each formulaHelp.lines as line}
            <p>{line}</p>
          {/each}
        </div>
      </div>
    </div>
  {/if}

  {#if rollResult}
    <div class="modal-backdrop" role="presentation" onpointerdown={() => (rollResult = null)}>
      <div class="panel compact-modal" role="dialog" aria-modal="true" aria-labelledby="roll-result-title" tabindex="-1" onpointerdown={(event) => event.stopPropagation()}>
        <div class="panel-head">
          <h2 id="roll-result-title">{rollResult.title}</h2>
          <button type="button" class="text-button" onclick={() => (rollResult = null)}>Close</button>
        </div>
        <div class="roll-result">
          <div>
            <span>To Hit</span>
            <strong>{rollResult.attack}</strong>
          </div>
          <div>
            <span>Damage</span>
            <div class="damage-lines">
              {#each rollResult.damage as line}
                <strong>{line}</strong>
              {/each}
            </div>
          </div>
          <div>
            <span>Effects</span>
            <strong>{rollResult.effects}</strong>
          </div>
        </div>
      </div>
    </div>
  {/if}

  {#if simpleRollResult}
    <div class="modal-backdrop" role="presentation" onpointerdown={() => (simpleRollResult = null)}>
      <div class="panel compact-modal" role="dialog" aria-modal="true" aria-labelledby="simple-roll-result-title" tabindex="-1" onpointerdown={(event) => event.stopPropagation()}>
        <div class="panel-head">
          <h2 id="simple-roll-result-title">{simpleRollResult.title}</h2>
          <button type="button" class="text-button" onclick={() => (simpleRollResult = null)}>Close</button>
        </div>
        <div class="roll-result">
          {#each simpleRollResult.lines as line}
            <div>
              <span>{line.label}</span>
              <strong class:nat-one={line.natural === 1} class:nat-twenty={line.natural === 20}>{line.text}</strong>
            </div>
          {/each}
          {#if simpleRollResult.passiveNote}
            <p class="muted passive-note">{simpleRollResult.passiveNote}</p>
          {/if}
        </div>
      </div>
    </div>
  {/if}

  {#if inventoryMessage}
    <div class="modal-backdrop" role="presentation" onpointerdown={() => (inventoryMessage = null)}>
      <div class="panel compact-modal" role="dialog" aria-modal="true" aria-labelledby="inventory-action-title" tabindex="-1" onpointerdown={(event) => event.stopPropagation()}>
        <div class="panel-head">
          <h2 id="inventory-action-title">Inventory Action</h2>
          <button type="button" class="text-button" onclick={() => (inventoryMessage = null)}>Close</button>
        </div>
        <p class="muted inventory-action-result">{inventoryMessage}</p>
      </div>
    </div>
  {/if}

  {#if simpleItemOpen}
    <div class="modal-backdrop" role="presentation" onpointerdown={() => (simpleItemOpen = false)}>
      <div class="panel item-modal" role="dialog" aria-modal="true" aria-labelledby="simple-item-title" tabindex="-1" onpointerdown={(event) => event.stopPropagation()}>
        <div class="panel-head">
          <h2 id="simple-item-title">Add Item</h2>
          <button type="button" class="text-button" onclick={() => (simpleItemOpen = false)}>Close</button>
        </div>
        <div class="new-item-grid">
          <label>Item <input bind:value={simpleItemName} placeholder="Gold watch, emerald ring, six cabbages" /></label>
          <label>Category
            <select bind:value={simpleItemCategory}>
              {#each categoryOptions as category}
                <option value={category.key}>{category.label}</option>
              {/each}
            </select>
          </label>
          <label class="qty-label">Quantity
            <span class="qty-control">
              <button type="button" class="qty-button" onclick={() => (simpleItemQuantity = Math.max(1, simpleItemQuantity - 1))}>-</button>
              <input type="number" min="1" bind:value={simpleItemQuantity} />
              <button type="button" class="qty-button" onclick={() => (simpleItemQuantity = simpleItemQuantity + 1)}>+</button>
            </span>
          </label>
          <label>Notes <input bind:value={simpleItemNotes} /></label>
        </div>
        <div class="modal-actions">
          <button type="button" disabled={!simpleItemName.trim() || contentBusy} onclick={addSimpleItem}>Add Item</button>
        </div>
      </div>
    </div>
  {/if}

  {#if newItemOpen}
    <div class="modal-backdrop" role="presentation" onpointerdown={() => (newItemOpen = false)}>
      <div class="panel item-modal" role="dialog" aria-modal="true" aria-labelledby="new-item-title" tabindex="-1" onpointerdown={(event) => event.stopPropagation()}>
        <div class="panel-head">
          <h2 id="new-item-title">Add Item</h2>
          <button type="button" class="text-button" onclick={() => (newItemOpen = false)}>Close</button>
        </div>
        <div class="new-item-grid">
          <input name="inventoryId" type="hidden" value="" />
          <input name="inventorySourceContentId" type="hidden" value="" />
          <input name="inventoryAttuned" type="hidden" value="false" />
          <label>Item <input name="inventoryName" placeholder="Longsword, potion, gold ring" /></label>
          <label>Category
            <select name="inventoryCategory">
              {#each categoryOptions as category}
                <option value={category.key} selected={category.key === (newItemLocation === 'misc' ? 'misc' : 'gear')}>{category.label}</option>
              {/each}
            </select>
          </label>
          <label class="qty-label">Quantity
            <span class="qty-control">
              <button type="button" class="qty-button" onclick={(event) => adjustInventoryQuantity(event, -1)}>-</button>
              <input name="inventoryQuantity" type="number" min="0" value="1" />
              <button type="button" class="qty-button" onclick={(event) => adjustInventoryQuantity(event, 1)}>+</button>
            </span>
          </label>
          <label>Section
            <select name="inventoryLocation">
              <option value="equipped" selected={newItemLocation === 'equipped'}>Equipment</option>
              <option value="backpack" selected={newItemLocation === 'backpack'}>Backpack</option>
              <option value="misc" selected={newItemLocation === 'misc'}>Misc</option>
            </select>
          </label>
          <label class="equipment-select-label">Equipment
            <select name="inventoryIsEquipment">
              <option value="false" selected={newItemLocation !== 'equipped'}>No</option>
              <option value="true" selected={newItemLocation === 'equipped'}>Yes</option>
            </select>
          </label>
          <label class="tiny-field">AC <input name="inventoryAcBonus" type="number" value="0" /></label>
          <label class="tiny-field">To Hit <input name="inventoryToHitBonus" type="number" value="0" /></label>
          <label class="tiny-field">Damage Bonus <input name="inventoryDamageBonus" type="number" value="0" /></label>
          <label>Ability
            <select name="inventoryAttackAbility">
              {#each abilityOrder as ability}
                <option value={ability} selected={ability === 'str'}>{ability.toUpperCase()}</option>
              {/each}
            </select>
          </label>
          <label class="inline compact-check">
            <input name="inventoryProficient" type="hidden" value="true" />
            <input type="checkbox" checked onchange={setSiblingHiddenBoolean} />
            Proficient
          </label>
          <label>Damage Rolls <input name="inventoryDamageRolls" placeholder="1d8 + 1d4" /></label>
          <label>Effects <input name="inventoryEffects" placeholder="fire, poison, prone" /></label>
          <label>Notes <input name="inventoryNotes" /></label>
        </div>
        <input name="inventoryEquipped" type="hidden" value={newItemLocation === 'equipped' ? 'true' : 'false'} />
        <div class="modal-actions">
          <button type="submit">Save Item</button>
        </div>
      </div>
    </div>
  {/if}
</form>
