import type { AbilityKey, ActiveCharacterEffect, CharacterAbility, CharacterClass, EffectModifier, InventoryItem } from '$lib/types/character';

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
  // modifier-primacy.md §6.4 - named outcomes a prior triggering roll satisfied (e.g.
  // 'critical_hit'), so a dependent roll's Modifiers can condition on "on:<outcome>". Open-ended:
  // any roll type can register its own outcome names without changing how conditions check them.
  outcomes?: string[];
  // Distance in feet between attacker and target (VTT only). Lets a condition like
  // "within:5" / "beyond:5" gate a modifier (e.g. Prone: adv in melee, dis from range). Left
  // undefined when the distance isn't known, in which case both predicates are false.
  distanceFt?: number;
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
    // Slice off only "all" (not the dot) so 'attack_roll.all' matches 'attack_roll.weapon' but
    // never a differently named family like 'attack_roll_against.x' that merely shares a prefix.
    if (target.endsWith('.all')) return candidate.startsWith(target.slice(0, -3));
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

// modifier-primacy.md §2.1 - "Derived from a sibling": a value computed at resolution time from
// another Modifier instance on the SAME Container, rather than from the character or a fixed
// value. Encoded as `sibling:<transform>:<target>` so new transforms (e.g. 'current', 'half_max')
// can be added later without changing how a sibling is referenced. A sibling reference never
// resolves to another sibling reference - that disambiguates self when both share a target and
// keeps the mechanism single-hop (no chains) without depending on object identity to exclude self.
const SIBLING_VALUE_PATTERN = /^sibling:(\w+):(.+)$/;

function maxPossibleValue(valueExpression: string): number {
  const dice = valueExpression.match(/^(\d*)d(\d+)$/i);
  if (dice) return Math.max(1, Number(dice[1]) || 1) * Number(dice[2]);
  const numeric = Number(valueExpression);
  return Number.isFinite(numeric) ? numeric : 0;
}

function resolveSiblingDerivedValue(transform: string, targetRef: string, siblings: EffectModifier[], self: EffectModifier | null): number {
  const sibling = siblings.find((entry) => entry !== self && entry.target === targetRef && !entry.valueExpression.startsWith('sibling:'));
  if (!sibling) return 0;
  if (transform === 'max') return maxPossibleValue(sibling.valueExpression);
  return 0;
}

export function resolveModifierNumericValue(
  valueExpression: string | null | undefined,
  context: ModifierContext = {},
  siblings: EffectModifier[] = [],
  self: EffectModifier | null = null
) {
  if (!valueExpression) return 0;
  if (valueExpression === 'rage_damage_bonus') return barbarianRageDamageBonus(context.classes);
  const siblingMatch = valueExpression.match(SIBLING_VALUE_PATTERN);
  if (siblingMatch) return resolveSiblingDerivedValue(siblingMatch[1], siblingMatch[2], siblings, self);
  const numeric = Number(valueExpression);
  return Number.isFinite(numeric) ? numeric : 0;
}

export function resolvedNumericModifiers(
  effects: ActiveCharacterEffect[],
  candidates: string[],
  modifierTypes: string[],
  context: ModifierContext = {}
): ResolvedBonus[] {
  const flagged = withStatusFlags(context, effects);
  return effects.flatMap((effect) =>
    effect.modifiers
      .filter((modifier) => modifierTypes.includes(modifier.modifierType) && modifierTargetMatches(modifier.target, candidates)
        && modifierConditionMatches(modifier.conditionExpression,flagged))
      .map((modifier) => ({
        label: modifier.label?.trim() || effect.name,
        value: resolveModifierNumericValue(modifier.valueExpression, context, effect.modifiers, modifier),
        priority:modifier.priority
      }))
      .filter((bonus) => bonus.value !== 0 || modifierTypes.includes('set'))
  ).sort((left,right)=>left.priority-right.priority).map(({label,value})=>({label,value}));
}

