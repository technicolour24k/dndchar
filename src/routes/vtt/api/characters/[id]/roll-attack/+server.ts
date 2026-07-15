import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getCharacter } from '$lib/server/services/characters';
import { abilityMap, equippedAttackItems, proficiencyBonus, totalLevel } from '$lib/rules/dnd5e';
import { rollAttack } from '$lib/rules/attackRoll';

// Server-side attack roll for the VTT. The vanilla VTT client can't import $lib (no build step),
// and the token it holds only carries a flattened `actions` array - it doesn't have the character's
// modifierSources, so it physically cannot reproduce the sheet's rich roll (advantage/disadvantage
// dice-pool, Bless/extra dice, crit outcomes). So the roll runs here, against the LIVE character,
// using the exact same rollAttack() the character sheet uses. One roll implementation, two callers.
//
// Ownership-scoped exactly like getCharacter() (a player can only roll for their own character),
// same posture as the sibling GET route.
export const POST: RequestHandler = async ({ locals, params, request }) => {
  const character = await getCharacter(locals.user!.id, params.id!);
  if (!character) return json({ error: 'not_found' }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  const itemName = typeof body?.itemName === 'string' ? body.itemName : '';
  if (!itemName) return json({ error: 'missing_item' }, { status: 400 });

  // Match against the same equipped-attack set the mini-sheet's action list was built from, so a
  // clicked action always resolves to a real inventory item (with its full category/ability/
  // proficient/effects data that the flattened token action dropped).
  const item = equippedAttackItems(character.inventory).find((entry) => entry.name === itemName);
  if (!item) return json({ error: 'item_not_found' }, { status: 404 });

  const level = totalLevel(character.classes);
  const result = rollAttack(item, {
    modifierSources: character.modifierSources,
    abilityScores: abilityMap(character.abilities),
    proficiencyBonus: proficiencyBonus(level),
    classes: character.classes
  });

  return json(result);
};
