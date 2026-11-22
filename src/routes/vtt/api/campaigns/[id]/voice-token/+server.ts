import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { query } from '$lib/server/db';
import { getCampaignAccess, isUuid } from '$lib/server/services/access';
import { readDailyConfig, tokenProperties, voiceRoomName, voiceRoomUrl } from '$lib/server/voice/dailyConfig';
import { createDailyClient, DailyError } from '$lib/server/voice/dailyClient';
import { voiceDisplayName } from '$lib/server/voice/voiceName';

// POST /vtt/api/campaigns/<id>/voice-token   (optional JSON body: { characterId })
//
// The name shown in voice is built HERE and baked into the token (never taken from the client):
// "Character (Player)", "DM (Player)" for the primary DM, "Co-DM (Player)" for the co-DM, or just
// the player's name with no character. characterId is a hint for WHICH character (the one whose
// token the player is controlling); it is only honoured if that user owns it and it is in THIS
// campaign, otherwise their first party-active character in the campaign (by name) is used. The
// name is fixed at join, so changing token mid-call doesn't rename until the next join.
//
// Hands a real campaign member a short-lived Daily meeting token for the campaign's voice room
// (creating the room on first use). The Daily API key never leaves the server.
//
// Real membership only, same as the join-ticket route: the site-admin override does NOT apply, and
// an archived campaign has no voice.
//
//   unknown campaign                   -> 404 campaign_not_found
//   not a member / archived            -> 403 not_member
//   DAILY_API_KEY / DAILY_DOMAIN unset -> 503 voice_not_configured
//   more than one request per 3 s      -> 429 too_many_requests
//   Daily failed                       -> 502 voice_unavailable
//
// Under /vtt/api, so hooks.server.ts already requires a session; do not add it to bypassesUserAuth.

const THROTTLE_MS = 3000;
// userId -> last request time. In memory: a restart forgets it, which is harmless.
const lastRequest = new Map<string, number>();

const noStore = { 'Cache-Control': 'no-store' };
const fail = (error: string, status: number) => json({ error }, { status, headers: noStore });

export const POST: RequestHandler = async ({ params, locals, request }) => {
  const user = locals.user!;
  const campaignId = params.id;
  if (!isUuid(campaignId)) return fail('campaign_not_found', 404);

  const campaign = await query<{ id: string }>('SELECT id FROM campaigns WHERE id = $1', [campaignId]);
  if (!campaign.rows[0]) return fail('campaign_not_found', 404);

  const access = await getCampaignAccess({ query }, user.id, campaignId);
  if (!access || access.archived || !access.role) return fail('not_member', 403);

  const config = readDailyConfig(env);
  if (!config) return fail('voice_not_configured', 503);

  const now = Date.now();
  const last = lastRequest.get(user.id);
  if (last !== undefined && now - last < THROTTLE_MS) return fail('too_many_requests', 429);
  lastRequest.set(user.id, now);
  if (lastRequest.size > 500) {
    for (const [id, t] of lastRequest) if (now - t >= THROTTLE_MS) lastRequest.delete(id);
  }

  const body = await request.json().catch(() => null);
  const hint = typeof body?.characterId === 'string' && isUuid(body.characterId) ? body.characterId : null;
  let characterName: string | null = null;
  if (access.role === 'player') {
    try {
      // The hinted character first (only if owned and in this campaign), else the first party-active one.
      const found = await query<{ name: string }>(
        `SELECT name FROM characters
         WHERE owner_user_id = $1 AND campaign_id = $2 AND (id = $3::uuid OR party_active)
         ORDER BY (id = $3::uuid) DESC NULLS LAST, lower(name), id
         LIMIT 1`,
        [user.id, campaignId, hint]
      );
      characterName = found.rows[0]?.name ?? null;
    } catch {
      characterName = null; // a name lookup must never stop someone joining voice
    }
  }
  const userName = voiceDisplayName({ role: access.role, playerName: user.displayName, characterName });

  const roomName = voiceRoomName(config.roomPrefix, campaignId);
  try {
    const daily = createDailyClient(config);
    await daily.ensureRoom(roomName);
    const token = await daily.createToken(
      tokenProperties(config, { roomName, userId: user.id, displayName: userName, nowSeconds: Math.floor(now / 1000) })
    );
    return json(
      {
        url: voiceRoomUrl(config.domain, roomName),
        token,
        roomName,
        userName,
        // Whether this user may record the session in their browser: decided HERE from the campaign
        // role (DM or co-DM; site admin alone doesn't count), never by the client.
        canRecord: access.role === 'dm' || access.role === 'co_dm'
      },
      { headers: noStore }
    );
  } catch (e) {
    // Status and Daily's error code only: never the key, a token or a request body.
    const detail = e instanceof DailyError ? `${e.status} ${e.code} ${e.info}` : 'network or timeout';
    console.error(`[voice] token request failed: ${detail}`);
    return fail('voice_unavailable', 502);
  }
};
