import type { ActiveCharacterEffect } from '$lib/types/character';
import { matchingModifiers, resolveModifierNumericValue, type ModifierContext } from './dnd5e';

// Every bonus (+) and penalty (-) aimed at one modifier target, conditions respected, as a
// source-attributed list. Labelled by the SOURCE (the feat or item), not the shared modifier's own
// label, so a breakdown reads "Oath of Embers +2" rather than "Vowfire (max) +2" twice. Zero
// values are dropped. Shared by resource pool maxima and action pool maxima.
export function sumTargetGrants(
  sources: ActiveCharacterEffect[],
  target: string,
  modifierContext: ModifierContext = {}
): Array<{ label: string; value: number }> {
  return matchingModifiers(sources, [target], ['bonus', 'penalty'], modifierContext)
    .map(({ effect, modifier }) => {
      const value = resolveModifierNumericValue(modifier.valueExpression, modifierContext, effect.modifiers, modifier);
      return { label: effect.name, value: modifier.modifierType === 'penalty' ? -value : value };
    })
    .filter((grant) => grant.value !== 0);
}