// Status flags for "flag:<name>" conditions: every active effect on the character (Raging, Hidden,
// Cover, ...) raises a flag named after it, lower-cased, with spaces as underscores too
// ("Half Cover" -> "half cover" and "half_cover"), plus its effect key. So a weapon damage bonus
// with condition "flag:raging" only applies while the Raging effect is active.
export function statusFlagsOf(effects:Array<{name?:string;effectKey?:string}>):string[]{
  const flags=new Set<string>();
  for(const effect of effects){
    for(const raw of [effect.name,effect.effectKey]){
      const value=(raw||'').trim().toLowerCase();if(!value)continue;
      flags.add(value);flags.add(value.replace(/\s+/g,'_'));
    }
  }
  return [...flags];
}
// The context with the effects' status flags added to any flags it already carries.
export function withStatusFlags(context:ModifierContext,effects:Array<{name?:string;effectKey?:string}>):ModifierContext{
  return {...context,flags:[...new Set([...(context.flags||[]),...statusFlagsOf(effects)])]};
}

export function modifierConditionMatches(expression:string,context:ModifierContext={}):boolean{
  const condition=expression.trim().toLowerCase();if(!condition)return true;
  return condition.split(/\s*&&\s*/).every((part)=>{
    if(part==='always')return true;
    if(part.startsWith('class:'))return (context.classes||[]).some((row)=>row.className.toLowerCase()===part.slice(6));
    if(part.startsWith('ability:'))return context.ability===part.slice(8);
    if(part.startsWith('attack:'))return context.attackType===part.slice(7);
    if(part.startsWith('flag:'))return (context.flags||[]).includes(part.slice(5));
    // modifier-primacy.md §6.4 - "on:<outcome>" checks the named outcomes a prior triggering
    // roll produced (e.g. 'on:critical_hit'). Generic over any outcome name; new roll types
    // register new outcome strings without this predicate changing.
    if(part.startsWith('on:'))return (context.outcomes||[]).includes(part.slice(3));
    // "within:<n>" / "beyond:<n>" - distance gates (feet). Unknown distance is false for both,
    // so a distance-gated modifier never fires on a roll with no token context (e.g. the sheet).
    if(part.startsWith('within:')||part.startsWith('beyond:')){
      const limit=Number(part.slice(part.indexOf(':')+1));
      if(!Number.isFinite(limit)||typeof context.distanceFt!=='number'||!Number.isFinite(context.distanceFt))return false;
      return part.startsWith('within:')?context.distanceFt<=limit:context.distanceFt>limit;
    }
    return false;
  });
}

// modifier-primacy.md §6.4 - phase 1 of a two-phase roll: turn a resolved d20 into the named,
// open-ended set of outcomes it satisfied. Not a crit-only boolean - any future roll type can
// compute its own outcome strings (e.g. 'beat_dc_by_5') and feed them through the same
// `context.outcomes` / "on:<outcome>" condition-check plumbing without this function changing.
export function resolveD20Outcomes(natural: number, critThreshold = 20): string[] {
  const outcomes: string[] = [];
  if (natural === 1) outcomes.push('critical_miss');
  if (natural >= critThreshold) outcomes.push('critical_hit');
  return outcomes;
}

// 5e death saving throw. `natural` is the KEPT d20 (so a net-advantage pool uses the die that
// counts) and `total` is the whole roll including bonuses (Bless, flat save bonuses). Per RAW the
// total is compared against 10: 10 or higher is a success, below 10 a failure. A natural 1 on the
// kept die is two failures and a natural 20 means the character regains 1 HP and both counters
// reset, whatever the bonuses. Counters cap at 3; rolling at 3 is allowed, it just stays capped.
// This only SUGGESTS the new counters - the sheet applies them like a manual icon click, so the
// player can still correct them.
export type DeathSaveResult = {
  successes: number;
  failures: number;
  kind: 'success' | 'failure' | 'critical_failure' | 'revived';
  regainHp: boolean;
};

export function resolveDeathSave(natural: number, total: number, successes: number, failures: number): DeathSaveResult {
  const cap = (value: number) => Math.max(0, Math.min(3, value));
  if (natural === 20) return { successes: 0, failures: 0, kind: 'revived', regainHp: true };
  if (natural === 1) return { successes: cap(successes), failures: cap(failures + 2), kind: 'critical_failure', regainHp: false };
  if (total >= 10) return { successes: cap(successes + 1), failures: cap(failures), kind: 'success', regainHp: false };
  return { successes: cap(successes), failures: cap(failures + 1), kind: 'failure', regainHp: false };
}

