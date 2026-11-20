import { error } from '@sveltejs/kit';
import { getCharacter } from '$lib/server/services/characters';
import { getEncounter, isCharacterInEncounter } from '$lib/server/services/encounters';
import { listCombatLogEntries } from '$lib/server/services/combatLog';

export async function load({ params, locals }) {
  const character = await getCharacter(locals.user!.id, params.id);
  if (!character) throw error(404, 'Character not found.');

  const encounter = await getEncounter(params.encounterId);
  if (!encounter) throw error(404, 'Encounter not found.');

  // Catches a stale/mistyped URL rather than silently showing an encounter
  // this character was never actually part of.
  if (!(await isCharacterInEncounter(params.id, params.encounterId))) {
    throw error(404, 'This character was not part of that encounter.');
  }

  return {
    character,
    encounter,
    entries: await listCombatLogEntries(params.encounterId)
  };
}
