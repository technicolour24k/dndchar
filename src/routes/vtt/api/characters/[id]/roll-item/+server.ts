import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { query } from '$lib/server/db';
import { getCharacter } from '$lib/server/services/characters';
import { getCharacterAccess } from '$lib/server/services/access';
import { useInventoryCatalogueItem } from '$lib/server/services/catalogue';
import { usableConsumableItems } from '$lib/rules/dnd5e';
import { adjustPrimaryDamageDice, rollDamage } from '$lib/rules/attackRoll';
import { parseAttackOptions } from '$lib/server/vttAttackAdvantage';

// Only someone who can ACT for the character (owner, campaign DM/co-DM) may use their item; a site
// admin can edit a sheet but does not roll or consume on a player's behalf, so they get a 404 here.
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

  const access = await getCharacterAccess({ query }, locals.user!.id, characterId);
  if (!access?.canAct) return json({ error: 'not_found' }, { status: 404 });
  const character = await getCharacter(locals.user!.id, characterId);
  if (!character) return json({ error: 'not_found' }, { status: 404 });

  const item = usableConsumableItems(character.inventory).find((entry) => entry.id === inventoryId);
  if (!item) return json({ error: 'item_not_found' }, { status: 404 });

  // Advantage doesn't apply to items (no d20 - always 'auto'), so only the INTERIM manual
  // damage-dice delta is read here. A preview (if one is ever sent) must never consume the item.
  const options = parseAttackOptions(body);
  if (options.preview) return json({ usesAttackRoll: false, primaryDamageDice: item.damageRolls });

  try {
    await useInventoryCatalogueItem(locals.user!.id, characterId, inventoryId);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Could not use item.' }, { status: 400 });
  }

  // INTERIM: manual damage-dice delta.
  const adjusted = adjustPrimaryDamageDice(item.damageRolls, options.manualDamageDice);
  const damage = rollDamage(adjusted.expression, 0, 0, '', [], []);

  return json({
    title: item.name,
    resolution: 'auto',
    damageType: 'none',
    damage: adjusted.auditLine ? [adjusted.auditLine, ...damage.lines] : damage.lines,
    damageTotal: damage.total,
    manualDamageDice: adjusted.applied
  });
};
