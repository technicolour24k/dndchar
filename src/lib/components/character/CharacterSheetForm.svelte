<script lang="ts">
  import { enhance } from '$app/forms';
  import { abilityMap, abilityModifier, hitDiceSummary, proficiencyBonus, resolvedFlatBonuses, resolvedNumericModifiers, totalLevel } from '$lib/rules/dnd5e';
  import type { AbilityKey, CharacterDetail, InventoryItem, ItemCategory } from '$lib/types/character';

  let {
    character,
    itemCategories = [],
    result,
    onVersionHistory
  }: {
    character: CharacterDetail;
    itemCategories?: ItemCategory[];
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
  const equippedInventoryRows = $derived(
    inventoryRows.filter((item) => item.location === 'equipped' || item.equipped)
  );
  const backpackInventoryRows = $derived(
    inventoryRows.filter((item) => item.location !== 'equipped' && item.location !== 'misc' && !item.equipped)
  );
  const miscInventoryRows = $derived(inventoryRows.filter((item) => item.location === 'misc'));
  const battleActionItems = $derived(
    inventoryRows.filter((item) => (item.location === 'equipped' || item.equipped) && (item.isEquipment || item.damageRolls || item.toHitBonus || item.damageBonus))
  );
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
  let savingThrowRolls = $state<Record<string, { text: string; natural: number }>>({});
  let skillRolls = $state<Record<string, { text: string; natural: number }>>({});
  let abilityRolls = $state<Partial<Record<AbilityKey, { text: string; natural: number }>>>({});
  let modifierSearch = $state('');
  let modifierFilter = $state<'active' | 'automated' | 'potential' | 'condition' | 'spell' | 'combat' | 'class_feature' | 'environment' | 'all' | 'catalogue'>('active');
  let newItemOpen = $state(false);
  let newItemLocation = $state<'equipped' | 'backpack' | 'misc'>('backpack');
  let rollResult = $state<{
    title: string;
    attack: string;
    damage: string[];
    effects: string;
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
    { key: 'all', label: 'All' },
    { key: 'catalogue', label: 'Catalogue' }
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
  const filteredModifierEffects = $derived(
    character.availableEffects.filter((effect) => {
      const query = modifierSearch.trim().toLowerCase();
      const matchesSearch = !query || [effect.name, effect.description, effect.sourceRef, effect.sourceType]
        .join(' ')
        .toLowerCase()
        .includes(query);
      const matchesFilter =
        (modifierFilter === 'all' && effect.isSelectable) ||
        modifierFilter === 'catalogue' ||
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
  const acModifierBonuses = $derived(resolvedFlatBonuses(character.activeEffects, ['ac'], { classes: character.classes }));
  const computedArmorClass = $derived(
    10 +
      abilityModifier(abilityScores.dex) +
      equippedAcBonus +
      acModifierBonuses.reduce((sum, bonus) => sum + bonus.value, 0)
  );
  const initiativeModifierBonuses = $derived(resolvedFlatBonuses(character.activeEffects, ['initiative'], { classes: character.classes }));
  const computedInitiative = $derived(
    abilityModifier(abilityScores.dex) +
      initiativeModifierBonuses.reduce((sum, bonus) => sum + bonus.value, 0)
  );
  const computedSpeedValue = $derived.by(() => {
    const setValues = resolvedNumericModifiers(character.activeEffects, ['speed.all', 'speed.walk'], ['set'], { classes: character.classes });
    const bonuses = resolvedNumericModifiers(character.activeEffects, ['speed.all', 'speed.walk'], ['bonus'], { classes: character.classes });
    const multipliers = resolvedNumericModifiers(character.activeEffects, ['speed.all', 'speed.walk'], ['multiplier'], { classes: character.classes });
    const base = setValues.length ? setValues.at(-1)?.value ?? 30 : 30;
    const withBonuses = base + bonuses.reduce((sum, bonus) => sum + bonus.value, 0);
    const multiplied = multipliers.reduce((value, multiplier) => value * multiplier.value, withBonuses);
    return Math.max(0, Math.floor(multiplied));
  });
  const computedSpeed = $derived(`${computedSpeedValue} ft.`);
  const computedHitDice = $derived(hitDiceSummary(character.classes));
  const passivePerceptionBonuses = $derived(resolvedFlatBonuses(character.activeEffects, ['skill.perception', 'passive.perception'], { classes: character.classes }));
  const computedPassivePerception = $derived(
    10 +
      abilityModifier(abilityScores.wis) +
      (isSkillProficient('perception') ? prof : 0) +
      passivePerceptionBonuses.reduce((sum, bonus) => sum + bonus.value, 0)
  );
  const combatFormulaHelp = $derived.by(() => {
    const dexMod = abilityModifier(abilityScores.dex);
    const wisMod = abilityModifier(abilityScores.wis);
    const speedSetValues = resolvedNumericModifiers(character.activeEffects, ['speed.all', 'speed.walk'], ['set'], { classes: character.classes });
    const speedBonuses = resolvedNumericModifiers(character.activeEffects, ['speed.all', 'speed.walk'], ['bonus'], { classes: character.classes });
    const speedMultipliers = resolvedNumericModifiers(character.activeEffects, ['speed.all', 'speed.walk'], ['multiplier'], { classes: character.classes });
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
        ...character.classes.map((row) => `${row.className || 'Class'} ${row.level}: ${row.level}d${row.className ? hitDiceSummary([row]).split('d')[1] || '8' : '8'}`),
        `Total: ${computedHitDice || 'None'}`
      ],
      passivePerception: [
        'Base: 10',
        `WIS modifier: ${signed(wisMod)}`,
        `Perception proficiency: ${isSkillProficient('perception') ? signed(prof) : '+0'}`,
        ...passivePerceptionBonuses.map((bonus) => `${bonus.label}: ${signed(bonus.value)}`),
        `Total: ${computedPassivePerception}`
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
      ...character.classes.map((row) => `${row.className || 'Class'} ${row.level}: ${row.level}d${hitDieForRow(row)}`),
      `Total: ${computedHitDice || 'None'}`
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
    newItemLocation = location;
    newItemOpen = true;
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
    selectedEffectKeys = character.activeEffects.map((effect) => effect.effectKey);
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
    return abilityModifier(abilityScores[key]) + (isSavingThrowProficient(key) ? prof : 0);
  }

  function skillCheckTotal(skill: { key: string; ability: AbilityKey }) {
    return abilityModifier(abilityScores[skill.ability]) + (isSkillProficient(skill.key) ? prof : 0);
  }

  function rollText(modifier: number) {
    const d20 = rollDie(20);
    const total = d20 + modifier;
    return {
      text: `d20 ${d20} ${modifier >= 0 ? '+' : '-'} ${Math.abs(modifier)} = ${total}`,
      natural: d20
    };
  }

  function rollAllSavingThrows() {
    savingThrowRolls = Object.fromEntries(
      abilityOrder.map((key) => [key, rollText(savingThrowTotal(key))])
    );
  }

  function rollAllSkillChecks() {
    skillRolls = Object.fromEntries(
      skillChecks.map((skill) => [skill.key, rollText(skillCheckTotal(skill))])
    );
  }

  function rollSingleSavingThrow(key: AbilityKey) {
    savingThrowRolls = { ...savingThrowRolls, [key]: rollText(savingThrowTotal(key)) };
  }

  function rollSingleSkillCheck(skill: { key: string; ability: AbilityKey }) {
    skillRolls = { ...skillRolls, [skill.key]: rollText(skillCheckTotal(skill)) };
  }

  function rollAbilityCheck(key: AbilityKey) {
    abilityRolls = { ...abilityRolls, [key]: rollText(abilityModifier(abilityScores[key])) };
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

  function rollDamageExpression(expression: string, bonus: number, abilityBonus = 0, abilityLabel = '', modifierBonuses: Array<{ label: string; value: number }> = []) {
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

  function battleDamageBonuses(item: InventoryItem) {
    const canBeMeleeWeaponAttack = ['weapon', 'shield'].includes(item.category) && item.attackAbility === 'str';
    const candidates = [
      'damage_roll.all',
      'damage_roll.weapon',
      item.attackAbility ? `damage_roll.weapon.${item.attackAbility}` : '',
      canBeMeleeWeaponAttack ? 'damage_roll.melee_weapon' : '',
      canBeMeleeWeaponAttack ? `damage_roll.melee_weapon.${item.attackAbility}` : ''
    ].filter(Boolean);

    return resolvedFlatBonuses(character.activeEffects, candidates, {
      classes: character.classes,
      attackType: 'melee_weapon',
      ability: item.attackAbility
    });
  }

  function rollBattleAction(item: InventoryItem) {
    const d20 = rollDie(20);
    const ability = abilityModifier(abilityScores[item.attackAbility]);
    const attackBonus = ability + (item.proficient ? prof : 0) + Number(item.toHitBonus || 0);
    const attackTotal = d20 + attackBonus;
    const damage = rollDamageExpression(item.damageRolls, Number(item.damageBonus || 0), ability, item.attackAbility.toUpperCase(), battleDamageBonuses(item));

    rollResult = {
      title: item.name || 'Battle Action',
      attack: `d20 ${d20} ${attackBonus >= 0 ? '+' : '-'} ${Math.abs(attackBonus)} = ${attackTotal} (beats AC ${attackTotal} or below)`,
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
    const roll = damageRolls ? rollDamageExpression(damageRolls, damageBonus, ability, attackAbility.toUpperCase()) : null;
    adjustInventoryQuantity(event, -1);
    inventoryMessage = roll
      ? `${name} used. Quantity reduced by 1. Roll: ${roll.lines.join('; ')}${effects ? ` (${effects})` : ''}.`
      : `${name} used. Quantity reduced by 1.`;
  }

  function removeInventoryItem(event: MouseEvent) {
    const row = findInventoryRow(event);
    const name = row?.querySelector<HTMLInputElement>('input[name="inventoryName"]')?.value || 'Item';
    setInventoryQuantity(event, 0);
    inventoryMessage = `${name} set to 0. Save to remove it from the backpack.`;
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
            <label>
              <span class="field-label-with-help">
                Hit Dice
                <button type="button" class="formula-help-button" title={helpTitle(hitDiceFormulaLines)} aria-label="Hit Dice formula breakdown" onclick={() => openFormulaHelp('Hit Dice', hitDiceFormulaLines)}>?</button>
              </span>
              <input name="hitDice" value={computedHitDice} readonly />
            </label>
            <label>
              <span class="field-label-with-help">
                Passive Perception
                <button type="button" class="formula-help-button" title={helpTitle(combatFormulaHelp.passivePerception)} aria-label="Passive Perception formula breakdown" onclick={() => openFormulaHelp('Passive Perception', combatFormulaHelp.passivePerception)}>?</button>
              </span>
              <input name="passivePerception" type="number" value={computedPassivePerception} readonly />
            </label>
            <label>
              <span class="field-label-with-help">
                Initiative
                <button type="button" class="formula-help-button" title={helpTitle(combatFormulaHelp.initiative)} aria-label="Initiative formula breakdown" onclick={() => openFormulaHelp('Initiative', combatFormulaHelp.initiative)}>?</button>
              </span>
              <input name="initiative" value={signed(computedInitiative)} readonly />
            </label>
            <label>
              <span class="field-label-with-help">
                Speed
                <button type="button" class="formula-help-button" title={helpTitle(combatFormulaHelp.speed)} aria-label="Speed formula breakdown" onclick={() => openFormulaHelp('Speed', combatFormulaHelp.speed)}>?</button>
              </span>
              <input name="speed" value={computedSpeed} readonly />
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
                  {#if abilityRolls[key]}
                    <span class="ability-roll-result" class:nat-one={abilityRolls[key]?.natural === 1} class:nat-twenty={abilityRolls[key]?.natural === 20}>{abilityRolls[key]?.text}</span>
                  {/if}
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
              {#each activeEffectDetails.slice(0, 5) as effect}
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
              {#if activeEffectDetails.length > 5}
                <span>+{activeEffectDetails.length - 5}</span>
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
                <label>Damage Rolls <input name="inventoryDamageRolls" value={item.damageRolls} placeholder="1d8 + 1d4 + 1d6" /></label>
                <label>Effects <input name="inventoryEffects" value={item.effects} placeholder="fire, poison, prone" /></label>
                <label>Notes <input name="inventoryNotes" value={item.notes} /></label>
              </div>
              <input name="inventoryLocation" type="hidden" value="equipped" />
              <input name="inventoryIsEquipment" type="hidden" value="true" />
              <input name="inventoryEquipped" type="hidden" value="true" />
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
      {#each inventoryRows as item, index (item.id ?? `hidden-inventory-${item.name}-${index}`)}
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
                  <small>{signed(abilityModifier(abilityScores[key]))}{isSavingThrowProficient(key) ? ` + ${prof} proficiency` : ''}</small>
                </span>
                <b>{signed(savingThrowTotal(key))}</b>
                {#if savingThrowRolls[key]}
                  <em class:nat-one={savingThrowRolls[key].natural === 1} class:nat-twenty={savingThrowRolls[key].natural === 20}>{savingThrowRolls[key].text}</em>
                {/if}
              </label>
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
                  <small>{skill.ability.toUpperCase()} {signed(abilityModifier(abilityScores[skill.ability]))}{isSkillProficient(skill.key) ? ` + ${prof} proficiency` : ''}</small>
                </span>
                <b>{signed(skillCheckTotal(skill))}</b>
                {#if skillRolls[skill.key]}
                  <em class:nat-one={skillRolls[skill.key].natural === 1} class:nat-twenty={skillRolls[skill.key].natural === 20}>{skillRolls[skill.key].text}</em>
                {/if}
              </label>
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
    <div class="modal-backdrop" role="presentation">
      <div class="panel compact-modal" role="dialog" aria-modal="true" aria-labelledby="roll-result-title">
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

  {#if inventoryMessage}
    <div class="modal-backdrop" role="presentation">
      <div class="panel compact-modal" role="dialog" aria-modal="true" aria-labelledby="inventory-action-title">
        <div class="panel-head">
          <h2 id="inventory-action-title">Inventory Action</h2>
          <button type="button" class="text-button" onclick={() => (inventoryMessage = null)}>Close</button>
        </div>
        <p class="muted">{inventoryMessage}</p>
      </div>
    </div>
  {/if}

  {#if newItemOpen}
    <div class="modal-backdrop" role="presentation">
      <div class="panel item-modal" role="dialog" aria-modal="true" aria-labelledby="new-item-title">
        <div class="panel-head">
          <h2 id="new-item-title">Add Item</h2>
          <button type="button" class="text-button" onclick={() => (newItemOpen = false)}>Close</button>
        </div>
        <div class="new-item-grid">
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
