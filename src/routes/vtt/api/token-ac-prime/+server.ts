import { json } from '@sveltejs/kit';
import { sessions } from '$vtt/store.js';
import { internalSecretValid } from '$lib/server/internalSecret';
import { getCharacterForRoll } from '$lib/server/services/characters';
import { primeTokenSheetAc } from '$lib/server/vttTokenAc';

// Called server-to-server by vtt/server/handlers/token.js right after a PC token is added (same loopback and
// shared-secret pattern as /vtt/api/damage-taken): records the character's REAL sheet AC as that token's
// sheetAc baseline, WITHOUT touching token.ac, so a GM-typed AC (cover, a house rule) stays as an offset when
// the sheet AC later changes. Only the token id comes in; the character is read from the live token itself, and
// it must belong at this table (campaign room: same campaign; Quick room: same owner) or nothing is recorded.
export async function POST({ request }) {
  if (!internalSecretValid(request.headers.get('x-vtt-internal-secret'), { route: '/vtt/api/token-ac-prime' })) {
    return json({ error: 'unauthorized' }, { status: 401 });
  }
  const body = await request.json().catch(() => ({}));
  const roomId = typeof body?.roomId === 'string' ? body.roomId : '';
  const tokenId = typeof body?.tokenId === 'string' ? body.tokenId : '';
  const token = sessions.get(roomId)?.tokens?.[tokenId];
  if (!token || token.type !== 'pc' || typeof token.characterId !== 'string') return json({ primed: false });

  const character = await getCharacterForRoll(token.characterId);
  if (!character) return json({ primed: false });
  const session = sessions.get(roomId);
  const belongs = session.campaignId ? character.campaignId === session.campaignId : Boolean(token.ownerId) && token.ownerId === character.ownerUserId;
  if (!belongs) return json({ primed: false });

  await primeTokenSheetAc(roomId, tokenId);
  return json({ primed: true });
}