// Extensibility hook for crit-range-altering Modifiers (e.g. a Champion Fighter's 19-20 crit
// range), targeting `crit_threshold.all` with a 'penalty' lowering the natural-20 threshold. No
// seed content uses this yet, so it's always a no-op (threshold 20) until something does.
export function resolveCritThreshold(effects: ActiveCharacterEffect[], context: ModifierContext = {}): number {
  const lowering = resolvedNumericModifiers(effects, ['crit_threshold.all'], ['penalty'], context)
    .reduce((sum, bonus) => sum + bonus.value, 0);
  return Math.max(1, 20 - lowering);
}

export type ExtraDieResult = { label: string; expression: string; rolls: number[]; value: number };

// Shared by any roll that needs to resolve 'extra_die' Modifiers (Bless's 1d4, a weapon's own
// base damage die, etc.) with condition-awareness - including outcome-gated conditions, so a
// Container's base damage die and an "on:critical_hit"-gated companion die both flow through
// the same path.
export function resolveExtraDiceRolls(
  effects: ActiveCharacterEffect[],
  candidates: string[],
  context: ModifierContext = {},
  rollDie: (sides: number) => number = (sides) => Math.floor(Math.random() * sides) + 1
): ExtraDieResult[] {
  const flagged = withStatusFlags(context, effects);
  return effects.flatMap((effect) =>
    effect.modifiers
      .filter((modifier) => modifier.modifierType === 'extra_die' && modifierTargetMatches(modifier.target, candidates)
        && modifierConditionMatches(modifier.conditionExpression, flagged))
      .map((modifier): ExtraDieResult => {
        const label = modifier.label?.trim() || effect.name;
        const match = modifier.valueExpression.match(/^(\d*)d(\d+)$/i);
        if (!match) return { label, expression: modifier.valueExpression, rolls: [], value: 0 };
        const count = Math.max(1, Number(match[1]) || 1);
        const rolls = Array.from({ length: count }, () => rollDie(Number(match[2])));
        return { label, expression: modifier.valueExpression, rolls, value: rolls.reduce((sum, roll) => sum + roll, 0) };
      })
  );
}

// HOMEBREW crit rule (deliberately NOT 5e's "double the dice"): on a critical hit, roll the damage
// dice normally, then add the MAXIMUM of the weapon's/spell's own PRIMARY dice once on top. Nothing
// is doubled, flat bonuses are untouched, and secondary dice (an extra 1d4 poison, sneak attack,
// modifier-granted extra dice) are NOT maximised. So 2d8 + 1d4 + 4 on a crit is 2d8 + 1d4 + 4 + 16.
// "Primary dice" uses the same rule as the interim manual damage-dice control: the die size of the
// first dice term in the expression, with every term of that size merged (so a scaled cantrip's
// "1d10 + 1d10" counts as 2d10). Pass the expression AFTER any manual adjustment, so a +1 manual
// die is maximised too. Used by rollDamage whenever it is told the hit was critical.
export function critMaxDiceBonus(expression: string): { bonus: number; auditLine: string | null } {
  const diceTerms = expression
    .split('+')
    .map((term) => term.trim().match(/^(\d*)d(\d+)$/i))
    .filter((match): match is RegExpMatchArray => match !== null);
  if (diceTerms.length === 0) return { bonus: 0, auditLine: null };
  const primarySides = Number(diceTerms[0][2]);
  const primaryCount = diceTerms
    .filter((match) => Number(match[2]) === primarySides)
    .reduce((sum, match) => sum + Math.max(1, Number(match[1]) || 1), 0);
  const bonus = primaryCount * primarySides;
  if (bonus === 0) return { bonus: 0, auditLine: null };
  return { bonus, auditLine: `Crit (homebrew max dice): +${bonus} (${primaryCount}d${primarySides} max)` };
}

