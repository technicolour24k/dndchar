import type { AbilityKey } from '$lib/types/character';

export type ContentType = 'item' | 'spell' | 'feat' | 'class_feature' | 'condition' | 'action';
export type ContainerActivationType = 'passive' | 'triggered' | 'active_use';
export type ActivationType = 'carried' | 'equipped' | 'attuned' | 'on_use' | 'manual';
export type RechargePeriod = 'short_rest' | 'long_rest' | 'dawn' | 'round' | 'encounter' | 'manual';
export type DurationType = 'instant' | 'rounds' | 'encounter' | 'concentration' | 'indefinite' | 'permanent';
export type StackBehavior = 'refresh' | 'stack' | 'reject';
export type ExpiryBoundary = 'turn_start' | 'turn_end' | 'round_end' | 'manual';

/** Structured cost entry — one pool and how much of it is consumed. */
export type ContainerCostEntry = {
  pool: string;
  amount: number;
  level?: number; // for spell slots: the slot level required
};

export type ContentEffectLink = {
  effectId: string;
  effectName: string;
  activationType: ActivationType;
};

export type ContentResourceDefinition = {
  id: string;
  key: string;
  label: string;
  maxValueExpression: string;
  rechargePeriod: RechargePeriod;
};

export type ContentDefinition = {
  id: string;
  key: string;
  type: ContentType;
  name: string;
  description: string;
  sourceKind: 'srd' | 'homebrew';
  sourceRef: string;
  ownerUserId: string | null;
  isArchived: boolean;
  isSystem: boolean;
  metadata: Record<string, unknown>;
  // Container-level fields (populated for all types after migration 019)
  activationType: ContainerActivationType;
  costJson: ContainerCostEntry[] | null;
  durationData: {
    type: DurationType | null;
    rounds: number | null;
    requiresConcentration: boolean;
    expiryBoundary: ExpiryBoundary | null;
    stackBehavior: StackBehavior;
  };
  spell?: {
    level: number;
    school: string;
    castingTime: string;
    range: string;
    components: string;
    duration: string;
    ritual: boolean;
    concentration: boolean;
    classes: string[];
    higherLevel: string;
  };
  item?: {
    category: string;
    equipmentType: string;
    requiresAttunement: boolean;
    acBonus: number;
    toHitBonus: number;
    damageBonus: number;
    attackAbility: AbilityKey;
    damageRolls: string;
  };
  effects: ContentEffectLink[];
  resources: ContentResourceDefinition[];
};

export type CharacterContentInstance = {
  id: string;
  contentId: string;
  type: ContentType;
  name: string;
  description: string;
  isKnown: boolean;
  isPrepared: boolean;
  isActive: boolean;
  notes: string;
  spellLevel: number | null;
  grantedBy?: string;
  spellAccessId?: string;
  inventoryItemId?: string;
  hasResourceActions?: boolean;
  resources: Array<ContentResourceDefinition & { currentValue: number; maxValue: number }>;
};

export type SpellSlot = {
  type: 'standard' | 'pact';
  level: number;
  current: number;
  max: number;
};
