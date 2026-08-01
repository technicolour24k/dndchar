import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getCharacter } from '$lib/server/services/characters';
import { useInventoryCatalogueItem } from '$lib/server/services/catalogue';
import { usableConsumableItems } from '$lib/rules/dnd5e';
import { rollDamage } from '$lib/rules/attackRoll';

// Server-side consumable-item roll + consume for the VTT (Phase 8, Heal/Attack
// tabs). Owner-scoped (getCharacter, not roll-attack's read-only
// getCharacterForRoll) because unlike a weapon/spell roll this mutates state -
// using a potion consumes it. Items have no attack/save layer in this simple
// model (a flat dice expression only, see the brief's Section 0) - always
// resolves 'auto', same shape roll-spell already returns for an auto-resolution
// spell, so the client's existing auto/heal handling needs no item-specific branch.
export const POST: RequestHandler = async ({ locals, params, request }) => {
  const characterId = params.id!;
  const body = await request.json().catch(() => ({}));
  const inventoryId = typeof body?.inventoryId === 'string' ? body.inventoryId : '';
  if (!inventoryId) return json({ error: 'missing_item' }, { status: 400 });

  const character = await getCharacter(locals.user!.id, characterId);
  if (!character) return json({ error: 'not_found' }, { status: 404 });

  const item = usableConsumableItems(character.inventory).find((entry) => entry.id === inventoryId);
  if (!item) return json({ error: 'item_not_found' }, { status: 404 });

  try {
    await useInventoryCatalogueItem(locals.user!.id, characterId, inventoryId);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Could not use item.' }, { status: 400 });
  }

  const damage = rollDamage(item.damageRolls, 0, 0, '', [], []);

  return json({
    title: item.name,
    resolution: 'auto',
    damageType: 'none',
    damage: damage.lines,
    damageTotal: damage.total
  });
};
