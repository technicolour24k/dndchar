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
  quantity: number;
  equipped: boolean;
  acBonus: number;
  abilityBonuses: Partial<Record<AbilityKey, number>>;
  notes: string;
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