// modifier-primacy.md §3.3 - advantage/disadvantage is a dice pool, not a binary state.
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
  const flagged = withStatusFlags(context, effects);
  for (const effect of effects) for (const modifier of effect.modifiers) {
    if (!modifierTargetMatches(modifier.target, candidates) || !modifierConditionMatches(modifier.conditionExpression, flagged)) continue;
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

// The optional 4th param lets a caller supply an already-resolved proficiency bonus (e.g. one
// carrying its own manual adjustment/override via characterStats.ts's resolveStat) instead of
// recomputing it from level. Defaults to proficiencyBonus(level), so every existing caller (and
// the existing spellSaveDc(16, 5, [2]) test) is unaffected. Deliberately a separate 4th param
// rather than repurposing `level`, so a caller can't silently swap level for a prof value and
// still typecheck.
export function spellSaveDc(score: number, level: number, bonuses: number[] = [], prof: number = proficiencyBonus(level)): number {
  return 8 + abilityModifier(score) + prof + bonuses.reduce((sum, value) => sum + value, 0);
}

export function spellAttackBonus(score: number, level: number, bonuses: number[] = [], prof: number = proficiencyBonus(level)): number {
  return abilityModifier(score) + prof + bonuses.reduce((sum, value) => sum + value, 0);
}

// Same transform content-admin.ts's private slug() uses for content_key generation -
// duplicated rather than imported since that module pulls in $lib/server/db and this
// file must stay importable from both server and client code.
export function slugifySpellName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'spell';
}

export type SpellDamageScalingInput = {
  kind?: 'cantrip' | 'leveled' | 'none';
  extraDice?: string;
  tiers?: number[];
  extraDicePerSlotLevel?: string | null;
};

export type SpellDamageSource = {
  name: string;
  spellLevel: number;
  resolutionType: 'attack' | 'save' | 'auto';
  damageType: string;
  baseDice: string;
  saveAbility?: AbilityKey;
  saveEffect?: 'half' | 'negate';
  scaling: SpellDamageScalingInput;
};

export type SpellDamageContext = {
  castAtSlotLevel: number;
  casterLevel: number;
  modifierSources: ActiveCharacterEffect[];
  outcomes?: string[];
};

export type SpellDamageProfile = {
  resolution: 'attack' | 'save' | 'auto';
  damageType: string;
  diceExpression: string;
  // Short note on how the dice were scaled, e.g. "cantrip, level 6" or "cast at level 4". Absent
  // when nothing scaled. Display only.
  scalingNote?: string;
  extraDice: ExtraDieResult[];
  flatBonuses: ResolvedBonus[];
  saveAbility?: AbilityKey;
  saveEffect?: 'half' | 'negate';
};

// Display helper: combines like dice terms so scaled expressions read naturally, e.g.
// "1d10 + 1d10" -> "2d10" and "2d6 + 1d4 + 2d6 + 3" -> "4d6 + 1d4 + 3". Each die size appears at the
// position of its first term; flat numbers and anything else are left where they are. Input with
// no dice terms (empty, flat-only) comes back unchanged. Purely cosmetic: the same dice are
// rolled either way. (static/vtt-app/main.js has a display-only twin, mergeDiceTermsJs.)
export function mergeDiceTerms(expression: string): string {
  const parts = expression.split('+').map((part) => part.trim()).filter(Boolean);
  const parsed = parts.map((part) => part.match(/^(\d*)d(\d+)$/i));
  if (!parsed.some((match) => match)) return expression;
  const counts = new Map<number, number>();
  parsed.forEach((match) => {
    if (match) counts.set(Number(match[2]), (counts.get(Number(match[2])) ?? 0) + Math.max(1, Number(match[1]) || 1));
  });
  const emitted = new Set<number>();
  return parts.map((part, index) => {
    const match = parsed[index];
    if (!match) return part;
    const sides = Number(match[2]);
    if (emitted.has(sides)) return '';
    emitted.add(sides);
    return `${counts.get(sides)}d${sides}`;
  }).filter(Boolean).join(' + ');
}

function repeatDiceExpression(expression: string, times: number): string {
  if (times <= 1 || !expression.trim()) return expression;
  return Array.from({ length: times }, () => expression).join(' + ');
}

