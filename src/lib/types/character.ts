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

export type CharacterPool = {
  key: string;
  label: string;
  current: number;
  max: number;
  rechargePeriod: string;
  /** Source-attributed lines for the max: Base, then each grant. */
  breakdown: Array<{ label: string; value: number }>;
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
  /** Muted cost chip for an item with an explicit cost (display only; never posted back). */
  costSummary?: string;
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
  label: string;
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
  // content_key of the Container this source came from (e.g. 'condition:condition_poisoned'),
  // used to avoid counting the same condition twice (sheet + token). Absent on legacy sources.
  containerKey?: string;
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
  campaignId: string | null;
  campaignName: string | null;
  partyActive: boolean;
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
  /** Character resource pools (Soulfire, Vowfire, ...) with live maxima. Only the visible ones. */
  pools: CharacterPool[];
  updatedAt: string;
  /** Bumped by every whole-sheet write; the sheet posts it back with Save (stale-save guard). */
  sheetVersion: number;
};

export type CharacterListItem = {
  id: string;
  campaignId: string | null;
  campaignName: string | null;
  partyActive: boolean;
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
