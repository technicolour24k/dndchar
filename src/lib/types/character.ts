export type AbilityKey = 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';

export type CharacterAbility = {
  key: AbilityKey;
  score: number;
};

export type CharacterClass = {
  className: string;
  level: number;
  subclassName?: string;
  spellcastingAbility?: AbilityKey | null;
};

export type CharacterResource = {
  key: string;
  label: string;
  currentValue: number;
  maxValue: number;
};

export type InventoryItem = {
  id?: string;
  name: string;
  category: string;
  location: 'equipped' | 'backpack' | 'misc';
  quantity: number;
  equipped: boolean;
  isEquipment: boolean;
  acBonus: number;
  toHitBonus: number;
  damageBonus: number;
  attackAbility: AbilityKey;
  proficient: boolean;
  sourceContentId?: string | null;
  attuned?: boolean;
  damageRolls: string;
  effects: string;
  abilityBonuses: Partial<Record<AbilityKey, number>>;
  notes: string;
  resources?: Array<{id:string;key:string;label:string;currentValue:number;maxValue:number;rechargePeriod:string}>;
};

export type ItemCategory = {
  key: string;
  label: string;
};

export type EffectModifier = {
  target: string;
  modifierType: string;
  valueExpression: string;
  defaultValueExpression: string;
  valueOverrideExpression: string;
  conditionExpression: string;
  priority: number;
};

export type EffectDefinition = {
  id: string;
  key: string;
  name: string;
  sourceType: string;
  sourceRef: string;
  sourceName: string;
  description: string;
  durationType: string;
  durationRounds: number | null;
  requiresConcentration: boolean;
  isCondition: boolean;
  isSelectable: boolean;
  modifiers: EffectModifier[];
};

export type ActiveCharacterEffect = {
  id: string;
  effectId: string;
  effectKey: string;
  name: string;
  sourceType: string;
  sourceName: string;
  description: string;
  durationType: string;
  requiresConcentration: boolean;
  isCondition: boolean;
  isSelectable: boolean;
  remainingRounds: number | null;
  modifiers: EffectModifier[];
};

export type CharacterAttack = {
  id?: string;
  name: string;
  attackAbility: AbilityKey;
  proficient: boolean;
  damageDice: string;
  notes: string;
};

export type CharacterNote = {
  key: string;
  title: string;
  content: string;
};

export type CharacterProficiencies = {
  savingThrows: AbilityKey[];
  skills: string[];
  weapons: string[];
};

export type CharacterDetail = {
  id: string;
  ownerUserId: string;
  name: string;
  ancestry: string;
  background: string;
  systemKey: string;
  metadata: Record<string, unknown>;
  classes: CharacterClass[];
  abilities: CharacterAbility[];
  resources: CharacterResource[];
  inventory: InventoryItem[];
  attacks: CharacterAttack[];
  notes: CharacterNote[];
  proficiencies: CharacterProficiencies;
  activeEffects: ActiveCharacterEffect[];
  modifierSources: ActiveCharacterEffect[];
  modifierAudit: import('$lib/types/rules').ResolvedModifier[];
  availableEffects: EffectDefinition[];
  exhaustionLevel: number;
  content: import('$lib/types/content').CharacterContentInstance[];
  spellSlots: import('$lib/types/content').SpellSlot[];
  combatClock: { roundNumber: number; turnNumber: number };
  updatedAt: string;
};

export type CharacterListItem = {
  id: string;
  name: string;
  ancestry: string;
  background: string;
  systemKey: string;
  classes: CharacterClass[];
  hpCurrent: number;
  hpMax: number;
  updatedAt: string;
};

export type CharacterVersion = {
  id: string;
  characterId: string;
  createdAt: string;
  changeSummary: string;
};
