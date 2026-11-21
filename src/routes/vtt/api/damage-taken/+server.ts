import { json } from '@sveltejs/kit';
import { internalSecretValid } from '$lib/server/internalSecret';
import { getCharacterForRoll } from '$lib/server/services/characters';
import { resolveDamageTaken } from '$lib/rules/damageTaken';

// Same server-to-server pattern as /vtt/api/log: vtt/server/handlers/token.js is plain JS outside
// SvelteKit's module graph, so it can't load a character itself. When damage lands on a PC token
// it asks here instead: "this much damage of this type on this character - what do they take?".
// No browser session, so it is guarded by the shared-secret header (hooks.server.ts lets the path
// through the normal login gate). Read-only: nothing is written, the VTT server applies the HP.
// Strict: unlike the log routes, with no VTT_INTERNAL_SECRET in production this refuses (the VTT
// then applies damage unreduced), because the answer changes game state.
export async function POST({ request }) {
  if (!internalSecretValid(request.headers.get('x-vtt-internal-secret'), { route: '/vtt/api/damage-taken', strict: true })) {
    return json({ error: 'unauthorized' }, { status: 401 });
  }
  const body = await request.json().catch(() => ({}));
  const characterId = typeof body?.characterId === 'string' ? body.characterId : '';
  const amount = Number(body?.amount);
  if (!characterId || !Number.isFinite(amount)) return json({ error: 'missing_fields' }, { status: 400 });

  const character = await getCharacterForRoll(characterId);
  if (!character) return json({ error: 'not_found' }, { status: 404 });

  // A token can carry any characterId a client typed, so only honour one that belongs at this
  // table. Campaign room: the character must be in that campaign. Quick room: the token's owner
  // must be the character's owner. Anything else gets no reduction (the VTT applies it unreduced).
  const campaignId = typeof body?.campaignId === 'string' && body.campaignId ? body.campaignId : null;
  const tokenOwnerId = typeof body?.ownerId === 'string' ? body.ownerId : null;
  const belongs = campaignId ? character.campaignId === campaignId : tokenOwnerId !== null && tokenOwnerId === character.ownerUserId;
  if (!belongs) return json({ error: 'character_not_at_table' }, { status: 403 });

  const { final, steps, breakdown } = resolveDamageTaken(character.modifierSources, {
    amount,
    damageType: typeof body?.damageType === 'string' ? body.damageType : null,
    context: { classes: character.classes }
  });
  return json({ final, steps, breakdown });
}
