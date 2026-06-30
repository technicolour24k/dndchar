import type { AbilityKey, ActiveCharacterEffect, CharacterAbility, CharacterClass } from '$lib/types/character';

export const abilityKeys: AbilityKey[] = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

export function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

export function totalLevel(classes: CharacterClass[]): number {
  const total = classes.reduce((sum, row) => sum + Math.max(0, Number(row.level) || 0), 0);
  return Math.max(1, total);
}

export function proficiencyBonus(level: number): number {
  return 2 + Math.floor((Math.max(1, level) - 1) / 4);
}

export function abilityMap(abilities: CharacterAbility[]): Record<AbilityKey, number> {
  const map = Object.fromEntries(abilityKeys.map((key) => [key, 10])) as Record<AbilityKey, number>;
  for (const ability of abilities) {
    map[ability.key] = Number(ability.score) || 10;
  }
  return map;
}

export function skillModifier(score: number, proficient: boolean, level: number): number {
  return abilityModifier(score) + (proficient ? proficiencyBonus(level) : 0);
}

export function savingThrowModifier(score: number, proficient: boolean, level: number): number {
  return skillModifier(score, proficient, level);
}

export function clampResource(currentValue: number, maxValue: number): number {
  return Math.max(0, Math.min(Number(currentValue) || 0, Math.max(0, Number(maxValue) || 0)));
}

const classHitDice: Record<string, number> = {
  artificer: 8,
  barbarian: 12,
  bard: 8,
  cleric: 8,
  druid: 8,
  fighter: 10,
  monk: 8,
  paladin: 10,
  ranger: 10,
  rogue: 8,
  sorcerer: 6,
  warlock: 8,
  wizard: 6
};

export function classHitDie(className: string): number {
  return classHitDice[className.trim().toLowerCase()] ?? 8;
}

export function hitDiceSummary(classes: CharacterClass[]): string {
  const grouped = new Map<number, number>();
  for (const row of classes) {
    const die = classHitDie(row.className);
    grouped.set(die, (grouped.get(die) ?? 0) + Math.max(0, Number(row.level) || 0));
  }

  return [...grouped.entries()]
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => right - left)
    .map(([die, count]) => `${count}d${die}`)
    .join(', ');
}

export type ModifierContext = {
  classes?: CharacterClass[];
  attackType?: 'melee_weapon' | 'ranged_weapon' | 'spell' | 'weapon';
  ability?: AbilityKey;
  flags?: string[];
};

export type ResolvedBonus = {
  label: string;
  value: number;
};

export type ModifierAuditEntry = ResolvedBonus & {
  effectName: string;
  sourceName: string;
  target: string;
  modifierType: string;
  valueExpression: string;
  conditionExpression: string;
  priority: number;
};

export function modifierTargetMatches(target: string, candidates: string[]) {
  return candidates.some((candidate) => {
    if (target === candidate) return true;
    if (target.endsWith('.all')) return candidate.startsWith(target.slice(0, -4));
    return false;
  });
}

export function barbarianRageDamageBonus(classes: CharacterClass[] = []): number {
  const barbarianLevel = classes
    .filter((row) => row.className.toLowerCase() === 'barbarian')
    .reduce((sum, row) => sum + Math.max(0, Number(row.level) || 0), 0);

  if (barbarianLevel >= 16) return 4;
  if (barbarianLevel >= 9) return 3;
  if (barbarianLevel >= 1) return 2;
  return 0;
}

export function resolveModifierNumericValue(valueExpression: string | null | undefined, context: ModifierContext = {}) {
  if (!valueExpression) return 0;
  if (valueExpression === 'rage_damage_bonus') return barbarianRageDamageBonus(context.classes);
  const numeric = Number(valueExpression);
  return Number.isFinite(numeric) ? numeric : 0;
}

export function resolvedNumericModifiers(
  effects: ActiveCharacterEffect[],
  candidates: string[],
  modifierTypes: string[],
  context: ModifierContext = {}
): ResolvedBonus[] {
  return effects.flatMap((effect) =>
    effect.modifiers
      .filter((modifier) => modifierTypes.includes(modifier.modifierType) && modifierTargetMatches(modifier.target, candidates)
        && modifierConditionMatches(modifier.conditionExpression,context))
      .map((modifier) => ({
        label: effect.name,
        value: resolveModifierNumericValue(modifier.valueExpression, context),
        priority:modifier.priority
      }))
      .filter((bonus) => bonus.value !== 0 || modifierTypes.includes('set'))
  ).sort((left,right)=>left.priority-right.priority).map(({label,value})=>({label,value}));
}

