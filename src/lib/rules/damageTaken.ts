// Incoming-damage resolution for a defender, driven entirely by `damage_taken.*` modifiers
// (modifier-primacy: nothing here knows about Rage, armour or cover - it only reads Modifiers).
//
// Targets: `damage_taken.all` and, when the damage type is known, `damage_taken.<type>`
// (lower-case, e.g. damage_taken.slashing). Untyped damage only matches `.all`.
//
// Modifier types on those targets:
//   bonus         - flat extra damage taken (value is how much)
//   penalty       - flat damage REDUCTION (value is how much, e.g. armour "reduce damage by 2")
//   resistance    - halve (value ignored)
//   vulnerability - double (value ignored)
//   immunity      - no damage (value ignored)
// No new modifier type was needed: 'penalty' already reads as "subtract this" everywhere else.
//
// Order (5e PHB): flat adjustments first, floored at 0; then resistance/vulnerability; immunity
// trumps everything. Resistance and vulnerability are a simple binary net cancellation per
// damage-type bucket (CLAUDE.md): any one of each cancels, several resistances do not stack, they
// still only halve once. Every step is source-attributed so the audit trail can show it.
import {
  matchingModifiers,
  resolvedNumericModifiers,
  type ModifierContext
} from './dnd5e';
import type { ActiveCharacterEffect } from '$lib/types/character';

export type DamageTakenStep = {
  // Human line, e.g. "7 - 2 (Half Cover) = 5" or "halved (Rage: resistance to slashing) = 2".
  text: string;
  label: string;
  before: number;
  after: number;
};

export type DamageTakenResult = {
  amount: number;
  final: number;
  // Normalised damage type used for matching, or null for untyped damage.
  damageType: string | null;
  steps: DamageTakenStep[];
  // The steps joined into one line; empty when nothing changed the amount.
  breakdown: string;
};

// 'Fire' -> 'fire', ' ' / 'magic-ish junk' -> only letters and underscores survive. Empty is untyped.
export function normaliseDamageType(raw: unknown): string | null {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase().replace(/[^a-z_]/g, '') : '';
  return value || null;
}

export function resolveDamageTaken(
  modifierSources: ActiveCharacterEffect[],
  options: { amount: number; damageType?: string | null; context?: ModifierContext }
): DamageTakenResult {
  const amount = Math.max(0, Math.floor(Number(options.amount) || 0));
  const damageType = normaliseDamageType(options.damageType);
  const context = options.context ?? {};
  const candidates = damageType ? ['damage_taken.all', `damage_taken.${damageType}`] : ['damage_taken.all'];
  const steps: DamageTakenStep[] = [];
  const finish = (final: number): DamageTakenResult => ({
    amount,
    final,
    damageType,
    steps,
    breakdown: steps.map((step) => step.text).join('; ')
  });
  if (amount === 0) return finish(0);

  // Step 1 - flat adjustments, in the order the sources list them: extra damage, then reductions.
  let running = amount;
  const adjustments = [
    ...resolvedNumericModifiers(modifierSources, candidates, ['bonus'], context).map((entry) => ({ ...entry, sign: 1 })),
    ...resolvedNumericModifiers(modifierSources, candidates, ['penalty'], context).map((entry) => ({ ...entry, sign: -1 }))
  ];
  for (const { label, value, sign } of adjustments) {
    const before = running;
    running += sign * value;
    steps.push({
      text: `${before} ${sign > 0 ? '+' : '-'} ${Math.abs(value)} (${label}) = ${running}`,
      label,
      before,
      after: running
    });
  }
  if (running < 0) {
    steps.push({ text: `floored at 0 (was ${running})`, label: 'floor', before: running, after: 0 });
    running = 0;
  }

  // Step 2 - resistance / vulnerability. Value is irrelevant, so use the shared filter directly
  // (resolvedNumericModifiers would drop these, they usually carry no number).
  const bucket = damageType ? `${damageType} damage` : 'all damage';
  const describe = (type: string) => matchingModifiers(modifierSources, candidates, [type], context)
    // A damage_taken.all modifier covers every type, so say so rather than naming this hit's type.
    .map(({ effect, modifier }) => `${modifier.label?.trim() || effect.name}: ${type} to ${modifier.target.endsWith('.all') ? 'all damage' : damageType ?? 'all damage'}`);
  const resistances = describe('resistance');
  const vulnerabilities = describe('vulnerability');
  const immunities = describe('immunity');

  if (immunities.length) {
    steps.push({ text: `immune (${immunities.join(', ')}) = 0`, label: 'immunity', before: running, after: 0 });
    return finish(0);
  }
  if (resistances.length && vulnerabilities.length) {
    steps.push({
      text: `resistance and vulnerability to ${bucket} cancel (${[...resistances, ...vulnerabilities].join(', ')}) = ${running}`,
      label: 'cancel',
      before: running,
      after: running
    });
  } else if (resistances.length) {
    const after = Math.floor(running / 2);
    steps.push({ text: `halved (${resistances.join(', ')}) = ${after}`, label: 'resistance', before: running, after });
    running = after;
  } else if (vulnerabilities.length) {
    const after = running * 2;
    steps.push({ text: `doubled (${vulnerabilities.join(', ')}) = ${after}`, label: 'vulnerability', before: running, after });
    running = after;
  }
  return finish(running);
}
