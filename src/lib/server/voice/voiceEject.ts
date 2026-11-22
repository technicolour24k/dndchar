import { env } from '$env/dynamic/private';
import { query } from '$lib/server/db';
import { createDailyClient, DailyError } from './dailyClient';
import { readDailyConfig, voiceRoomName } from './dailyConfig';

// Server-side removal from a campaign's Daily voice room (daily-voice plan, Unit 4). The VTT client
// also leaves voice by itself when it's kicked (voice.js), this is the backstop for a modified client
// or a closed tab, and the only thing that drops people when a campaign is archived.
//
// Best effort and fire-and-forget: these NEVER throw and never fail the campaign action that called
// them. No-ops when voice isn't configured. They always call Daily even if this process never made
// the room (the room outlives restarts). Daily answers 404 when the room has no call going, which is
// fine. Log lines carry the status and Daily's error code only: never the key or a token.
//
// Not used for role changes (demotion): a demoted DM stays a member and may stay in voice.

const MAX_IDS_PER_REQUEST = 100; // Daily's limit for user_ids on the eject endpoint

async function eject(campaignId: string, userIds: string[], what: string): Promise<void> {
  try {
    const config = readDailyConfig(env);
    if (!config || userIds.length === 0) return;
    const daily = createDailyClient(config);
    const roomName = voiceRoomName(config.roomPrefix, campaignId);
    for (let i = 0; i < userIds.length; i += MAX_IDS_PER_REQUEST) {
      try {
        await daily.ejectUsers(roomName, userIds.slice(i, i + MAX_IDS_PER_REQUEST));
      } catch (e) {
        if (e instanceof DailyError && e.status === 404) return; // no room / no call: nothing to eject
        throw e;
      }
    }
  } catch (e) {
    const detail = e instanceof DailyError ? `${e.status} ${e.code}` : 'network or timeout';
    console.error(`[voice] eject (${what}) failed: ${detail}`);
  }
}

/** A member was removed or left: drop them from the campaign's voice call. */
export function ejectFromCampaignVoice(campaignId: string, userId: string | null | undefined): Promise<void> {
  if (!userId) return Promise.resolve();
  return eject(campaignId, [userId], 'member');
}

/** The campaign was archived: drop everyone who is a member from its voice call. */
export async function ejectAllFromCampaignVoice(campaignId: string): Promise<void> {
  try {
    if (!readDailyConfig(env)) return;
    const rows = await query<{ user_id: string }>('SELECT user_id FROM campaign_members WHERE campaign_id = $1', [campaignId]);
    await eject(campaignId, rows.rows.map((r) => r.user_id), 'archive');
  } catch {
    console.error('[voice] eject (archive) failed: could not list members');
  }
}