export function modifierConditionMatches(expression:string,context:ModifierContext={}):boolean{
  const condition=expression.trim().toLowerCase();if(!condition)return true;
  return condition.split(/\s*&&\s*/).every((part)=>{
    if(part==='always')return true;
    if(part.startsWith('class:'))return (context.classes||[]).some((row)=>row.className.toLowerCase()===part.slice(6));
    if(part.startsWith('ability:'))return context.ability===part.slice(8);
    if(part.startsWith('attack:'))return context.attackType===part.slice(7);
    if(part.startsWith('flag:'))return (context.flags||[]).includes(part.slice(5));
    return false;
  });
}

// modifier-primacy.md §3.3 — advantage/disadvantage is a dice pool, not a binary state.
// Net = advantage sources - disadvantage sources (within one bucket). Pool size = 1 + |net|;
// canceled sources contribute nothing to the pool. Sign of net picks the take-highest /
// take-lowest direction; net 0 is a true flat 1-die roll, not "normal" because nothing happened.
export type DicePoolResolution = {
  advantageCount: number;
  disadvantageCount: number;
  net: number;
  poolSize: number;
  direction: 'highest' | 'lowest' | 'flat';
};

export function resolveDicePool(advantageCount: number, disadvantageCount: number): DicePoolResolution {
  const net = advantageCount - disadvantageCount;
  const poolSize = 1 + Math.abs(net);
  const direction = net > 0 ? 'highest' : net < 0 ? 'lowest' : 'flat';
  return { advantageCount, disadvantageCount, net, poolSize, direction };
}

export function rollD20Pool(
  poolSize: number,
  direction: 'highest' | 'lowest' | 'flat',
  rollDie: (sides: number) => number = (sides) => Math.floor(Math.random() * sides) + 1
): { rolls: number[]; chosen: number } {
  const rolls = Array.from({ length: Math.max(1, poolSize) }, () => rollDie(20));
  const chosen = direction === 'lowest' ? Math.min(...rolls) : Math.max(...rolls);
  return { rolls, chosen };
}

function countAdvantageSources(effects: ActiveCharacterEffect[], candidates: string[], context: ModifierContext = {}) {
  let advantageCount = 0, disadvantageCount = 0;
  for (const effect of effects) for (const modifier of effect.modifiers) {
    if (!modifierTargetMatches(modifier.target, candidates) || !modifierConditionMatches(modifier.conditionExpression, context)) continue;
    if (modifier.modifierType === 'advantage') advantageCount += 1;
    if (modifier.modifierType === 'disadvantage') disadvantageCount += 1;
  }
  return { advantageCount, disadvantageCount };
}

// Convenience label derived from the dice pool's net sign, for callers that only need a
// three-state summary (e.g. a small UI badge) rather than the full pool breakdown.
export function resolveAdvantageState(effects:ActiveCharacterEffect[],candidates:string[],context:ModifierContext={}):'advantage'|'disadvantage'|'normal'{
  const {advantageCount,disadvantageCount}=countAdvantageSources(effects,candidates,context);
  const {net}=resolveDicePool(advantageCount,disadvantageCount);
  return net>0?'advantage':net<0?'disadvantage':'normal';
}

export function resolvedFlatBonuses(
  effects: ActiveCharacterEffect[],
  candidates: string[],
  context: ModifierContext = {}
): ResolvedBonus[] {
  return resolvedNumericModifiers(effects, candidates, ['bonus'], context);
}

export function resolvedAdditiveModifiers(
  effects: ActiveCharacterEffect[], candidates: string[], context: ModifierContext = {}
): ResolvedBonus[] {
  return [
    ...resolvedNumericModifiers(effects, candidates, ['bonus'], context),
    ...resolvedNumericModifiers(effects, candidates, ['penalty'], context).map((entry) => ({ ...entry, value: -entry.value }))
  ];
}

export function modifierAudit(
  effects: ActiveCharacterEffect[],
  candidates: string[],
  modifierTypes: string[],
  context: ModifierContext = {}
): ModifierAuditEntry[] {
  return effects.flatMap((effect) =>
    effect.modifiers
      .filter((modifier) => modifierTypes.includes(modifier.modifierType) && modifierTargetMatches(modifier.target, candidates))
      .map((modifier) => ({
        label: effect.name,
        value: resolveModifierNumericValue(modifier.valueExpression, context),
        effectName: effect.name,
        sourceName: effect.sourceName,
        target: modifier.target,
        modifierType: modifier.modifierType,
        valueExpression: modifier.valueExpression,
        conditionExpression: modifier.conditionExpression,
        priority: modifier.priority
      }))
  );
}

