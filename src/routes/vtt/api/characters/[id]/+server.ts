import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getCharacter } from '$lib/server/services/characters';
import {
  abilityMap,
  armorClass,
  equippedAttackItems,
  equippedItems,
  proficiencyBonus,
  savingThrowModifier,
  speedFt,
  totalLevel,
  visionRadii
} from '$lib/rules/dnd5e';
import type { AbilityKey } from '$lib/types/character';

// Full computed combat snapshot for a single character, ownership-scoped
// exactly like getCharacter() itself (a player can only pull their own
// character's detail through this route - no cross-user lookup). Serves both
// the VTT's token-creation pull-through (hp/maxHp/speedFt/vision) and the
// in-VTT mini character sheet (everything else) - one endpoint, since the
// mini-sheet needs a superset of what token creation needs and there's no
// reason to duplicate the query.
export const GET: RequestHandler = async ({ locals, params }) => {
  const character = await getCharacter(locals.user!.id, params.id!);
  if (!character) return json({ error: 'not_found' }, { status: 404 });

  const context = { classes: character.classes };
  const abilities = abilityMap(character.abilities);
  const level = totalLevel(character.classes);
  const prof = proficiencyBonus(level);
  const attackItems = equippedAttackItems(character.inventory);
  const equippedAcBonus = equippedItems(character.inventory).reduce((sum, item) => sum + (Number(item.acBonus) || 0), 0);

  const hpResource = character.resources.find((resource) => resource.key === 'hp');

  const saves = Object.fromEntries(
    character.proficiencies.savingThrows.map((key: AbilityKey) => [
      key,
      savingThrowModifier(abilities[key], true, level)
    ])
  );

  return json({
    hp: hpResource?.currentValue ?? 0,
    maxHp: hpResource?.maxValue ?? 0,
    speedFt: speedFt(character.modifierSources, context),
    vision: visionRadii(character.modifierSources, context),
    ac: armorClass(abilities.dex, equippedAcBonus, character.modifierSources, context),
    saves,
    actions: attackItems.map((item) => ({
      name: item.name,
      toHitBonus: item.toHitBonus,
      damageBonus: item.damageBonus,
      damageRolls: item.damageRolls
    })),
    spellSlots: character.spellSlots,
    preparedSpells: character.content
      .filter((entry) => entry.type === 'spell' && entry.isPrepared)
      .map((entry) => ({ id: entry.id, name: entry.name, spellLevel: entry.spellLevel }))
  });
};
