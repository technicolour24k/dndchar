export type RuleHook = {
  key: string;
  label: string;
  category: string;
  valueKind: 'none' | 'number' | 'dice' | 'formula' | 'text';
  runtimeSupported: boolean;
  description: string;
  isArchived: boolean;
  isSystem: boolean;
};

export type ModifierOperation =
  | 'bonus' | 'penalty' | 'set' | 'multiplier' | 'advantage' | 'disadvantage'
  | 'extra_die' | 'resistance' | 'vulnerability' | 'immunity' | 'grant' | 'block'
  | 'condition_apply' | 'condition_remove' | 'formula_override';

export type Modifier = {
  id: string;
  ruleHook: RuleHook;
  operation: ModifierOperation;
  baseValue: string;
  label: string;
  description: string;
  isArchived: boolean;
  isSystem: boolean;
};

export type AppliedModifier = {
  id: string;
  modifierId: string;
  ownerType: 'effect' | 'content';
  ownerId: string;
  activationType?: string;
  entrySpecificValue: string;
  condition: string;
  priority: number;
  sortOrder: number;
};

export type ResolvedModifier = {
  sourceId: string;
  sourceType: 'effect' | 'content' | 'item' | 'grant';
  sourceName: string;
  attachmentId: string;
  modifierId: string;
  target: string;
  operation: ModifierOperation;
  valueExpression: string;
  conditionExpression: string;
  priority: number;
  runtimeSupported: boolean;
};

export type EffectStackBehavior = 'refresh' | 'stack' | 'reject';

export type ActionStepType =
  | 'resource_change' | 'damage' | 'healing' | 'apply_effect' | 'remove_effect'
  | 'spend_resource' | 'spend_item' | 'roll_output';

export type ActionStep = {
  id: string;
  type: ActionStepType;
  operation: string;
  targetType: string;
  targetKey: string;
  valueExpression: string;
  effectId: string | null;
  targetMode: 'self' | 'external_roll';
  label: string;
  sortOrder: number;
};

export type ActionDefinition = {
  id: string;
  key: string;
  name: string;
  description: string;
  isArchived: boolean;
  isSystem: boolean;
  steps: ActionStep[];
};

export type ContentSpellAccess = {
  id: string;
  ownerContentId: string;
  spellContentId: string;
  spellName: string;
  accessType: 'charges' | 'limited_free' | 'at_will' | 'character_slots';
  availabilityType: string;
  resourceDefinitionId: string | null;
  resourceCostExpression: string;
  castLevelMode: 'spell_level' | 'fixed' | 'charges_spent' | 'selected_slot';
  fixedCastLevel: number | null;
  saveDcMode: 'character' | 'fixed';
  fixedSaveDc: number | null;
  spellAttackMode: 'character' | 'fixed';
  fixedSpellAttackBonus: number | null;
};
