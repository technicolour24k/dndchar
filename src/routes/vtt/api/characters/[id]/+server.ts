import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getCharacter } from '$lib/server/services/characters';
import {
  abilityMap,
  abilityModifier,
  equippedAttackItems,
  usableConsumableItems,
  visionRadii
} from '$lib/rules/dnd5e';
import { characterStatsFor } from '$lib/rules/characterStats';

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
  // characterStatsFor resolves overrides/adjustments and the proficiency cascade the same way
  // the sheet does (see src/lib/rules/characterStats.ts) - AC/speed only take effect here at
  // token creation, since the 30s poll (applyCharacterSyncFields) deliberately excludes them
  // (VTT-session-authoritative once a token exists).
  const stats = characterStatsFor(character);
  const attackItems = equippedAttackItems(character.inventory);

  const hpResource = character.resources.find((resource) => resource.key === 'hp');

  // Proficient saving throws only (matches the shape this endpoint has always returned), now
  // including saving_throw.* modifiers and the effective (overridden/adjusted) proficiency
  // bonus - both previously missing here, a sheet/VTT drift fix.
  const saves = Object.fromEntries(
    character.proficiencies.savingThrows.map((key) => [key, stats.savingThrows[key]])
  );

  return json({
    hp: hpResource?.currentValue ?? 0,
    maxHp: hpResource?.maxValue ?? 0,
    speedFt: stats.speed.value,
    vision: visionRadii(character.modifierSources, context),
    ac: stats.armorClass.value,
    saves,
    actions: [
      ...attackItems.map((item) => ({
        name: item.name,
        toHitBonus: item.toHitBonus,
        damageBonus: item.damageBonus,
        damageRolls: item.damageRolls
      })),
      // Always-available synthetic action (Phase 8) - 1 bludgeoning + STR modifier,
      // the 5e baseline. Not a real inventory row, so roll-attack's item lookup by
      // name will miss it - the client's existing item_not_found fallback
      // (rollManualAction, already built for GM homebrew token actions) picks it
      // up automatically using the flat numbers computed here.
      {
        name: 'Unarmed Strike',
        toHitBonus: stats.proficiency.value + abilityModifier(abilities.str),
        damageBonus: abilityModifier(abilities.str),
        damageRolls: '1'
      }
    ],
    spellSlots: character.spellSlots,
    preparedSpells: character.content
      .filter((entry) => entry.type === 'spell' && entry.isPrepared)
      .map((entry) => ({ id: entry.id, name: entry.name, spellLevel: entry.spellLevel })),
    items: usableConsumableItems(character.inventory).map((item) => ({
      id: item.id,
      name: item.name,
      damageRolls: item.damageRolls,
      quantity: item.quantity
    }))
  });
};