// modifier-primacy.md - spell damage is a Container/spell baseline (base_dice +
// scaling_json, both on spell_definitions) with ordinary Modifiers layered on top,
// exactly like weapon damage already works via damageCandidatesFor()/battleDamageBonuses()
// in attackRoll.ts. This is what lets a homebrew item/feat later attach a ordinary
// Modifier (extra_die, bonus, or - see below - multiplier) targeting a spell's damage
// without any further engine changes.
//
// Candidate targets are layered general -> specific, same convention as
// damage_roll.weapon -> damage_roll.melee_weapon.<ability>: damage_roll.spell.all,
// damage_roll.spell.<damageType>, damage_roll.spell.<name-slug> - the last one is how
// a modifier can target one specific named spell (e.g. "doubles Sleep's dice").
export function resolveSpellDamage(spell: SpellDamageSource, ctx: SpellDamageContext): SpellDamageProfile {
  const scaling = spell.scaling || {};
  let diceExpression = spell.baseDice;
  let scalingNote: string | undefined;

  if (scaling.kind === 'cantrip' && scaling.extraDice) {
    const tiersCrossed = (scaling.tiers || []).filter((tier) => ctx.casterLevel >= tier).length;
    diceExpression = [diceExpression, ...Array(tiersCrossed).fill(scaling.extraDice)].filter(Boolean).join(' + ');
    if (tiersCrossed > 0) scalingNote = `cantrip, level ${ctx.casterLevel}`;
  } else if (scaling.kind === 'leveled' && scaling.extraDicePerSlotLevel) {
    const levelsAbove = Math.max(0, ctx.castAtSlotLevel - spell.spellLevel);
    diceExpression = [diceExpression, ...Array(levelsAbove).fill(scaling.extraDicePerSlotLevel)].filter(Boolean).join(' + ');
    if (levelsAbove > 0) scalingNote = `cast at level ${ctx.castAtSlotLevel}`;
  }

  const candidates = ['damage_roll.spell.all', `damage_roll.spell.${spell.damageType}`, `damage_roll.spell.${slugifySpellName(spell.name)}`]
    .filter(Boolean);
  const damageContext: ModifierContext = { attackType: 'spell', outcomes: ctx.outcomes };

  // "Multiplier" against a spell-damage target means "roll the resolved dice pool N
  // times" (a dice-pool multiplier), not the scalar multiply speedFt() uses the same
  // modifier_type for - repeat the baseline+scaling expression, before flat bonuses,
  // so an upcast spell's extra dice get doubled too but a flat item bonus doesn't.
  const multipliers = resolvedNumericModifiers(ctx.modifierSources, candidates, ['multiplier'], damageContext);
  for (const multiplier of multipliers) {
    if (Number.isInteger(multiplier.value) && multiplier.value > 1) {
      diceExpression = repeatDiceExpression(diceExpression, multiplier.value);
    }
  }

  const extraDice = resolveExtraDiceRolls(ctx.modifierSources, candidates, damageContext);
  const flatBonuses = resolvedAdditiveModifiers(ctx.modifierSources, candidates, damageContext);

  return {
    resolution: spell.resolutionType,
    damageType: spell.damageType,
    // Merged for display ("2d10", not "1d10 + 1d10"); rolls the same dice.
    diceExpression: mergeDiceTerms(diceExpression),
    scalingNote,
    extraDice,
    flatBonuses,
    saveAbility: spell.saveAbility,
    saveEffect: spell.saveEffect
  };
}

// The following were previously inline $derived formulas in
// CharacterSheetForm.svelte, only reachable from within that component -
// extracted so VTT Phase 2's server-side character API can compute the same
// live numbers the sheet displays, instead of reading a stale metadata_json
// snapshot from the last save. Moved verbatim; the component now calls these
// instead of recomputing the math itself.

export function armorClass(
  dexScore: number,
  equippedAcBonus: number,
  modifierSources: ActiveCharacterEffect[],
  context: ModifierContext = {}
): number {
  const bonuses = resolvedAdditiveModifiers(modifierSources, ['ac'], context);
  return 10 + abilityModifier(dexScore) + equippedAcBonus + bonuses.reduce((sum, bonus) => sum + bonus.value, 0);
}

export function initiativeBonus(
  dexScore: number,
  modifierSources: ActiveCharacterEffect[],
  context: ModifierContext = {}
): number {
  const bonuses = resolvedAdditiveModifiers(modifierSources, ['initiative'], context);
  return abilityModifier(dexScore) + bonuses.reduce((sum, bonus) => sum + bonus.value, 0);
}