const multiclassSpellSlots: number[][] = [
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [2, 0, 0, 0, 0, 0, 0, 0, 0], [3, 0, 0, 0, 0, 0, 0, 0, 0], [4, 2, 0, 0, 0, 0, 0, 0, 0],
  [4, 3, 0, 0, 0, 0, 0, 0, 0], [4, 3, 2, 0, 0, 0, 0, 0, 0], [4, 3, 3, 0, 0, 0, 0, 0, 0],
  [4, 3, 3, 1, 0, 0, 0, 0, 0], [4, 3, 3, 2, 0, 0, 0, 0, 0], [4, 3, 3, 3, 1, 0, 0, 0, 0],
  [4, 3, 3, 3, 2, 0, 0, 0, 0], [4, 3, 3, 3, 2, 1, 0, 0, 0], [4, 3, 3, 3, 2, 1, 0, 0, 0],
  [4, 3, 3, 3, 2, 1, 1, 0, 0], [4, 3, 3, 3, 2, 1, 1, 0, 0], [4, 3, 3, 3, 2, 1, 1, 1, 0],
  [4, 3, 3, 3, 2, 1, 1, 1, 0], [4, 3, 3, 3, 2, 1, 1, 1, 1], [4, 3, 3, 3, 3, 1, 1, 1, 1],
  [4, 3, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 3, 2, 2, 1, 1]
];

const fullCasters = new Set(['bard', 'cleric', 'druid', 'sorcerer', 'wizard']);
const halfCasters = new Set(['paladin', 'ranger']);

export function effectiveCasterLevel(classes: CharacterClass[]): number {
  return Math.min(20, classes.reduce((sum, row) => {
    const name = row.className.trim().toLowerCase();
    const subclass = (row.subclassName || '').trim().toLowerCase();
    const classLevel = Math.max(0, Number(row.level) || 0);
    if (fullCasters.has(name)) return sum + classLevel;
    if (name === 'artificer') return sum + Math.ceil(classLevel / 2);
    if (halfCasters.has(name)) return sum + Math.floor(classLevel / 2);
    if ((name === 'fighter' && subclass === 'eldritch knight') || (name === 'rogue' && subclass === 'arcane trickster')) {
      return sum + Math.floor(classLevel / 3);
    }
    return sum;
  }, 0));
}

export function standardSpellSlotMaximums(classes: CharacterClass[]): number[] {
  return [...multiclassSpellSlots[effectiveCasterLevel(classes)]];
}

export function pactMagicSlots(classes: CharacterClass[]): { level: number; slots: number } {
  const level = Math.min(20, classes.filter((row) => row.className.trim().toLowerCase() === 'warlock')
    .reduce((sum, row) => sum + Math.max(0, Number(row.level) || 0), 0));
  if (!level) return { level: 0, slots: 0 };
  return {
    level: level >= 9 ? 5 : level >= 7 ? 4 : level >= 5 ? 3 : level >= 3 ? 2 : 1,
    slots: level >= 17 ? 4 : level >= 11 ? 3 : level >= 2 ? 2 : 1
  };
}

export function spellSaveDc(score: number, level: number, bonuses: number[] = []): number {
  return 8 + abilityModifier(score) + proficiencyBonus(level) + bonuses.reduce((sum, value) => sum + value, 0);
}

export function spellAttackBonus(score: number, level: number, bonuses: number[] = []): number {
  return abilityModifier(score) + proficiencyBonus(level) + bonuses.reduce((sum, value) => sum + value, 0);
}

export function resolveResourceMaximum(expression: string, context: { level?: number; proficiencyBonus?: number; abilityModifier?: number } = {}): number {
  const normalized = expression.trim().toLowerCase();
  if (/^\d+$/.test(normalized)) return Number(normalized);
  if (normalized === 'level') return Math.max(0, context.level || 0);
  if (normalized === 'proficiency_bonus') return Math.max(0, context.proficiencyBonus || 0);
  if (normalized === 'ability_modifier') return Math.max(0, context.abilityModifier || 0);
  return 0;
}

export function rollDiceExpression(expression:string,rollDie:(sides:number)=>number=(sides)=>Math.floor(Math.random()*sides)+1):number{
  return (expression.replace(/\s+/g,'').match(/[+-]?[^+-]+/g)||[]).reduce((total,raw)=>{
    const sign=raw.startsWith('-')?-1:1;
    const term=raw.replace(/^[+-]/,'');
    const dice=term.match(/^(\d*)d(\d+)$/i);
    if(dice){const count=Math.max(1,Number(dice[1])||1);const sides=Math.max(1,Number(dice[2])||1);
      return total+sign*Array.from({length:count},()=>rollDie(sides)).reduce((sum,value)=>sum+value,0);}
    return total+sign*(Number(term)||0);
  },0);
}
