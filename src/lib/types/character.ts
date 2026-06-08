export type AbilityKey = 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';

export type CharacterAbility = {
  key: AbilityKey;
  score: number;
};

export type CharacterClass = {
  className: string;
  level: number;
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
  damageRolls: string;
  effects: string;
  abilityBonuses: Partial<Record<AbilityKey, number>>;
  notes: string;
};

export type ItemCategory = {
  key: string;
  label: string;
};

export type EffectModifier = {
  target: string;
  modifierType: string;
  valueExpression: string;
  conditionExpression: string;
  priority: number;
};

export type EffectDefinition = {
  id: string;
  key: string;
  name: string;
  sourceType: string;
  sourceRef: string;
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
  activeEffects: ActiveCharacterEffect[];
  availableEffects: EffectDefinition[];
  exhaustionLevel: number;
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
