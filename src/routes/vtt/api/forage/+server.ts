import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sessions, dmPresent, forageViewForPlayer } from '$vtt/store.js';
import { query } from '$lib/server/db';
import { emitRealtimeEvent } from '$lib/server/realtime';
import { forageItemCount } from '$lib/rules/forage';
import { getUnmarkedSelfFind, markSelfFind, startSelfFind } from '$lib/server/services/forage';
import {
  broadcastForageUpdate, closeRequest, canWithdraw, findPendingForUser, forageMap, forageNudge, forageResultsMap,
  newRequest, resolveForageRoom, rollLogMessage
} from '$lib/server/vttForage';
import {
  ForageRollError, forageLogDetails, logForageRoll, previewForageAdvantage, previewGenericAdvantage, publishFindChanged, rollForageCheck
} from '$lib/server/vttForageRoll';
import { FORAGE_SELF_SKILLS } from '$lib/rules/skills';
import { checkForageAvailability, isUuid, loadOwnedCharacter, parseAdvantage, parseSelfChoice, playerUnmarked, shortText } from '$lib/server/vttForageApi';

// Player-facing forage actions (vtt-forage plan, unit B). All writes are HTTP, the socket only
// notifies. Every character action first checks the character is the caller's own. The mode is
// decided here, at submit time: DM mode when the room is live and has a connected account GM,
// otherwise self-serve (the player marks their own check and the haul goes straight in).
//
// Who picks what (Rev 4): in DM mode the player sends ONLY their adv/dis counters, and the DM picks
// the skill, area, category and table. Anything else in the body is ignored. In self-serve mode the
// player picks from a short skill list plus an area and category (never a table: the server resolves
// it). A combination with nothing to find rolls and marks like any other, and a pass finds nothing.
//
// Campaigns (Unit G): find tables belong to a campaign, so a character can only forage when it is in
// a campaign, any live room it forages in is that campaign's room, and the campaign has a table with
// something pickable. Otherwise start answers 409 forage_unavailable with a campaign-level reason
// (never anything about individual tables). An in-flight forage can always be resumed and marked.
//
// Statuses: 400 bad input, 403 not allowed in that room, 404 not your character, 409 a conflict the
// client can act on ('resume' carries the existing in-flight forage so the popup can reopen it).

const err = (error: string, status: number, extra: Record<string, unknown> = {}) => json({ error, ...extra }, { status });

export const POST: RequestHandler = async ({ locals, request }) => {
  const userId = locals.user!.id;
  const body = await request.json().catch(() => ({}));
  const action = body?.action;

  try {
    if (action === 'preview') return await previewAction(userId, body);
    if (action === 'start') return await startAction(userId, locals.user!.displayName, body);
    if (action === 'self_mark') return await selfMarkAction(userId, body);
    if (action === 'withdraw') return withdrawAction(userId, body);
    if (action === 'dismiss') return dismissAction(userId, body);
  } catch (error) {
    if (error instanceof ForageRollError) {
      return err(error.code, error.code === 'bad_skill' ? 400 : 404);
    }
    console.error('[forage] action failed', action, error);
    return err('server_error', 500);
  }
  return err('invalid_action', 400);
};

// The no-roll sources for the popup's advantage panel (sheet modifiers plus the character's token
// conditions when it has a token in the room).
async function previewAction(userId: string, body: any) {
  const owned = await loadOwnedCharacter(userId, body?.characterId);
  if (!owned) return err('not_found', 404);
  const room = resolveForageRoom({
    userId, roomId: shortText(body?.roomId, 64) || null, characterId: body.characterId,
    tokenId: shortText(body?.tokenId, 200) || null, activeRoomId: owned.activeRoomId
  });
  if (room.error) return err(room.error, 403);
  const common = { characterId: body.characterId, token: room.token, sessionId: room.session?.id ?? null, body };
  // DM mode: the DM hasn't called a skill yet, so the player only sees sources that apply to any
  // check. Self-serve: the skill must be on the short list (the player can't probe other skills).
  if (room.session && dmPresent(room.session)) return json(await previewGenericAdvantage(common));
  const skillKey = shortText(body?.skillKey, 40);
  if (!FORAGE_SELF_SKILLS.includes(skillKey)) return err('skill_not_allowed', 400);
  return json(await previewForageAdvantage({ ...common, skillKey }));
}

