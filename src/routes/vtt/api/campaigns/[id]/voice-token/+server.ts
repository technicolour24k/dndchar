import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { query } from '$lib/server/db';
import { getCampaignAccess, isUuid } from '$lib/server/services/access';
import { readDailyConfig, tokenProperties, voiceRoomName, voiceRoomUrl } from '$lib/server/voice/dailyConfig';
import { createDailyClient, DailyError } from '$lib/server/voice/dailyClient';

// POST /vtt/api/campaigns/<id>/voice-token   (body ignored)
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

export const POST: RequestHandler = async ({ params, locals }) => {
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

  const roomName = voiceRoomName(config.roomPrefix, campaignId);
  try {
    const daily = createDailyClient(config);
    await daily.ensureRoom(roomName);
    const token = await daily.createToken(
      tokenProperties(config, { roomName, userId: user.id, displayName: user.displayName, nowSeconds: Math.floor(now / 1000) })
    );
    return json(
      { url: voiceRoomUrl(config.domain, roomName), token, roomName, userName: user.displayName },
      { headers: noStore }
    );
  } catch (e) {
    // Status and Daily's error code only: never the key, a token or a request body.
    const detail = e instanceof DailyError ? `${e.status} ${e.code} ${e.info}` : 'network or timeout';
    console.error(`[voice] token request failed: ${detail}`);
    return fail('voice_unavailable', 502);
  }
};