// Order of operations matters here and must stay exact: base (or the last 'set' modifier, if
// any) -> additive bonuses -> chained multipliers (each multiplier compounds on the running
// total, not on the base) -> floor, clamped to >= 0.
//
// Manual stat adjustments (overridable-sheet-stats): speed is the only one of the 9 overridable
// stats whose resolver honours a 'set' modifier today, so it's also the only one where the
// adjustment/set interaction matters. Per the user's confirmed precedence rule, the adjustment
// is summed into the BASE before 'set' is applied - so a 'set' (e.g. Grappled -> 0) discards it
// entirely, same as it would discard a flat class feature bonus baked into the base. A manual
// *override* (see characterStats.ts) is applied by the caller, outside this pipeline entirely,
// and beats the 'set' result regardless. If 'set' support is ever added to the other 8 stats,
// the same rule applies there too: set replaces base + adjustment, override replaces everything.
export function speedPipeline(
  modifierSources: ActiveCharacterEffect[],
  context: ModifierContext = {},
  adjustment = 0
): { value: number; adjustmentReplacedBy: string | null } {
  const setValues = resolvedNumericModifiers(modifierSources, ['speed.all', 'speed.walk'], ['set'], context);
  const bonuses = resolvedAdditiveModifiers(modifierSources, ['speed.all', 'speed.walk'], context);
  const multipliers = resolvedNumericModifiers(modifierSources, ['speed.all', 'speed.walk'], ['multiplier'], context);
  const activeSet = setValues.length ? setValues.at(-1) : undefined;
  const base = activeSet ? activeSet.value : 30 + adjustment;
  const withBonuses = base + bonuses.reduce((sum, bonus) => sum + bonus.value, 0);
  const multiplied = multipliers.reduce((value, multiplier) => value * multiplier.value, withBonuses);
  return {
    value: Math.max(0, Math.floor(multiplied)),
    adjustmentReplacedBy: activeSet && adjustment !== 0 ? activeSet.label : null
  };
}

export function speedFt(modifierSources: ActiveCharacterEffect[], context: ModifierContext = {}): number {
  return speedPipeline(modifierSources, context, 0).value;
}

// Generalizes the near-identical passive perception/insight/investigation
// formulas (10 + ability mod + proficiency (if proficient) + bonuses).
export function passiveScore(
  abilityScore: number,
  proficient: boolean,
  prof: number,
  modifierSources: ActiveCharacterEffect[],
  candidates: string[],
  context: ModifierContext = {}
): number {
  const bonuses = resolvedAdditiveModifiers(modifierSources, candidates, context);
  return 10 + abilityModifier(abilityScore) + (proficient ? prof : 0) + bonuses.reduce((sum, bonus) => sum + bonus.value, 0);
}

export type SenseKey = 'normalFt' | 'darkFt' | 'trueFt' | 'devilFt';
export type SenseResolution = { value: number; lines: string[] };

const SENSE_TARGETS: Record<SenseKey, { target: string; baseline: number }> = {
  normalFt: { target: 'vision.normal_ft', baseline: 30 },
  darkFt: { target: 'vision.dark_ft', baseline: 0 },
  trueFt: { target: 'vision.true_ft', baseline: 0 },
  devilFt: { target: 'vision.devil_ft', baseline: 0 }
};

// Resolves one sense (darkvision, truesight, ...) with a source-attributed audit trail.
// See docs/architecture/modifier-primacy.md section 3.1 for the stacking rules. Order:
//   1. 'set'     - if any exists, the last one by priority is the base (mirrors speedPipeline),
//                  replacing the baseline and every 'minimum'.
//   2. 'minimum' - otherwise the base is the highest of the baseline and every 'minimum' grant.
//                  Grants never sum, so a racial 60ft plus a 60ft feat is still 60ft.
//   3. add       - every 'bonus' is added and every 'penalty' subtracted on top.
//   4. floor     - never below 0.
// Any other op on a sense target is listed as "Not applied" rather than silently dropped.
export function resolveSense(
  modifierSources: ActiveCharacterEffect[],
  target: string,
  baseline: number,
  context: ModifierContext = {}
): SenseResolution {
  const lines: string[] = [];
  const sets = resolvedNumericModifiers(modifierSources, [target], ['set'], context);
  const minimums = resolvedNumericModifiers(modifierSources, [target], ['minimum'], context);
  const activeSet = sets.length ? sets.at(-1) : undefined;

  let base: number;
  if (activeSet) {
    base = activeSet.value;
    lines.push(`Set by ${activeSet.label}: ${base} ft (replaces baseline and at-least grants)`);
  } else {
    lines.push(`Baseline: ${baseline} ft`);
    // The first grant with the top value (by priority) is the one marked as used.
    const top = minimums.reduce((best, entry) => (entry.value > best ? entry.value : best), Number.NEGATIVE_INFINITY);
    let usedMarked = false;
    for (const entry of minimums) {
      const isUsed = !usedMarked && entry.value === top && entry.value > baseline;
      if (isUsed) usedMarked = true;
      lines.push(`${entry.label}: at least ${entry.value} ft ${isUsed ? '(highest)' : '(not the highest, not used)'}`);
    }
    base = Math.max(baseline, ...minimums.map((entry) => entry.value));
  }

  let total = base;
  for (const bonus of resolvedAdditiveModifiers(modifierSources, [target], context)) {
    total += bonus.value;
    lines.push(`${bonus.label}: ${bonus.value >= 0 ? '+' : '-'}${Math.abs(bonus.value)} ft`);
  }

  // Ops senses don't understand (multiplier, advantage, ...) are shown, not silently ignored.
  const handled = ['set', 'minimum', 'bonus', 'penalty'];
  for (const effect of modifierSources) {
    for (const modifier of effect.modifiers) {
      if (handled.includes(modifier.modifierType)) continue;
      if (!modifierTargetMatches(modifier.target, [target]) || !modifierConditionMatches(modifier.conditionExpression, context)) continue;
      lines.push(`Not applied: ${modifier.label?.trim() || effect.name} (${modifier.modifierType} isn't supported for senses)`);
    }
  }

  const value = Math.max(0, total);
  lines.push(`Total: ${value} ft`);
  return { value, lines };
}