async function startAction(userId: string, displayName: string, body: any) {
  const owned = await loadOwnedCharacter(userId, body?.characterId);
  if (!owned) return err('not_found', 404);
  const characterId: string = body.characterId;

  // Everything async that has to happen before the in-memory check-and-set below, so that two
  // quick starts can't both pass the "nothing in flight" check (no await between it and the set).
  const unmarked = await getUnmarkedSelfFind(userId);
  if (unmarked) return err('resume', 409, { unmarkedSelf: playerUnmarked(unmarked) });

  const room = resolveForageRoom({
    userId, roomId: shortText(body?.roomId, 64) || null, characterId,
    tokenId: shortText(body?.tokenId, 200) || null, activeRoomId: owned.activeRoomId
  });
  if (room.error) return err(room.error, 403);
  const session = room.session;

  // An in-flight DM request is resumed even if forage has since become unavailable, so the finder is
  // never stuck. (An unmarked self check was handled above. The check-and-set below stays the real guard.)
  const inFlight = findPendingForUser(userId);
  if (inFlight) return err('resume', 409, { pending: forageViewForPlayer(inFlight.request), roomId: inFlight.session.id });

  // Disabled without a campaign, in the wrong room, or with no tables to forage (campaign-level facts only).
  const availability = await checkForageAvailability(owned, session);
  if (!availability.available) return err('forage_unavailable', 409, { reason: availability.reason });

  // Self-serve picks are validated up front (this awaits). In DM mode they are never read.
  const selfPicked = session && dmPresent(session) ? null : await parseSelfChoice(body, owned.campaignId);
  if (selfPicked && 'error' in selfPicked) return err(selfPicked.error, 400);

  // One forage in flight per user, across rooms and modes.
  const pending = findPendingForUser(userId);
  if (pending) return err('resume', 409, { pending: forageViewForPlayer(pending.request), roomId: pending.session.id });

  if (session && dmPresent(session)) {
    // DM mode: nothing is rolled yet. The request waits for the GM, who picks the skill, area,
    // category and table. Whatever the player sent for those is ignored: only their adv/dis
    // counters travel (the DM's popup pre-fills its counters from them).
    const created = newRequest({
      playerId: userId, playerName: displayName, characterId, characterName: owned.name,
      tokenId: room.token?.id ?? null, source: shortText(body?.roomId, 64) ? 'vtt' : 'sheet',
      choice: { skillKey: '', areaType: '', category: '', tableId: '', advantage: parseAdvantage(body) }
    });
    forageMap(session)[userId] = created;
    // A new request replaces the finder's old closed result.
    delete forageResultsMap(session)[userId];
    broadcastForageUpdate(session, created);
    return json({ mode: 'dm', roomId: session.id, request: forageViewForPlayer(created) });
  }

  // Self-serve: the server rolls the check now and logs it as an unmarked find. (If a DM left while
  // we awaited above there are no validated picks, so the client is told to choose and retry.)
  if (!selfPicked || 'error' in selfPicked) return err('skill_not_allowed', 400);
  const picked = selfPicked;
  const check = await rollForageCheck({
    characterId, skillKey: picked.choice.skillKey, token: room.token, sessionId: session?.id ?? null, body
  });
  const started = await startSelfFind({
    characterId, finderUserId: userId, tableId: picked.choice.tableId, areaType: picked.choice.areaType, category: picked.choice.category, check,
    roomCode: session?.id ?? null, gameSessionId: session?.gameSessionId ?? null, campaignId: owned.campaignId
  });
  if ('conflict' in started) return err('resume', 409, { unmarkedSelf: playerUnmarked(started.existing) });
  return json({ mode: 'self', findId: started.findId, check });
}

async function selfMarkAction(userId: string, body: any) {
  if (!isUuid(body?.findId)) return err('stale', 409);
  const marked = await markSelfFind({
    // The table was fixed at start (resolved from area + category). A tableId from the player is ignored.
    findId: body.findId, userId, passed: body.passed === true
  });
  // Only 'stale' is left: a table that went empty or archived closes the find as failed (a normal
  // result), so a player is never shown table errors or stuck on an unmarked check.
  if (!marked.ok) return err(marked.error, 409);

  const result = marked.result;
  const itemCount = forageItemCount(result.lines.map((line) => ({ itemId: line.itemId, qty: line.qty })));
  if (result.status === 'found') emitRealtimeEvent('character:updated', { characterId: result.characterId });

  // Public roll-log line (no item names), only if the forage's room is live.
  const name = await characterName(result.characterId);
  await logForageRoll(
    result.roomCode,
    rollLogMessage({ characterName: name, check: result.check, outcome: result.status, mode: 'self', itemCount }),
    forageLogDetails({ check: result.check, outcome: result.status, mode: 'self', itemCount, findId: body.findId })
  );
  // Open Session Notes views refetch (a detail-free nudge, the list itself is fetched per viewer).
  publishFindChanged(result.gameSessionId, body.findId);
  if (result.roomCode && sessions.has(result.roomCode)) forageNudge(result.roomCode, userId);
  return json({ status: result.status, lines: result.lines, check: result.check });
}

async function characterName(characterId: string): Promise<string> {
  const row = await query<{ name: string }>('SELECT name FROM characters WHERE id = $1', [characterId]);
  return row.rows[0]?.name ?? 'Someone';
}

// The finder withdraws a DM-mode request, if canWithdraw allows it.
function withdrawAction(userId: string, body: any) {
  const pending = findPendingForUser(userId);
  if (!pending || pending.request.id !== body?.requestId) return err('stale_request', 409);
  if (!canWithdraw(pending.session, pending.request)) return err('cannot_withdraw', 409);
  closeRequest(pending.session, pending.request, 'cancelled', {}, false);
  return json({ ok: true });
}

// The finder dismisses their last DM-mode result (clears it from the room).
function dismissAction(userId: string, body: any) {
  for (const session of sessions.values()) {
    const result = session.forageResults?.[userId];
    if (result && result.requestId === body?.requestId) {
      delete session.forageResults[userId];
      forageNudge(session.id, userId);
      return json({ ok: true });
    }
  }
  return json({ ok: true });
}