export function visionBreakdown(
  modifierSources: ActiveCharacterEffect[],
  context: ModifierContext = {}
): Record<SenseKey, SenseResolution> {
  const entries = (Object.keys(SENSE_TARGETS) as SenseKey[]).map((key) => [
    key,
    resolveSense(modifierSources, SENSE_TARGETS[key].target, SENSE_TARGETS[key].baseline, context)
  ]);
  return Object.fromEntries(entries) as Record<SenseKey, SenseResolution>;
}

// vision.*_ft aren't feats or race traits in this codebase's data model, they're just Modifiers
// like everything else (docs/architecture/modifier-primacy.md), resolved the same way AC/speed
// are. Baselines are standard human vision (30ft normal, no darkvision/truesight/devil's sight).
// Darkvision-style grants use the 'minimum' op ("At least - highest wins"), so overlapping
// sources don't sum; 'bonus'/'penalty' still add on top. See resolveSense for the full order.
export function visionRadii(
  modifierSources: ActiveCharacterEffect[],
  context: ModifierContext = {}
): { normalFt: number; darkFt: number; trueFt: number; devilFt: number } {
  const breakdown = visionBreakdown(modifierSources, context);
  return {
    normalFt: breakdown.normalFt.value,
    darkFt: breakdown.darkFt.value,
    trueFt: breakdown.trueFt.value,
    devilFt: breakdown.devilFt.value
  };
}

// Same "equipped and has combat-relevant fields" predicate the sheet's
// battle-actions tab already uses (CharacterSheetForm.svelte), extracted so
// the VTT's "available actions" list matches it exactly.
// Broader than equippedAttackItems() below - "is this item equipped at all"
// (armor, shields, anything), not "is it weapon-like enough to show as an
// attack option." AC bonuses come from every equipped item, not just ones
// with damage fields - conflating the two (as the VTT's character-detail
// route originally did) silently drops shield/armor AC bonuses, since a
// shield has no damageRolls/toHitBonus/damageBonus to match the narrower
// filter. Same predicate CharacterSheetForm.svelte's own equippedInventoryRows
// already used inline.
export function equippedItems(inventory: InventoryItem[]): InventoryItem[] {
  return inventory.filter((item) => item.location === 'equipped' || item.equipped);
}

export function equippedAttackItems(inventory: InventoryItem[]): InventoryItem[] {
  return inventory.filter(
    (item) => (item.location === 'equipped' || item.equipped) && (item.damageRolls || item.toHitBonus || item.damageBonus)
  );
}

// Consumables (potions etc.) usable from the VTT Combat Actions modal (Attack/Heal
// tabs) - deliberately independent of location/equipped, unlike equippedAttackItems
// above: a potion sits in the backpack, not "equipped", but should still show up as
// a usable action as long as it has dice behind it and at least one is left.
export function usableConsumableItems(inventory: InventoryItem[]): InventoryItem[] {
  return inventory.filter((item) => item.category === 'consumable' && item.damageRolls && item.quantity > 0);
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
